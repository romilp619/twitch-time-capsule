let demoData;
let demoBusy = false;
let demoLoading = false;
let demoConnectionError = false;
const byId = (id) => document.getElementById(id);
function localUrl(value) {
  const url = new URL(value, location.href);
  if (url.origin !== location.origin)
    throw new Error('Demo links must stay on this local server.');
  return url.href;
}
function frameUrl(id, url) {
  const frame = byId(id);
  const safe = localUrl(url);
  if (frame.src !== safe) frame.src = safe;
}
function node(tag, text) {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}
function renderDemo(data) {
  demoData = data;
  const running = data.state === 'running';
  byId('story-state').textContent = data.state.toUpperCase();
  byId('story-headline').textContent = data.headline;
  const seconds = Math.floor(data.elapsedMs / 1000);
  byId('story-time').textContent =
    Math.floor(seconds / 60) +
    ':' +
    String(seconds % 60).padStart(2, '0') +
    ' / 1:30';
  byId('story-progress').value = data.elapsedMs;
  byId('live-badge').textContent = data.facts.live
    ? 'LIVE - SIMULATED'
    : 'OFFLINE';
  byId('game-category').textContent = data.facts.category;
  byId('demo-count').textContent = String(data.capsule?.sealedCount ?? 0);
  byId('capsule-state').textContent =
    data.capsule?.status.toUpperCase() ?? 'WAITING';
  byId('vip-count').textContent = String(data.vipCount);
  byId('play-story').disabled = demoBusy || running;
  byId('stop-story').disabled = demoBusy || !running;
  byId('demo-scenario').disabled = demoBusy || running;
  const active = ['queue', 'reveal', 'prophet'].includes(data.ceremony);
  for (const button of document.querySelectorAll('[data-action]')) {
    const action = button.dataset.action;
    button.disabled =
      demoBusy ||
      running ||
      (action === 'seals' &&
        (data.capsule?.status !== 'sealing' ||
          data.capsule?.sealedCount >= 20)) ||
      (action === 'date' && data.scenario !== 'date') ||
      (['approve', 'reveal', 'prophet', 'end'].includes(action) && !active);
  }
  byId('demo-hint').textContent = running
    ? 'The story is playing. Stop at any time to explore the controls.'
    : data.state === 'completed'
      ? 'Story complete. The overlay is empty again. Open the public capsule to see the Wall of Prophets.'
      : data.capsule?.status === 'ready'
        ? 'The condition is ready. Go live to start the opening delay.'
        : active
          ? 'Approve messages, reveal them, then mark a prediction Came true.'
          : 'Send sample seals, then go live and meet the chosen opening condition.';
  frameUrl('demo-overlay', data.links.overlay);
  frameUrl('demo-dashboard', data.links.dashboard);
  byId('open-dashboard').href = localUrl(data.links.dashboard);
  if (data.links.public) {
    byId('demo-public').href = localUrl(data.links.public);
    byId('demo-public').hidden = false;
  }
  const chat = byId('demo-chat');
  const signature = JSON.stringify(data.messages);
  if (chat.dataset.signature !== signature) {
    chat.dataset.signature = signature;
    chat.replaceChildren();
    for (const message of data.messages.slice().reverse()) {
      const row = document.createElement('li');
      row.append(node('strong', 'Capsule keeper'), node('span', message.text));
      chat.append(row);
    }
    if (!data.messages.length)
      chat.append(node('li', 'Waiting for the first sample message...'));
  }
  if (data.error) byId('demo-feedback').textContent = data.error;
}
async function loadDemo() {
  if (demoLoading || demoBusy) return;
  demoLoading = true;
  try {
    const response = await fetch('/api/demo', { cache: 'no-store' });
    if (!response.ok) throw new Error('Unable to load the demo.');
    renderDemo(await response.json());
    if (demoConnectionError) byId('demo-feedback').textContent = '';
    demoConnectionError = false;
  } catch (error) {
    demoConnectionError = true;
    byId('demo-feedback').textContent =
      error instanceof Error ? error.message : 'The demo connection was lost.';
  } finally {
    demoLoading = false;
  }
}
async function demoAction(action) {
  if (demoBusy || !demoData) return;
  demoBusy = true;
  renderDemo(demoData);
  byId('demo-feedback').textContent = '';
  try {
    const response = await fetch('/api/demo/action', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': demoData.adminKey,
      },
      body: JSON.stringify({
        action,
        ...(action === 'new' ? { scenario: byId('demo-scenario').value } : {}),
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The demo action failed.');
    demoData = data;
  } catch (error) {
    byId('demo-feedback').textContent =
      error instanceof Error ? error.message : 'Unable to update the demo.';
  } finally {
    demoBusy = false;
    renderDemo(demoData);
  }
}
for (const button of document.querySelectorAll('[data-action]'))
  button.addEventListener('click', () => {
    void demoAction(button.dataset.action);
  });
byId('play-story').addEventListener('click', () => {
  void demoAction('story');
});
byId('stop-story').addEventListener('click', () => {
  void demoAction('stop');
});
const gameFrame = document.querySelector('.game-frame');
const resize = new globalThis.ResizeObserver(() => {
  byId('demo-overlay').style.transform =
    'scale(' + gameFrame.clientWidth / 1920 + ')';
});
resize.observe(gameFrame);
void loadDemo();
setInterval(() => {
  void loadDemo();
}, 1000);
