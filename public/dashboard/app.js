const key = new URLSearchParams(location.search).get('key') || '';
const feedback = document.getElementById('feedback');
let busy = false;
let currentState;
const notices = {
  connected: 'Twitch account connected. Connection checks are complete.',
  denied:
    'Twitch authorization was cancelled. You can connect again whenever you are ready.',
  failed:
    'The account could not be connected. Check the warning below, then try again.',
};
const notice = new URLSearchParams(location.search).get('notice');
function banner(parent, message, type = '') {
  const item = document.createElement('div');
  item.className = 'banner ' + type;
  item.textContent = message;
  parent.append(item);
}
if (notice && notices[notice]) {
  banner(feedback, notices[notice], notice === 'connected' ? 'success' : '');
  const clean = new URL(location.href);
  clean.searchParams.delete('notice');
  history.replaceState(null, '', clean);
}
async function api(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    headers: {
      'x-admin-key': key,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || 'The request failed. Please try again.');
  return data;
}
function render(state) {
  currentState = state;
  const warnings = document.getElementById('warnings');
  warnings.replaceChildren();
  for (const warning of state.warnings) banner(warnings, warning);
  if (state.moderator.state === 'no' || state.moderator.state === 'error')
    banner(warnings, state.moderator.message, 'danger');
  for (const role of ['streamer', 'bot']) {
    const account = state[role];
    const isFallback = role === 'bot' && state.singleAccount;
    const status = document.getElementById(role + '-status');
    status.textContent = isFallback ? 'OPTIONAL' : account.status.toUpperCase();
    status.className = 'badge ' + account.status;
    document.getElementById(role + '-name').textContent =
      account.displayName ||
      (isFallback ? 'Single-account mode' : 'Not connected');
    document.getElementById(role + '-login').textContent = account.login
      ? '@' + account.login
      : isFallback
        ? 'Uses your streamer account'
        : 'Connect to get started';
    document.getElementById(role + '-error').textContent = account.error || '';
    document.getElementById(role + '-expiry').textContent = account.expiresAt
      ? 'Token expires ' + new Date(account.expiresAt).toLocaleString()
      : '';
    document.getElementById(role + '-validation').textContent =
      account.validatedAt
        ? 'Last validated ' + new Date(account.validatedAt).toLocaleString()
        : 'Tokens are validated at startup and every hour.';
    const list = document.getElementById(role + '-scopes');
    list.replaceChildren();
    for (const scope of account.scopes) {
      const item = document.createElement('span');
      item.className = 'scope';
      item.textContent = scope;
      list.append(item);
    }
    document.querySelector('[data-connect="' + role + '"]').disabled =
      !state.configured || busy;
    document.querySelector('[data-disconnect="' + role + '"]').hidden =
      !account.userId;
    document.querySelector('[data-disconnect="' + role + '"]').disabled = busy;
  }
  document.getElementById('live-status').textContent =
    state.live === null
      ? 'Waiting for channel'
      : state.live
        ? 'Live now'
        : 'Offline';
  document.getElementById('mod-status').textContent =
    state.moderator.state === 'yes'
      ? 'Ready to moderate'
      : state.moderator.state === 'no'
        ? 'Bot needs moderator role'
        : 'Not checked';
  document.getElementById('checked-at').textContent = state.checkedAt
    ? 'Last checked ' + new Date(state.checkedAt).toLocaleString()
    : '';
  document.getElementById('refresh').disabled = busy || state.refreshing;
}
async function act(work) {
  if (busy) return;
  busy = true;
  feedback.replaceChildren();
  if (currentState) render(currentState);
  try {
    await work();
  } catch (error) {
    banner(
      feedback,
      error instanceof Error ? error.message : 'Connection failed. Try again.',
      'danger',
    );
  } finally {
    busy = false;
    if (currentState) render(currentState);
  }
}
for (const button of document.querySelectorAll('[data-connect]'))
  button.addEventListener('click', () => {
    void act(async () => {
      const result = await api('/api/auth/start', 'POST', {
        role: button.dataset.connect,
      });
      location.assign(result.url);
    });
  });
for (const button of document.querySelectorAll('[data-disconnect]'))
  button.addEventListener('click', () => {
    void act(async () => {
      render(
        await api('/api/auth/disconnect', 'POST', {
          role: button.dataset.disconnect,
        }),
      );
    });
  });
document.getElementById('refresh').addEventListener('click', () => {
  void act(async () => {
    render(await api('/api/connection/refresh', 'POST'));
  });
});
async function poll() {
  if (busy) return;
  try {
    render(await api('/api/connection'));
  } catch (error) {
    feedback.replaceChildren();
    banner(
      feedback,
      error instanceof Error ? error.message : 'Cannot load connection status.',
      'danger',
    );
  }
}
void poll();
setInterval(() => {
  void poll();
}, 15_000);
