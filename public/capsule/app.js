let publicCapsule;
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
  updateCountdown();
}
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
