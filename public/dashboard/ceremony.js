const ceremonyKey = new URLSearchParams(location.search).get('key') || '';
let ceremonyData;
let ceremonyBusy = false;
let ceremonySettingsDirty = false;
let queueOffset = 0;
let queueTotal = 0;
let queueVersion = 0;
let queueSignature = '';
let currentOverlayUrl = '';
const ceremonyFeedback = document.getElementById('ceremony-feedback');
function ceremonyMessage(text, failure = false) {
  ceremonyFeedback.textContent = text;
  ceremonyFeedback.className = text
    ? 'banner ' + (failure ? 'danger' : 'success')
    : '';
}
async function ceremonyApi(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    cache: 'no-store',
    headers: {
      'x-admin-key': ceremonyKey,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || 'The ceremony request failed.');
  return data;
}
function ceremonyNode(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function renderCeremony(data) {
  if (!data) return;
  ceremonyData = data;
  const stage = data.state.stage;
  document.getElementById('ceremony-stage').textContent = data.previewActive
    ? 'PREVIEW'
    : stage.toUpperCase();
  document.getElementById('ceremony-summary').textContent = data.active
    ? data.capsule.title +
      (stage === 'opening'
        ? ' · Opening animation is playing for six seconds.'
        : ' · Approve messages, then reveal them on stream.')
    : data.previewActive
      ? 'A ten-second preview is playing. No capsule or Twitch data is changed.'
      : stage === 'ended'
        ? 'Ceremony ended. The overlay is empty and transparent.'
        : 'Waiting for a capsule to open. Use the preview below to check OBS without going live.';
  document.getElementById('ceremony-controls').hidden = !data.active;
  document.getElementById('ceremony-counts').textContent =
    data.counts.pending +
    ' pending · ' +
    data.counts.approved +
    ' approved · ' +
    data.counts.rejected +
    ' rejected · ' +
    data.counts.revealed +
    ' revealed';
  document.getElementById('reveal-next').disabled =
    ceremonyBusy ||
    !data.active ||
    stage === 'opening' ||
    !data.counts.approved;
  document.getElementById('auto-reveal').disabled =
    ceremonyBusy ||
    !data.active ||
    stage === 'opening' ||
    (!data.state.autoReveal && !data.counts.approved);
  document.getElementById('auto-reveal').textContent = data.state.autoReveal
    ? 'Pause auto-reveal'
    : 'Start auto-reveal';
  document.getElementById('end-ceremony').disabled =
    ceremonyBusy || !data.active;
  document.getElementById('preview-overlay').disabled =
    ceremonyBusy || data.active || data.previewActive;
  const warnings = document.getElementById('ceremony-warnings');
  warnings.replaceChildren();
  for (const text of data.warnings)
    warnings.append(ceremonyNode('p', 'banner danger', text));
  if (!ceremonySettingsDirty) {
    document.getElementById('overlay-side').value = data.settings.side;
    document.getElementById('overlay-scale').value = String(
      data.settings.cardScale,
    );
    document.getElementById('auto-seconds').value = String(
      data.settings.autoRevealSeconds,
    );
  }
  const signature =
    String(data.state.capsuleId) + ':' + data.revision + ':' + stage;
  if (data.active && signature !== queueSignature && !ceremonyBusy) {
    queueSignature = signature;
    void refreshModQueue();
  }
  if (!data.active) {
    queueVersion++;
    queueSignature = '';
    queueOffset = 0;
    document.getElementById('mod-queue').replaceChildren();
  }
}
globalThis.renderCeremony = renderCeremony;
async function loadCeremony() {
  try {
    const data = await ceremonyApi('/api/ceremony');
    if (currentOverlayUrl !== data.overlayUrl) {
      currentOverlayUrl = data.overlayUrl;
      document.getElementById('obs-url').value = currentOverlayUrl;
      document.getElementById('overlay-monitor').src = currentOverlayUrl;
    }
    renderCeremony(data.ceremony);
  } catch (error) {
    ceremonyMessage(
      error instanceof Error
        ? error.message
        : 'Unable to load ceremony controls.',
      true,
    );
  }
}
async function ceremonyAction(work) {
  if (ceremonyBusy) return;
  ceremonyBusy = true;
  if (ceremonyData) renderCeremony(ceremonyData);
  try {
    await work();
  } catch (error) {
    ceremonyMessage(
      error instanceof Error ? error.message : 'Ceremony action failed.',
      true,
    );
  } finally {
    ceremonyBusy = false;
    queueSignature = '';
    await loadCeremony();
  }
}
async function refreshModQueue() {
  if (!ceremonyData?.active) return;
  const version = ++queueVersion;
  const filter = document.getElementById('queue-filter').value;
  try {
    const result = await ceremonyApi(
      '/api/ceremony/queue?status=' +
        encodeURIComponent(filter) +
        '&offset=' +
        queueOffset,
    );
    if (version !== queueVersion || !ceremonyData?.active) return;
    queueTotal = result.total;
    if (queueOffset >= queueTotal && queueOffset > 0) {
      queueOffset = Math.max(0, queueOffset - 50);
      await refreshModQueue();
      return;
    }
    const list = document.getElementById('mod-queue');
    list.replaceChildren();
    for (const seal of result.seals) {
      const row = ceremonyNode('article', 'mod-message');
      const heading = ceremonyNode('div', 'mod-heading');
      heading.append(
        ceremonyNode(
          'strong',
          '',
          '#' + seal.number + ' · @' + seal.displayName,
        ),
        ceremonyNode('span', 'badge', seal.status.toUpperCase()),
      );
      row.append(
        heading,
        ceremonyNode(
          'p',
          'metadata',
          'Sealed ' + new Date(seal.createdAt).toLocaleString(),
        ),
        ceremonyNode('blockquote', '', seal.text),
      );
      if (seal.flagged)
        row.append(
          ceremonyNode(
            'p',
            'flagged',
            'Flagged: matches the current blocked-word list. Review carefully before approval.',
          ),
        );
      if (seal.status !== 'revealed') {
        const actions = ceremonyNode('div', 'actions');
        for (const status of ['approved', 'rejected']) {
          const button = ceremonyNode(
            'button',
            status === 'approved' ? 'primary' : 'secondary',
            status === 'approved' ? 'Approve' : 'Reject',
          );
          button.type = 'button';
          button.disabled = ceremonyBusy || seal.status === status;
          button.addEventListener('click', () => {
            void ceremonyAction(async () => {
              await ceremonyApi('/api/ceremony/seals/' + seal.id, 'POST', {
                status,
              });
              ceremonyMessage('Message #' + seal.number + ' ' + status + '.');
            });
          });
          actions.append(button);
        }
        row.append(actions);
      }
      list.append(row);
    }
    if (!result.seals.length)
      list.append(
        ceremonyNode(
          'p',
          'muted',
          'No messages in this filter. Approve pending messages before revealing them.',
        ),
      );
    document.getElementById('queue-page').textContent = queueTotal
      ? String(queueOffset + 1) +
        '–' +
        Math.min(queueOffset + 50, queueTotal) +
        ' of ' +
        queueTotal
      : '0 messages';
    document.getElementById('queue-prev').disabled = queueOffset === 0;
    document.getElementById('queue-next').disabled =
      queueOffset + 50 >= queueTotal;
  } catch (error) {
    if (version === queueVersion) {
      queueSignature = '';
      ceremonyMessage(
        error instanceof Error
          ? error.message
          : 'Cannot load the private queue.',
        true,
      );
    }
  }
}
function revealNext() {
  void ceremonyAction(async () => {
    await ceremonyApi('/api/ceremony/reveal', 'POST');
    ceremonyMessage('Approved message revealed on the overlay.');
  });
}
document.getElementById('reveal-next').addEventListener('click', revealNext);
document.getElementById('auto-reveal').addEventListener('click', () => {
  void ceremonyAction(async () => {
    const enabled = !ceremonyData.state.autoReveal;
    await ceremonyApi('/api/ceremony/auto', 'POST', { enabled });
    ceremonyMessage(
      enabled
        ? 'Auto-reveal started. It pauses when no approved messages remain.'
        : 'Auto-reveal paused.',
    );
  });
});
document.getElementById('end-ceremony').addEventListener('click', () => {
  void ceremonyAction(async () => {
    await ceremonyApi('/api/ceremony/end', 'POST');
    ceremonyMessage('Ceremony ended. The overlay is now empty.');
    globalThis.renderCapsules?.((await ceremonyApi('/api/capsules')).capsules);
  });
});
document.getElementById('preview-overlay').addEventListener('click', () => {
  void ceremonyAction(async () => {
    await ceremonyApi('/api/ceremony/preview', 'POST');
    document.querySelector('.overlay-monitor').open = true;
    ceremonyMessage('Playing a ten-second preview with sample messages.');
  });
});
document.getElementById('copy-obs-url').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(currentOverlayUrl);
    ceremonyMessage(
      'Private OBS URL copied. Paste it into an OBS Browser Source.',
    );
  } catch {
    ceremonyMessage('Select the OBS URL field and copy it manually.', true);
  }
});
document.getElementById('overlay-settings').addEventListener('input', () => {
  ceremonySettingsDirty = true;
});
document
  .getElementById('overlay-settings')
  .addEventListener('submit', (event) => {
    event.preventDefault();
    void ceremonyAction(async () => {
      await ceremonyApi('/api/ceremony/settings', 'POST', {
        side: document.getElementById('overlay-side').value,
        cardScale: Number(document.getElementById('overlay-scale').value),
        autoRevealSeconds: Number(
          document.getElementById('auto-seconds').value,
        ),
      });
      ceremonySettingsDirty = false;
      ceremonyMessage('Overlay settings saved.');
    });
  });
document.getElementById('queue-filter').addEventListener('change', () => {
  queueOffset = 0;
  void refreshModQueue();
});
document.getElementById('queue-refresh').addEventListener('click', () => {
  void refreshModQueue();
});
document.getElementById('queue-prev').addEventListener('click', () => {
  queueOffset = Math.max(0, queueOffset - 50);
  void refreshModQueue();
});
document.getElementById('queue-next').addEventListener('click', () => {
  if (queueOffset + 50 < queueTotal) queueOffset += 50;
  void refreshModQueue();
});
addEventListener('keydown', (event) => {
  if (
    event.key.toLowerCase() !== 'n' ||
    event.repeat ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey
  )
    return;
  const target = event.target;
  if (
    target?.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName)
  )
    return;
  if (
    !ceremonyBusy &&
    ceremonyData?.active &&
    ['queue', 'reveal', 'prophet'].includes(ceremonyData.state.stage) &&
    ceremonyData.counts.approved > 0
  ) {
    event.preventDefault();
    revealNext();
  }
});
if (globalThis.ceremonySnapshot) renderCeremony(globalThis.ceremonySnapshot);
void loadCeremony();
setInterval(() => {
  if (!ceremonyBusy) void loadCeremony();
}, 5000);
