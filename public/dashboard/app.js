let dashboardSocket;
let retryTimer;
let retryAttempt = 0;
let dashboardClosed = false;
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
  globalThis.updateWorkspace?.({ connection: state });
  renderEventSub(state.eventsub);
  currentState = state;
  globalThis.capsuleConnectionState = state;
  globalThis.setCapsuleConnection?.(state);
  const warnings = document.getElementById('warnings');
  warnings.replaceChildren();
  for (const warning of [
    ...state.warnings,
    ...(state.eventsub?.warnings ?? []),
  ])
    banner(warnings, warning);
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
    const connectLink = document.querySelector('[data-connect="' + role + '"]');
    const connected = !isFallback && account.status === 'connected';
    document.getElementById(role + '-connected').hidden = !connected;
    connectLink.textContent = connected
      ? 'Reconnect ↗'
      : 'Connect ' + role + ' account ↗';
    connectLink.setAttribute(
      'aria-label',
      (connected ? 'Reconnect ' : 'Connect ') + role + ' account',
    );
    connectLink.className = connected
      ? 'quiet action-link reconnect-link'
      : (role === 'streamer' ? 'primary' : 'secondary') + ' action-link';
    const unavailable = !state.configured || busy;
    connectLink.setAttribute('aria-disabled', String(unavailable));
    if (unavailable) connectLink.removeAttribute('href');
    else
      connectLink.href = '/auth/connect?' + new URLSearchParams({ role, key });
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
  if (busy || dashboardSocket?.readyState === 1) return;
  try {
    const [state, events, capsuleData] = await Promise.all([
      api('/api/connection'),
      api('/api/events'),
      api('/api/capsules'),
    ]);
    render(state);
    renderEvents(events);
    globalThis.renderCapsules?.(capsuleData.capsules);
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

function renderEventSub(eventsub) {
  document.getElementById('eventsub-status').textContent =
    eventsub?.status === 'simulated'
      ? 'Simulated (demo)'
      : eventsub?.status === 'connected'
        ? 'Connected'
        : eventsub?.status === 'degraded'
          ? 'Needs attention'
          : eventsub?.status === 'connecting'
            ? 'Connecting...'
            : 'Not connected';
  const list = document.getElementById('subscription-list');
  list.replaceChildren();
  for (const connection of eventsub?.connections ?? []) {
    const heading = document.createElement('p');
    heading.className = 'metadata';
    heading.textContent =
      connection.role +
      ' connection: ' +
      connection.status +
      ' | Last keepalive: ' +
      (connection.lastKeepalive
        ? new Date(connection.lastKeepalive).toLocaleTimeString()
        : 'waiting');
    list.append(heading);
    for (const subscription of connection.subscriptions) {
      const item = document.createElement('p');
      item.className = 'subscription-row ' + subscription.status;
      item.textContent =
        subscription.type +
        ' v' +
        subscription.version +
        ' - ' +
        subscription.status;
      list.append(item);
    }
  }
  if (!eventsub?.connections?.length) {
    const item = document.createElement('p');
    item.className = 'metadata';
    item.textContent =
      eventsub?.status === 'simulated'
        ? 'Demo controls supply simulated events. No real Twitch EventSub connection is used.'
        : 'Connect a streamer account to start receiving events.';
    list.append(item);
  }
}
function renderEvents(events) {
  const list = document.getElementById('events-log');
  list.replaceChildren();
  for (const event of events) {
    const row = document.createElement('li');
    const heading = document.createElement('div');
    heading.className = 'event-heading';
    const type = document.createElement('strong');
    type.textContent = event.type;
    const at = document.createElement('time');
    at.textContent = new Date(event.at).toLocaleTimeString();
    heading.append(type, at);
    const body = document.createElement('p');
    body.textContent = JSON.stringify(event.payload);
    row.append(heading, body);
    list.append(row);
  }
  if (!events.length) {
    const row = document.createElement('li');
    row.textContent =
      'Waiting for Twitch events. New chat messages will appear here.';
    list.append(row);
  }
}
function connectDashboard() {
  if (dashboardClosed) return;
  const url = new URL('/ws/dashboard', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('key', key);
  const socket = new WebSocket(url);
  dashboardSocket = socket;
  socket.onopen = () => {
    retryAttempt = 0;
    document.getElementById('dashboard-updates').textContent =
      'Live dashboard updates connected';
    if (!notice) feedback.replaceChildren();
  };
  socket.onmessage = (event) => {
    try {
      const packet = JSON.parse(event.data);
      if (
        packet.type !== 'snapshot' ||
        !packet.connection ||
        !Array.isArray(packet.events)
      )
        return;
      render(packet.connection);
      renderEvents(packet.events);
      globalThis.renderCapsules?.(packet.capsules ?? []);
      globalThis.ceremonySnapshot = packet.ceremony;
      globalThis.renderCeremony?.(packet.ceremony);
    } catch {
      document.getElementById('dashboard-updates').textContent =
        'Could not read an update. Reconnecting...';
      socket.close();
    }
  };
  socket.onerror = () => {
    document.getElementById('dashboard-updates').textContent =
      'Dashboard connection interrupted';
  };
  socket.onclose = () => {
    if (dashboardClosed || dashboardSocket !== socket) return;
    document.getElementById('dashboard-updates').textContent =
      'Reconnecting dashboard updates...';
    retryTimer = setTimeout(
      connectDashboard,
      Math.min(30000, 1000 * 2 ** Math.min(retryAttempt++, 5)),
    );
  };
}
if (typeof WebSocket === 'function') {
  connectDashboard();
  addEventListener('pagehide', () => {
    dashboardClosed = true;
    clearTimeout(retryTimer);
    dashboardSocket?.close();
  });
}
