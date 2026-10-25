const capsuleKey = new URLSearchParams(location.search).get('key') || '';
let capsuleBusy = false;
let capsuleConnected = false;
let openingFacts = null;
let capsuleList = [];
let selectedCategory = null;
let searchTimer;
let searchVersion = 0;
const capsuleForm = document.getElementById('capsule-form');
const capsuleFeedback = document.getElementById('capsule-feedback');
function capsuleMessage(message, failure = false) {
  capsuleFeedback.textContent = message;
  capsuleFeedback.className = message
    ? 'banner ' + (failure ? 'danger' : 'success')
    : '';
}
async function capsuleApi(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    headers: {
      'x-admin-key': capsuleKey,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || 'The capsule request failed.');
  return data;
}
function updateCapsuleButton() {
  const active = capsuleList.some((capsule) => capsule.status === 'sealing');
  document.getElementById('create-capsule').disabled =
    capsuleBusy || !capsuleConnected || active;
  document.getElementById('capsule-form-note').textContent = !capsuleConnected
    ? 'Connect the streamer account to create a capsule.'
    : active
      ? 'Lock or archive the current sealing capsule before creating another.'
      : 'One capsule can accept seals at a time. All openings wait for a live stream.';
}
globalThis.setCapsuleConnection = (state) => {
  capsuleConnected = state.streamer.status === 'connected';
  openingFacts = state.triggers ?? null;
  renderCapsules(capsuleList);
  updateCapsuleButton();
};
function updateTriggerFields() {
  const type = document.getElementById('capsule-trigger').value;
  for (const field of ['date', 'followers', 'category']) {
    const container = document.getElementById('trigger-' + field);
    container.hidden = field !== type;
    for (const input of container.querySelectorAll('input'))
      input.disabled = field !== type;
  }
}
function capsuleCondition(capsule) {
  if (capsule.triggerType === 'manual') return 'Opens when you choose';
  if (capsule.triggerType === 'date')
    return 'Opens ' + new Date(capsule.triggerValue).toLocaleString();
  if (capsule.triggerType === 'followers')
    return 'Opens at ' + capsule.triggerValue.toLocaleString() + ' followers';
  return 'Opens on first stream in ' + capsule.triggerValue.category_name;
}
function renderCapsules(capsules) {
  capsuleList = capsules;
  const list = document.getElementById('capsule-list');
  list.replaceChildren();
  if (openingFacts) {
    const facts = document.createElement('p');
    facts.className = 'muted';
    facts.textContent =
      'Opening checks: ' +
      (openingFacts.live === true
        ? 'Live'
        : openingFacts.live === false
          ? 'Offline'
          : 'Live status unknown') +
      ' · Followers: ' +
      (openingFacts.followers === null
        ? 'unknown'
        : openingFacts.followers.toLocaleString()) +
      ' · Category: ' +
      (openingFacts.categoryName ||
        (openingFacts.categoryId === '' ? 'None set' : 'unknown'));
    list.append(facts);
    for (const message of openingFacts.warnings ?? []) {
      const warning = document.createElement('p');
      warning.className = 'banner danger';
      warning.textContent = message;
      list.append(warning);
    }
  }
  for (const capsule of capsules) {
    const card = document.createElement('article');
    card.className = 'capsule-card';
    const top = document.createElement('div');
    top.className = 'capsule-card-top';
    const title = document.createElement('h3');
    title.textContent = capsule.title;
    const status = document.createElement('span');
    status.className =
      'badge ' + (capsule.status === 'sealing' ? 'connected' : '');
    status.textContent = capsule.status.toUpperCase();
    top.append(title, status);
    const condition = document.createElement('p');
    condition.className = 'muted';
    condition.textContent = capsuleCondition(capsule);
    const count = document.createElement('p');
    count.className = 'capsule-count';
    count.textContent = capsule.sealedCount + ' sealed messages';
    const owner = document.createElement('p');
    owner.className = 'metadata';
    owner.textContent =
      '@' +
      capsule.channel.login +
      ' | Created ' +
      new Date(capsule.createdAt).toLocaleString();
    const actions = document.createElement('div');
    actions.className = 'actions';
    const link = document.createElement('a');
    link.className = 'public-link';
    link.href = '/c/' + capsule.slug;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'View public page';
    actions.append(link);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'secondary';
    copy.textContent = 'Copy public link';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(
          new URL(link.href, location.href).toString(),
        );
        capsuleMessage('Public link copied.');
      } catch {
        capsuleMessage('Open the public page and copy its address.', true);
      }
    });
    actions.append(copy);
    for (const action of ['open', 'postpone', 'lock', 'archive']) {
      if (
        ['open', 'postpone'].includes(action) &&
        !['sealing', 'locked', 'ready'].includes(capsule.status)
      )
        continue;
      if (action === 'lock' && capsule.status !== 'sealing') continue;
      if (
        action === 'archive' &&
        !['sealing', 'locked', 'ready', 'opened'].includes(capsule.status)
      )
        continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = action === 'open' ? 'primary open-now' : 'secondary';
      button.textContent = {
        open: 'Open now',
        postpone: 'Postpone 10 min',
        lock: 'Lock sealing',
        archive: 'Archive',
      }[action];
      button.disabled = capsuleBusy;
      button.addEventListener('click', () => {
        void capsuleAction(async () => {
          const result = await capsuleApi(
            '/api/capsules/' + capsule.id + '/' + action,
            'POST',
          );
          await refreshCapsules();
          capsuleMessage(
            action === 'open'
              ? result.capsule.openingDueAt
                ? 'Capsule ready. Opening in 5 seconds while live.'
                : 'Capsule ready. Waiting for the next live stream.'
              : action === 'postpone'
                ? 'Opening postponed for 10 minutes. Seals and the opening condition are preserved.'
                : action === 'lock'
                  ? 'Capsule locked. Existing seals are preserved.'
                  : 'Capsule archived. Existing seals are preserved.',
          );
        });
      });
      actions.append(button);
    }
    card.append(top, condition, count, owner);
    const timing = document.createElement('p');
    timing.className = 'opening-timing';
    timing.textContent =
      capsule.status === 'opening'
        ? 'Opening started. The animation and message reveal controls arrive in Phase 6.'
        : capsule.postponedUntil &&
            Date.parse(capsule.postponedUntil) > Date.now()
          ? 'Postponed until ' +
            new Date(capsule.postponedUntil).toLocaleString() +
            '. Opening also requires a live stream.'
          : capsule.status === 'ready'
            ? capsule.openingDueAt
              ? 'Scheduled to open at ' +
                new Date(capsule.openingDueAt).toLocaleTimeString() +
                '. Postpone to delay.'
              : 'Ready. Waiting for a live stream, then the configured settling-in delay.'
            : 'Open now overrides the condition. Postpone delays opening by 10 minutes. Both keep the live-stream requirement.';
    card.append(timing);
    if (capsule.visibleCount > 0) {
      const warning = document.createElement('p');
      warning.className = 'visible-warning';
      warning.textContent =
        capsule.visibleCount +
        ' message(s) not hidden in chat. Moderator/streamer messages cannot be hidden; other deletion failures appear in the activity log.';
      card.append(warning);
    }
    card.append(actions);
    list.append(card);
  }
  if (!capsules.length) {
    const empty = document.createElement('p');
    empty.className = 'muted empty-capsules';
    empty.textContent =
      'Your first capsule starts here. Choose a title and let chat send a message to the future.';
    list.append(empty);
  }
  updateCapsuleButton();
}
globalThis.renderCapsules = renderCapsules;
async function refreshCapsules() {
  renderCapsules((await capsuleApi('/api/capsules')).capsules);
}
async function capsuleAction(work) {
  if (capsuleBusy) return;
  capsuleBusy = true;
  updateCapsuleButton();
  try {
    await work();
  } catch (error) {
    capsuleMessage(
      error instanceof Error ? error.message : 'The capsule request failed.',
      true,
    );
  } finally {
    capsuleBusy = false;
    renderCapsules(capsuleList);
  }
}
capsuleForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void capsuleAction(async () => {
    const type = document.getElementById('capsule-trigger').value;
    let value = null;
    if (type === 'date')
      value = new Date(
        document.getElementById('capsule-date').value,
      ).toISOString();
    if (type === 'followers')
      value = Number(document.getElementById('capsule-followers').value);
    if (type === 'category') {
      if (!selectedCategory)
        throw new Error('Search and select a Twitch category first.');
      value = {
        category_id: selectedCategory.id,
        category_name: selectedCategory.name,
      };
    }
    const body = {
      title: document.getElementById('capsule-title').value,
      triggerType: type,
      triggerValue: value,
      settings: {
        max_seals_per_user: Number(
          document.getElementById('capsule-limit').value,
        ),
        max_length: Number(document.getElementById('capsule-length').value),
        vip_reward: document.getElementById('capsule-vip').checked,
        vip_days: Number(document.getElementById('capsule-vip-days').value),
      },
    };
    await capsuleApi('/api/capsules', 'POST', body);
    capsuleForm.reset();
    selectedCategory = null;
    document.getElementById('category-results').replaceChildren();
    updateTriggerFields();
    await refreshCapsules();
    capsuleMessage(
      'Capsule created. Viewers can now send !seal followed by their message.',
    );
  });
});
document
  .getElementById('capsule-trigger')
  .addEventListener('change', updateTriggerFields);
