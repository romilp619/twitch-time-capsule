(() => {
  const views = Array.from(document.querySelectorAll('[data-workspace-view]'));
  const links = Array.from(document.querySelectorAll('[data-workspace-nav]'));
  const state = {};
  let firstConnection = true;
  let userNavigated = Boolean(location.hash);

  function showView(name, target) {
    for (const view of views) view.hidden = view.dataset.workspaceView !== name;
    for (const link of links) {
      if (link.dataset.workspaceNav === name)
        link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    if (target) {
      for (
        let parent = target.parentElement;
        parent;
        parent = parent.parentElement
      ) {
        if (parent.tagName === 'DETAILS') parent.open = true;
      }
      target.focus({ preventScroll: true });
      const view = target.closest('[data-workspace-view]');
      if (target.id !== view?.getAttribute('aria-labelledby')) {
        target.scrollIntoView({ block: 'start' });
        return;
      }
    }
    // Section navigation always starts with the shared header and studio heading.
    globalThis.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }
  function followHash() {
    const target = document.getElementById(location.hash.slice(1));
    const view = target?.closest('[data-workspace-view]');
    showView(view?.dataset.workspaceView || 'capsules', view ? target : null);
  }
  addEventListener('hashchange', () => {
    userNavigated = true;
    followHash();
  });
  // Own internal navigation so the browser cannot jump to the fragment first.
  document.addEventListener('click', (event) => {
    if (
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const link = event.target.closest('a[href^="#"]');
    if (!link) return;
    const hash = link.getAttribute('href');
    const target = document.getElementById(hash.slice(1));
    if (!target?.closest('[data-workspace-view]')) return;
    event.preventDefault();
    userNavigated = true;
    if (hash !== location.hash) history.pushState(null, '', hash);
    followHash();
  });
  // Apply the same position after initial fragment scrolling or a page refresh.
  history.scrollRestoration = 'manual';
  addEventListener('load', followHash);
  function nextStep(title, description, label, view) {
    document.getElementById('workspace-next-title').textContent = title;
    document.getElementById('workspace-next-description').textContent =
      description;
    const action = document.getElementById('workspace-next-action');
    action.textContent = label + ' →';
    action.href = '#' + view + '-title';
  }
  globalThis.updateWorkspace = (patch) => {
    Object.assign(state, patch);
    const connection = state.connection;
    const connected = connection?.streamer.status === 'connected';
    const live = document.getElementById('workspace-live');
    live.textContent =
      connection?.live === true
        ? 'Live now'
        : connection?.live === false
          ? 'Offline'
          : 'Checking stream';
    live.classList.toggle('is-live', connection?.live === true);
    document.getElementById('workspace-channel').textContent = connection
      ?.streamer.login
      ? '@' + connection.streamer.login
      : 'Your channel';
    document.getElementById('workspace-connection-label').textContent =
      connected
        ? connection.bot?.status === 'connected'
          ? 'Streamer & bot connected'
          : 'Streamer connected'
        : 'Connect Twitch to begin';
    document
      .getElementById('workspace-connection-dot')
      .classList.toggle('connected', connected);
    if (connection && firstConnection) {
      firstConnection = false;
      if (!connected && !userNavigated) showView('connection');
    }
    const ceremony = state.ceremony;
    const count =
      (ceremony?.counts.pending || 0) + (ceremony?.counts.approved || 0);
    const badge = document.getElementById('ceremony-nav-count');
    badge.hidden = !ceremony?.active || !count;
    badge.textContent = count.toLocaleString();
    const collecting = state.capsules?.find(
      (capsule) => capsule.status === 'sealing',
    );
    const waiting = state.capsules?.find((capsule) =>
      ['ready', 'locked'].includes(capsule.status),
    );
    const finished = state.capsules?.some(
      (capsule) => capsule.status === 'opened',
    );
    if (connection && !connected)
      nextStep(
        'Connect your channel',
        'Sign in with the Twitch account that owns your stream.',
        'Connect Twitch',
        'connection',
      );
    else if (ceremony?.active && ceremony.state.stage === 'opening')
      nextStep(
        'Your capsule is opening',
        'The opening animation takes six seconds. Review your messages next.',
        'Go to ceremony',
        'ceremony',
      );
    else if (ceremony?.active && ceremony.counts.pending > 0)
      nextStep(
        'Choose what goes on stream',
        ceremony.counts.pending.toLocaleString() +
          ' messages are waiting for your approval.',
        'Review messages',
        'ceremony',
      );
    else if (ceremony?.active && ceremony.counts.approved > 0)
      nextStep(
        'Ready for the big reveal',
        ceremony.counts.approved.toLocaleString() +
          ' approved messages are ready. Reveal them yourself or use auto-reveal.',
        'Reveal predictions',
        'ceremony',
      );
    else if (ceremony?.active && ceremony.counts.revealed > 0)
      nextStep(
        'Who saw it coming?',
        'All approved messages are revealed. Mark the correct predictions as Came true.',
        'Go to Prophets',
        'prophets',
      );
    else if (ceremony?.active)
      nextStep(
        'Finish your ceremony',
        'There are no messages left to reveal. End the ceremony to clear the overlay.',
        'Go to ceremony',
        'ceremony',
      );
    else if (collecting)
      nextStep(
        'Let chat send a message to the future',
        'Collect predictions with !seal your message. Finish collecting before you start opening.',
        'View collecting capsule',
        'capsules',
      );
    else if (waiting)
      nextStep(
        waiting.status === 'ready'
          ? 'Your opening is queued'
          : 'Your capsule is waiting',
        waiting.openingDueAt
          ? 'Opening automatically at ' +
              new Date(waiting.openingDueAt).toLocaleTimeString() +
              '. No further clicks needed.'
          : waiting.status === 'ready'
            ? 'Start your Twitch stream. The capsule opens automatically after the settling-in delay.'
            : 'Check its opening condition. A live Twitch stream is required to open.',
        'View capsule',
        'capsules',
      );
    else if (finished)
      nextStep(
        'Keep the celebration going',
        'Mark winning predictions, or replay them with the scrolling showcase.',
        'Go to Prophets',
        'prophets',
      );
    else
      nextStep(
        'Create your first capsule',
        'Choose a title and opening condition, then invite chat to send predictions.',
        'Create a capsule',
        'capsules',
      );
  };
  followHash();
})();
