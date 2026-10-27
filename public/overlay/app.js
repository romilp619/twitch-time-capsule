const overlayKey = new URLSearchParams(location.search).get('key') || '';
const stage = document.getElementById('stage');
let overlaySocket;
let overlayStopped = false;
let overlayAttempt = 0;
let overlayRetry;
let overlayFade;
let overlaySignature = '';
let overlayMode = '';
let overlayCards = new Map();
function overlayElement(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}
function clearOverlay() {
  overlaySignature = '';
  overlayMode = '';
  overlayCards.clear();
  stage.replaceChildren();
  stage.className = '';
}
function renderOverlay(packet) {
  if (!packet || packet.type !== 'ceremony') return;
  const signature = JSON.stringify(packet);
  if (signature === overlaySignature) return;
  overlaySignature = signature;
  clearTimeout(overlayFade);
  if (packet.stage === 'idle') {
    if (!stage.children.length) {
      clearOverlay();
      return;
    }
    stage.classList.add('ending');
    overlayFade = setTimeout(clearOverlay, 600);
    return;
  }
  const settings = packet.settings || {};
  const classes =
    (settings.side === 'left' ? 'side-left' : 'side-right') +
    ' ' +
    (settings.cardScale === 0.85
      ? 'scale-small'
      : settings.cardScale === 1.15
        ? 'scale-large'
        : 'scale-medium');
  stage.className = classes;
  const identity = String(packet.capsuleId) + ':' + packet.startedAt;
  if (packet.stage === 'opening') {
    if (overlayMode === identity + ':opening') return;
    stage.replaceChildren();
    overlayCards.clear();
    overlayMode = identity + ':opening';
    const hero = overlayElement('section', 'hero');
    const glow = overlayElement('div', 'glow');
    glow.setAttribute('aria-hidden', 'true');
    const art = overlayElement('div', 'capsule-art');
    art.setAttribute('aria-hidden', 'true');
    art.append(
      overlayElement('div', 'half top'),
      overlayElement('div', 'half bottom'),
    );
    hero.append(
      glow,
      art,
      overlayElement(
        'p',
        'hero-kicker',
        packet.preview ? 'PREVIEW · TIME CAPSULE' : 'SEALED THEN. OPENED NOW.',
      ),
      overlayElement('h1', '', 'TIME CAPSULE OPENED'),
      overlayElement(
        'p',
        'hero-detail',
        String(packet.sealedCount) +
          ' messages sealed since ' +
          dateLabel(packet.createdAt),
      ),
    );
    stage.append(hero);
    return;
  }
  if (!['queue', 'reveal'].includes(packet.stage)) {
    clearOverlay();
    return;
  }
  if (overlayMode !== identity + ':rail') {
    stage.replaceChildren();
    overlayCards.clear();
    overlayMode = identity + ':rail';
    const rail = overlayElement('section', 'rail');
    const header = overlayElement('header', 'rail-header');
    header.append(
      overlayElement(
        'p',
        'rail-kicker',
        packet.preview
          ? 'PREVIEW · TIME CAPSULE · OPENED'
          : 'TIME CAPSULE · OPENED',
      ),
      overlayElement('p', 'rail-title', packet.title),
    );
    rail.append(header, overlayElement('div', 'cards'));
    stage.append(rail);
  }
  const container = stage.querySelector('.cards');
  const cards = Array.isArray(packet.cards) ? packet.cards.slice(-3) : [];
  const wanted = new Set(cards.map((card) => card.id));
  for (const [id, element] of overlayCards) {
    if (!wanted.has(id)) {
      element.classList.add('leaving');
      setTimeout(() => element.remove(), 400);
      overlayCards.delete(id);
    }
  }
  for (const card of cards) {
    if (overlayCards.has(card.id)) continue;
    const element = overlayElement('article', 'reveal-card');
    element.append(
      overlayElement('p', 'card-name', '@' + card.displayName),
      overlayElement(
        'p',
        'card-date',
        'SEALED ' + dateLabel(card.createdAt) + ' · #' + card.number,
      ),
      overlayElement('blockquote', '', card.text),
    );
    container.append(element);
    overlayCards.set(card.id, element);
  }
}
function connectOverlay() {
  if (overlayStopped) return;
  const url = new URL('/ws/overlay', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('key', overlayKey);
  const socket = new WebSocket(url);
  overlaySocket = socket;
  socket.onopen = () => {
    overlayAttempt = 0;
  };
  socket.onmessage = (event) => {
    try {
      renderOverlay(JSON.parse(event.data));
    } catch {
      socket.close();
    }
  };
  socket.onerror = () => {};
  socket.onclose = () => {
    if (overlayStopped || overlaySocket !== socket) return;
    clearOverlay();
    overlayRetry = setTimeout(
      connectOverlay,
      Math.min(30_000, 1000 * 2 ** Math.min(overlayAttempt++, 5)),
    );
  };
}
async function pollOverlay() {
  if (overlayStopped || overlaySocket?.readyState === 1) return;
  try {
    const url = new URL('/api/overlay/state', location.href);
    url.searchParams.set('key', overlayKey);
    const response = await fetch(url, { cache: 'no-store' });
    if (response.ok) renderOverlay(await response.json());
    else clearOverlay();
  } catch {
    clearOverlay();
  }
}
connectOverlay();
void pollOverlay();
setInterval(() => {
  void pollOverlay();
}, 5000);
addEventListener('pagehide', () => {
  overlayStopped = true;
  clearTimeout(overlayRetry);
  clearTimeout(overlayFade);
  overlaySocket?.close();
});
