const prophetKey = new URLSearchParams(location.search).get('key') || '';
let prophetOffset = 0;
let prophetTotal = 0;
let prophetBusy = false;
let prophetLoading = false;
let prophetSignature = '';
function prophetNode(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function prophetMessage(text, error = false) {
  const element = document.getElementById('prophets-feedback');
  element.textContent = text;
  element.className = text ? 'banner ' + (error ? 'danger' : 'success') : '';
}
async function prophetApi(path, method = 'GET') {
  const response = await fetch(path, {
    method,
    cache: 'no-store',
    headers: { 'x-admin-key': prophetKey },
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || 'The Prophet request failed.');
  return result;
}
function prophetButton(text, action, primary = false) {
  const button = prophetNode('button', primary ? 'primary' : 'secondary', text);
  button.type = 'button';
  button.disabled = prophetBusy;
  button.addEventListener('click', () => {
    void prophetAction(action);
  });
  return button;
}
async function prophetAction(action) {
  if (prophetBusy) return;
  prophetBusy = true;
  for (const button of document
    .getElementById('prophets-list')
    .querySelectorAll('button'))
    button.disabled = true;
  try {
    await prophetApi(action, 'POST');
    prophetMessage('Saved. Check the reward and chat status below.');
  } catch (error) {
    prophetMessage(
      error instanceof Error ? error.message : 'Unable to save this reward.',
      true,
    );
  } finally {
    prophetBusy = false;
    prophetSignature = '';
    await refreshProphets();
  }
}
function renderProphets(data) {
  prophetTotal = data.total;
  const list = document.getElementById('prophets-list');
  list.replaceChildren();
  for (const seal of data.seals) {
    const row = prophetNode('article', 'mod-message');
    const heading = prophetNode('div', 'mod-heading');
    heading.append(
      prophetNode('strong', '', '@' + seal.displayName),
      prophetNode(
        'span',
        'badge',
        seal.cameTrue ? 'PROPHET · CAME TRUE' : 'REVEALED',
      ),
    );
    row.append(
      heading,
      prophetNode('p', 'metadata', seal.title + ' · #' + seal.number),
      prophetNode('blockquote', '', seal.text),
    );
    const actions = prophetNode('div', 'actions');
    const base = '/api/prophets/seals/' + seal.id + '/';
    if (!seal.cameTrue) {
      actions.append(
        prophetButton('Came true · #' + seal.number, base + 'came-true', true),
      );
      row.append(
        prophetNode(
          'p',
          'metadata',
          seal.vipEnabled
            ? 'Includes a VIP reward if Twitch permits it.'
            : 'Prophet recognition · VIP reward is off.',
        ),
      );
    } else {
      const labels = {
        off: 'Prophet recognition · VIP reward is off.',
        pending: 'Checking VIP reward…',
        granted: 'VIP granted by this app.',
        existing: 'Existing VIP preserved · this app will not expire it.',
        error: 'VIP could not be granted.',
        uncertain: 'VIP result needs review in Twitch.',
        expired: 'VIP reward expired. Prophet recognition is permanent.',
      };
      row.append(
        prophetNode(
          'p',
          'metadata',
          labels[seal.vipStatus] || 'Reward status unavailable.',
        ),
      );
      if (seal.vipExpiresAt)
        row.append(
          prophetNode(
            'p',
            'metadata',
            'VIP expiry: ' + new Date(seal.vipExpiresAt).toLocaleString(),
          ),
        );
      if (seal.vipError)
        row.append(
          prophetNode(
            'p',
            seal.vipStatus === 'existing' ? 'metadata' : 'banner danger',
            seal.vipError,
          ),
        );
      if (seal.vipRetryable)
        actions.append(
          prophetButton('Retry VIP · #' + seal.number, base + 'retry-vip'),
        );
      row.append(
        prophetNode(
          'p',
          'metadata',
          seal.chatAnnounced
            ? 'Prophet announcement sent to chat.'
            : 'Chat announcement has not been confirmed.',
        ),
      );
      if (seal.chatError) {
        row.append(prophetNode('p', 'banner danger', seal.chatError));
        actions.append(
          prophetButton(
            'Retry announcement · #' + seal.number,
            base + 'retry-chat',
          ),
        );
      }
    }
    row.append(actions);
    list.append(row);
  }
  if (!data.seals.length)
    list.append(
      prophetNode(
        'p',
        'muted',
        'Reveal an approved message during a ceremony. It will appear here with a Came true button.',
      ),
    );
  const warnings = document.getElementById('prophets-warnings');
  warnings.replaceChildren();
  for (const message of data.warnings)
    warnings.append(prophetNode('p', 'banner danger', message));
  document.getElementById('prophets-page').textContent = data.total
    ? prophetOffset +
      1 +
      '–' +
      Math.min(prophetOffset + 50, data.total) +
      ' of ' +
      data.total
    : '0 revealed predictions';
  document.getElementById('prophets-prev').disabled = prophetOffset === 0;
  document.getElementById('prophets-next').disabled =
    prophetOffset + 50 >= data.total;
}
async function refreshProphets() {
  if (prophetLoading || prophetBusy) return;
  prophetLoading = true;
  try {
    const data = await prophetApi('/api/prophets?offset=' + prophetOffset);
    const signature = JSON.stringify(data);
    if (signature !== prophetSignature) {
      prophetSignature = signature;
      renderProphets(data);
    }
  } catch (error) {
    prophetMessage(
      error instanceof Error ? error.message : 'Unable to load Prophets.',
      true,
    );
  } finally {
    prophetLoading = false;
  }
}
document.getElementById('prophets-refresh').addEventListener('click', () => {
  void refreshProphets();
});
document.getElementById('prophets-expiry').addEventListener('click', () => {
  void prophetAction('/api/prophets/expiry');
});
document.getElementById('prophets-prev').addEventListener('click', () => {
  prophetOffset = Math.max(0, prophetOffset - 50);
  void refreshProphets();
});
document.getElementById('prophets-next').addEventListener('click', () => {
  if (prophetOffset + 50 < prophetTotal) prophetOffset += 50;
  void refreshProphets();
});
void refreshProphets();
setInterval(() => {
  void refreshProphets();
}, 5000);