document.getElementById('category-query').addEventListener('input', () => {
  selectedCategory = null;
  clearTimeout(searchTimer);
  const version = ++searchVersion;
  const query = document.getElementById('category-query').value.trim();
  const results = document.getElementById('category-results');
  results.replaceChildren();
  if (query.length < 2) return;
  searchTimer = setTimeout(async () => {
    try {
      const data = await capsuleApi(
        '/api/categories?query=' + encodeURIComponent(query),
      );
      if (version !== searchVersion) return;
      for (const category of data.categories) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'category-result';
        button.textContent = category.name + ' (ID ' + category.id + ')';
        button.addEventListener('click', () => {
          selectedCategory = category;
          document.getElementById('category-query').value = category.name;
          results.replaceChildren();
        });
        results.append(button);
      }
      if (!data.categories.length)
        results.textContent = 'No matching categories.';
    } catch (error) {
      if (version === searchVersion)
        results.textContent =
          error instanceof Error ? error.message : 'Category search failed.';
    }
  }, 350);
});
updateTriggerFields();
if (globalThis.capsuleConnectionState)
  globalThis.setCapsuleConnection(globalThis.capsuleConnectionState);
void refreshCapsules().catch((error) =>
  capsuleMessage(
    error instanceof Error ? error.message : 'Cannot load capsules.',
    true,
  ),
);
