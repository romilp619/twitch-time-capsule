let publicCapsule;
let wallOffset = 0;
let wallTotal = 0;
let wallSearch = '';
let wallVersion = 0;
let wallLoading = false;
let wallSearchTimer;
const publicSlug = location.pathname.split('/').filter(Boolean).at(-1);
function updateCountdown() {
  const element = document.getElementById('date-countdown');
  if (!publicCapsule || publicCapsule.triggerType !== 'date') {
    element.textContent = '';
    return;
  }
  const seconds = Math.max(
    0,
    Math.ceil((Date.parse(publicCapsule.triggerValue) - Date.now()) / 1000),
  );
  element.textContent =
    seconds === 0
      ? 'The date has arrived. Waiting for the capsule to open.'
      : Math.floor(seconds / 86400) +
        'd ' +
        Math.floor((seconds % 86400) / 3600) +
        'h ' +
        Math.floor((seconds % 3600) / 60) +
        'm ' +
        (seconds % 60) +
        's to go';
}
function renderPublicCapsule(capsule) {
  publicCapsule = capsule;
  document.title = capsule.title + ' | Time Capsule';
  document.getElementById('capsule-details').hidden = false;
  document.getElementById('public-status').textContent = '';
  document.getElementById('capsule-title').textContent = capsule.title;
  document.getElementById('channel-name').textContent =
    '@' + capsule.channel.login + "'S TIME CAPSULE";
  let condition = 'Opens when the streamer chooses.';
  if (capsule.triggerType === 'date')
    condition =
      'Opens ' +
      new Date(capsule.triggerValue).toLocaleString() +
      ', during a live stream.';
  if (capsule.triggerType === 'followers')
    condition =
      'Opens at ' +
      capsule.triggerValue.toLocaleString() +
      ' followers' +
      (typeof capsule.followers === 'number'
        ? ': now ' + capsule.followers.toLocaleString()
        : '') +
      ', during a live stream.';
  if (capsule.triggerType === 'category')
    condition =
      'Opens the first time ' +
      capsule.channel.displayName +
      ' streams ' +
      capsule.triggerValue.category_name +
      '.';
  document.getElementById('capsule-condition').textContent = condition;
  document.getElementById('sealed-count').textContent = String(
    capsule.sealedCount,
  );
  document.getElementById('capsule-state').textContent =
    capsule.status === 'sealing'
      ? 'Still collecting memories.'
      : capsule.status === 'ready'
        ? 'Ready and waiting to open live.'
        : capsule.status === 'opening'
          ? 'The opening has started. Messages remain sealed until revealed.'
          : capsule.status === 'opened'
            ? 'Opened. These memories are preserved.'
            : capsule.status === 'archived'
              ? 'Archived.'
              : 'Sealed and waiting.';
  document.getElementById('how-to-seal').hidden = capsule.status !== 'sealing';
  document.getElementById('closed-note').hidden = capsule.status === 'sealing';
  document.getElementById('closed-note').textContent =
    'This capsule is no longer accepting messages.';
  document.getElementById('seal-limits').textContent =
    '3-' +
    capsule.maxLength +
    ' characters. Up to ' +
    capsule.maxSealsPerUser +
    ' messages per viewer, 10 seconds apart.';
  document.getElementById('chat-link').href =
    'https://www.twitch.tv/' + encodeURIComponent(capsule.channel.login);
  document.getElementById('wall-total').textContent =
    (capsule.prophetTotal ?? capsule.prophets?.length ?? 0).toLocaleString() +
    ' Prophets · They saw it coming.';
  document.getElementById('prophet-wall').hidden = !(
    capsule.prophetTotal ?? capsule.prophets?.length
  );
  if (wallOffset === 0 && !wallSearch)
    renderPublicWall({
      total: capsule.prophetTotal ?? capsule.prophets?.length ?? 0,
      offset: 0,
      prophets: capsule.prophets || [],
    });
  updateCountdown();
}
function renderPublicWall(page) {
  wallTotal = page.total;
  const names = document.getElementById('prophet-wall-list');
  names.replaceChildren();
  for (const prophet of page.prophets) {
    const entry = document.createElement('article');
    entry.className = 'wall-prophet';
    const heading = document.createElement('p');
    heading.className = 'wall-prophet-heading';
    heading.textContent =
      '@' +
      prophet.displayName +
      ' · PROPHET · ' +
      prophet.predictions +
      (prophet.predictions === 1
        ? ' prediction came true'
        : ' predictions came true');
    entry.append(heading);
    for (const message of prophet.messages ?? []) {
      const prediction = document.createElement('div');
      prediction.className = 'wall-prediction';
      const label = document.createElement('span');
      label.className = 'wall-prediction-label';
      label.textContent = 'Prediction #' + message.number + ' · CAME TRUE';
      const quote = document.createElement('blockquote');
      quote.textContent = message.text;
      prediction.append(label, quote);
      entry.append(prediction);
    }
    names.append(entry);
  }
  document.getElementById('wall-page').textContent = page.total
    ? page.offset +
      1 +
      '–' +
      Math.min(page.offset + 50, page.total) +
      ' of ' +
      page.total +
      ' Prophets'
    : 'No matching Prophets';
  document.getElementById('wall-prev').disabled = page.offset === 0;
  document.getElementById('wall-next').disabled =
    page.offset + 50 >= page.total;
}
async function refreshPublicWall() {
  if (wallLoading) return;
  wallLoading = true;
  const version = wallVersion;
  try {
    const getPage = async () => {
      const response = await fetch(
        '/api/public/capsules/' +
          encodeURIComponent(publicSlug) +
          '/prophets?' +
          new URLSearchParams({
            offset: String(wallOffset),
            query: wallSearch,
          }),
        { cache: 'no-store' },
      );
      if (!response.ok) throw new Error('Unable to load the Wall of Prophets.');
      return response.json();
    };
    let page = await getPage();
    if (version !== wallVersion) return;
    if (wallOffset >= page.total && wallOffset > 0) {
      wallOffset = Math.max(0, Math.floor((page.total - 1) / 50) * 50);
      page = await getPage();
      if (version !== wallVersion) return;
    }
    renderPublicWall(page);
    document.getElementById('wall-status').textContent = '';
  } catch (error) {
    if (version === wallVersion)
      document.getElementById('wall-status').textContent =
        error instanceof Error ? error.message : 'Unable to load Prophets.';
  } finally {
    wallLoading = false;
    if (version !== wallVersion) void refreshPublicWall();
  }
}
document.getElementById('wall-search').addEventListener('input', (event) => {
  clearTimeout(wallSearchTimer);
  wallSearch = event.target.value.trim();
  wallOffset = 0;
  wallVersion++;
  wallSearchTimer = setTimeout(() => {
    void refreshPublicWall();
  }, 250);
});
document.getElementById('wall-prev').addEventListener('click', () => {
  wallOffset = Math.max(0, wallOffset - 50);
  wallVersion++;
  void refreshPublicWall();
});
document.getElementById('wall-next').addEventListener('click', () => {
  if (wallOffset + 50 < wallTotal) {
    wallOffset += 50;
    wallVersion++;
    void refreshPublicWall();
  }
});
async function refreshPublicCapsule() {
  try {
    const response = await fetch(
      '/api/public/capsules/' + encodeURIComponent(publicSlug),
      { cache: 'no-store' },
    );
    if (!response.ok)
      throw new Error(
        response.status === 404
          ? 'Capsule not found.'
          : 'Unable to load the capsule right now.',
      );
    renderPublicCapsule(await response.json());
    await refreshPublicWall();
  } catch (error) {
    document.getElementById('public-status').textContent =
      error instanceof Error
        ? error.message
        : 'Unable to refresh this capsule.';
  }
}
void refreshPublicCapsule();
setInterval(() => {
  void refreshPublicCapsule();
}, 5000);
setInterval(updateCountdown, 1000);
