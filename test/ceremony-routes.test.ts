import { once } from 'node:events';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { openDatabase } from '../src/db/index.js';
import { CapsuleStore } from '../src/capsule/store.js';
import { FakeTwitch, twitchProject } from './twitch-helper.js';
import { waitFor } from './eventsub-helper.js';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(active = true, listen = false) {
  const project = twitchProject();
  cleanup.push(project.cleanup);
  let now = Date.now();
  const db = openDatabase(project.config.databasePath);
  cleanup.push(() => {
    db.close();
  });
  const store = new CapsuleStore(
    db,
    () => {},
    () => now,
  );
  const capsule = store.create(
    { title: 'Private ceremony', triggerType: 'manual' },
    { id: '1', login: 'streamer', displayName: 'Streamer' },
  );
  for (let i = 1; i <= 3; i++)
    store.acceptSeal({
      broadcasterId: '1',
      userId: 'v' + i,
      userLogin: 'viewer' + i,
      displayName: 'Viewer ' + i,
      text: 'PRIVATE_TEXT_' + i,
      chatMessageId: 'm' + i,
    });
  if (active)
    db.prepare("UPDATE capsules SET status='opening' WHERE id=?").run(
      capsule.id,
    );
  const fake = new FakeTwitch();
  const app = buildServer(project.config, {
    fetcher: fake.fetch,
    now: () => now,
    eventsubEnabled: false,
  });
  cleanup.push(() => app.close());
  if (listen) await app.listen({ host: '127.0.0.1', port: 0 });
  else await app.ready();
  const headers = { 'x-admin-key': project.config.adminKey };
  const post = (path: string, payload?: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: path,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
  async function queue() {
    now += 6000;
    await vi.waitFor(
      async () => {
        expect(
          (await app.inject({ url: '/api/ceremony', headers })).json().ceremony
            .state.stage,
        ).toBe('queue');
      },
      { timeout: 1500, interval: 10 },
    );
  }
  const address = app.server.address();
  const wsUrl =
    address && typeof address !== 'string'
      ? 'ws://127.0.0.1:' + address.port + '/ws/overlay'
      : '';
  return {
    ...project,
    app,
    db,
    store,
    capsule,
    fake,
    headers,
    post,
    queue,
    wsUrl,
  };
}
function denied(url: string, origin: string) {
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Origin: origin } });
    socket.on('error', () => {});
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('Expected rejected upgrade'));
    }, 2000);
    socket.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      res.resume();
      socket.terminate();
      resolve(res.statusCode ?? 0);
    });
  });
}
describe('Ceremony API and overlay isolation', () => {
  it('allows the OBS default stylesheet only on the overlay while keeping scripts strict', async () => {
    const { app, config } = await fixture(false);
    const overlay = await app.inject('/overlay?key=' + config.overlayKey);
    const policy = overlay.headers['content-security-policy'];
    expect(policy).toContain(
      "style-src 'self' 'sha256-Yd1GhiWi47kUsi/SDfKQTY7E39TboDOQOjTJBsT0GQg='",
    );
    expect(policy).toContain("script-src 'self';");
    expect(policy).not.toContain("'unsafe-inline'");
    const dashboard = await app.inject('/dashboard?key=' + config.adminKey);
    expect(dashboard.headers['content-security-policy']).toContain(
      "style-src 'self';",
    );
    expect(dashboard.headers['content-security-policy']).not.toContain(
      'sha256-',
    );
  });
  it('separates admin and overlay keys, rejects missing keys and cross-origin mutations', async () => {
    const { app, config, headers } = await fixture();
    for (const path of [
      '/api/ceremony',
      '/api/ceremony/queue',
      '/overlay',
      '/api/overlay/state',
    ])
      expect((await app.inject(path)).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: '/api/ceremony',
          headers: { 'x-admin-key': config.overlayKey },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app.inject('/overlay?key=' + config.adminKey)).statusCode,
    ).toBe(401);
    expect(
      (await app.inject('/overlay?key=' + config.overlayKey)).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'POST', url: '/api/ceremony/reveal' }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/ceremony/end',
          headers: { ...headers, origin: 'https://evil.invalid' },
        })
      ).statusCode,
    ).toBe(403);
    const metadata = await app.inject({ url: '/api/ceremony', headers });
    expect(metadata.body).not.toContain('PRIVATE_TEXT');
    expect(metadata.json().overlayUrl).toContain('/overlay?key=');
  });
  it('only returns pending texts to the private queue and only reveals approved messages to OBS', async () => {
    const { app, config, headers, post, queue, capsule } = await fixture();
    const keyPath = '/api/overlay/state?key=' + config.overlayKey;
    expect(
      (await app.inject({ url: '/api/ceremony/queue', headers })).body,
    ).toContain('PRIVATE_TEXT_1');
    expect((await app.inject(keyPath)).body).not.toContain('PRIVATE_TEXT');
    expect((await post('/api/ceremony/reveal')).statusCode).toBe(409);
    await post('/api/ceremony/seals/2', { status: 'rejected' });
    await post('/api/ceremony/seals/1', { status: 'approved' });
    await queue();
    expect((await post('/api/ceremony/reveal')).statusCode).toBe(200);
    const overlay = await app.inject(keyPath);
    expect(overlay.json().cards).toHaveLength(1);
    expect(overlay.body).toContain('PRIVATE_TEXT_1');
    expect(overlay.body).not.toContain('PRIVATE_TEXT_2');
    expect(overlay.body).not.toContain('PRIVATE_TEXT_3');
    expect(
      (await post('/api/ceremony/seals/1', { status: 'rejected' })).statusCode,
    ).toBe(409);
    await post('/api/ceremony/end');
    expect((await app.inject(keyPath)).json()).toMatchObject({
      stage: 'idle',
      cards: [],
    });
    expect(
      (await app.inject('/api/public/capsules/' + capsule.slug)).body,
    ).not.toContain('PRIVATE_TEXT');
    const events = await app.inject({ url: '/api/events', headers });
    expect(events.body).not.toContain('PRIVATE_TEXT');
  });
  it('validates queue pages, moderation status, settings, and auto-reveal bodies', async () => {
    const { app, headers, post } = await fixture();
    for (const query of ['status=invalid', 'offset=-1', 'limit=101'])
      expect(
        (await app.inject({ url: '/api/ceremony/queue?' + query, headers }))
          .statusCode,
      ).toBe(400);
    expect(
      (await post('/api/ceremony/seals/not-an-id', { status: 'approved' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await post('/api/ceremony/seals/999', { status: 'approved' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await post('/api/ceremony/seals/1', { status: 'revealed' })).statusCode,
    ).toBe(400);
    expect(
      (
        await post('/api/ceremony/settings', {
          side: 'top',
          cardScale: 1,
          autoRevealSeconds: 8,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await post('/api/ceremony/auto', { enabled: 'yes' })).statusCode,
    ).toBe(400);
  });
  it('allows a preview without Twitch and keeps sample data separate from actual seals', async () => {
    const { app, config, post, fake, store, capsule } = await fixture(false);
    expect((await post('/api/ceremony/preview')).statusCode).toBe(200);
    expect(
      (await app.inject('/api/overlay/state?key=' + config.overlayKey)).json(),
    ).toMatchObject({ preview: true, stage: 'opening' });
    expect(store.get(capsule.id)).toMatchObject({
      status: 'sealing',
      sealedCount: 3,
    });
    expect(fake.sentMessages).toEqual([]);
    expect((await post('/api/ceremony/preview')).statusCode).toBe(409);
  });
  it('requires the overlay key plus same-origin WebSocket upgrade', async () => {
    const { wsUrl, config } = await fixture(false, true);
    expect(await denied(wsUrl, config.baseUrl)).toBe(401);
    expect(
      await denied(wsUrl + '?key=' + config.adminKey, config.baseUrl),
    ).toBe(401);
    expect(
      await denied(wsUrl + '?key=' + config.overlayKey, 'https://evil.invalid'),
    ).toBe(403);
  });
  it('restores revealed cards on OBS reconnect and pushes an empty snapshot when ended', async () => {
    const { wsUrl, config, post, queue } = await fixture(true, true);
    const url = wsUrl + '?key=' + config.overlayKey;
    const socket = new WebSocket(url, { headers: { Origin: config.baseUrl } });
    cleanup.push(() => socket.terminate());
    const [initial] = await once(socket, 'message');
    expect(JSON.parse(String(initial))).toMatchObject({
      stage: 'opening',
      cards: [],
    });
    const packets: Array<{ stage: string; cards: Array<{ text: string }> }> =
      [];
    socket.on('message', (value) =>
      packets.push(JSON.parse(value.toString()) as (typeof packets)[number]),
    );
    await post('/api/ceremony/seals/1', { status: 'approved' });
    await queue();
    await post('/api/ceremony/reveal');
    await waitFor(() =>
      packets.some((p) => p.cards.some((c) => c.text === 'PRIVATE_TEXT_1')),
    );
    const restored = new WebSocket(url, {
      headers: { Origin: config.baseUrl },
    });
    cleanup.push(() => restored.terminate());
    const [message] = await once(restored, 'message');
    expect(JSON.parse(String(message)).cards[0].text).toBe('PRIVATE_TEXT_1');
    expect(JSON.stringify(packets)).not.toContain('PRIVATE_TEXT_2');
    expect(JSON.stringify(packets)).not.toContain('streamer-access');
    await post('/api/ceremony/end');
    await waitFor(() => packets.at(-1)?.stage === 'idle');
    expect(packets.at(-1)?.cards).toEqual([]);
  });
});
