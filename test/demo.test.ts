import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoServer } from '../src/demo/server.js';
import { sampleViewers } from '../src/demo/samples.js';
import { FakeTwitch as DemoTwitch } from '../src/demo/fake-twitch.js';
import { buildServer } from '../src/server.js';
import { temporaryProject } from './helpers.js';
import { twitchProject, FakeTwitch } from './twitch-helper.js';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function fixture(fakeTime = false) {
  if (fakeTime)
    vi.useFakeTimers({
      toFake: [
        'Date',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
      ],
    });
  const project = temporaryProject();
  cleanup.push(project.cleanup);
  const demo = createDemoServer({ root: project.root, port: 3002 });
  cleanup.push(() => demo.app.close());
  const ready = demo.app.ready();
  if (fakeTime) await vi.advanceTimersByTimeAsync(10);
  await ready;
  const headers = { 'x-admin-key': demo.config.adminKey };
  const post = (action: string, extra: Record<string, unknown> = {}) =>
    demo.app.inject({
      method: 'POST',
      url: '/api/demo/action',
      headers,
      payload: { action, ...extra },
    });
  return { ...demo, root: project.root, post, headers };
}
describe('Account-free isolated demo', () => {
  it('ignores .env, real credentials, private keys, and the real database', async () => {
    const project = temporaryProject();
    cleanup.push(project.cleanup);
    mkdirSync(resolve(project.root, 'data'));
    const privateDb = resolve(project.root, 'data/time-capsule.db');
    writeFileSync(privateDb, 'REAL DATABASE SENTINEL');
    writeFileSync(
      resolve(project.root, '.env'),
      'TWITCH_CLIENT_ID=real-account\nTWITCH_CLIENT_SECRET=do-not-use-this-secret\nDATA_DIR=data\nADMIN_KEY=real-private-key-never-read\n',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Real networking is forbidden in the demo');
      }),
    );
    const demo = createDemoServer({ root: project.root, port: 3002 });
    cleanup.push(() => demo.app.close());
    await demo.app.ready();
    expect(demo.config.dataDir).toContain('/data/demo/run-');
    expect(demo.config.twitchClientId).toBe('demo-only-client');
    const response = await demo.app.inject('/api/demo');
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('do-not-use-this-secret');
    expect(response.body).not.toContain('real-private-key');
    expect(readFileSync(privateDb, 'utf8')).toBe('REAL DATABASE SENTINEL');
    expect(fetch).not.toHaveBeenCalled();
    expect(
      (
        await demo.app.inject({
          url: '/api/connection',
          headers: { 'x-admin-key': demo.config.adminKey },
        })
      ).json().eventsub.status,
    ).toBe('simulated');
    expect(response.json()).toMatchObject({
      mode: 'demo',
      state: 'idle',
      capsule: { sealedCount: 0, status: 'sealing' },
    });
    expect((await demo.app.inject('/health')).json()).toMatchObject({
      phase: 8,
      mode: 'demo',
      database: 'ok',
    });
  });
  it('starts every run in fresh demo storage and refuses unknown outbound requests', async () => {
    const f = await fixture();
    const second = createDemoServer({ root: f.root, port: 3003 });
    cleanup.push(() => second.app.close());
    await second.app.ready();
    expect(second.config.databasePath).not.toBe(f.config.databasePath);
    expect(second.config.adminKey).not.toBe(f.config.adminKey);
    await expect(
      new DemoTwitch().fetch('https://example.invalid/'),
    ).rejects.toThrow('disabled');
    await expect(
      new DemoTwitch().fetch('https://api.twitch.tv/helix/unknown', {
        headers: {
          Authorization: 'Bearer demo-only-access',
          'Client-Id': 'demo-only-client',
        },
      }),
    ).rejects.toThrow();
  });
  it('uses the real command pipeline to store 20 unique hidden seals, with safe repeat clicks', async () => {
    const f = await fixture();
    await f.post('seals');
    await f.post('seals');
    expect(f.controller.snapshot().capsule?.sealedCount).toBe(20);
    expect(f.twitch.deleted.size).toBe(20);
    expect(new Set(sampleViewers.map((s) => s[0])).size).toBe(20);
    expect(f.twitch.messages.length).toBeGreaterThan(0);
    expect((await f.app.inject('/api/demo')).body).not.toContain(
      sampleViewers[0][1],
    );
    const pub = f.controller.snapshot().links.public!;
    expect((await f.app.inject(new URL(pub).pathname)).statusCode).toBe(200);
    const metadata = (
      await f.app.inject(
        '/api/public/capsules/' + new URL(pub).pathname.split('/').at(-1),
      )
    ).body;
    expect(metadata).not.toContain(sampleViewers[0][1]);
  });
  it('requires the separate demo key and same origin for validated controls', async () => {
    const f = await fixture();
    const url = '/api/demo/action';
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url,
          payload: { action: 'seals' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url,
          headers: { 'x-admin-key': f.config.overlayKey },
          payload: { action: 'seals' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url,
          headers: { ...f.headers, origin: 'https://evil.invalid' },
          payload: { action: 'seals' },
        })
      ).statusCode,
    ).toBe(403);
    expect((await f.post('not-an-action')).statusCode).toBe(400);
    expect((await f.post('date', { seconds: 123 })).statusCode).toBe(400);
    expect((await f.post('date')).statusCode).toBe(409);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/auth/start',
          headers: f.headers,
          payload: { role: 'streamer' },
        })
      ).statusCode,
    ).toBe(409);
  });
  it('opens a date capsule only after the simulated stream goes live', async () => {
    const f = await fixture(true);
    await f.post('new', { scenario: 'date' });
    await f.post('seals');
    await f.post('date');
    expect(f.controller.snapshot().capsule?.status).toBe('ready');
    expect(f.controller.snapshot().ceremony).toBe('idle');
    await f.post('live');
    await vi.advanceTimersByTimeAsync(5250);
    expect(f.controller.snapshot().capsule?.status).toBe('opening');
    await vi.advanceTimersByTimeAsync(6250);
    expect(f.controller.snapshot().ceremony).toBe('queue');
    await f.post('approve');
    await f.post('reveal');
    await f.post('prophet');
    expect(f.twitch.vips.size).toBe(1);
    expect(f.controller.snapshot().ceremony).toBe('prophet');
  });
  it('supports follower and category controls through the production trigger engine', async () => {
    const f = await fixture(true);
    await f.post('new', { scenario: 'followers' });
    await f.post('followers');
    expect(f.controller.snapshot().capsule?.status).toBe('ready');
    await f.post('new', { scenario: 'category' });
    await f.post('category');
    expect(f.controller.snapshot().capsule?.status).toBe('sealing');
    await f.post('live');
    await vi.advanceTimersByTimeAsync(5250);
    expect(f.controller.snapshot().capsule?.status).toBe('opening');
  });
  it('plays the complete 90-second story using the real ceremony and Prophet services', async () => {
    const f = await fixture(true);
    await f.post('story');
    expect((await f.post('seals')).statusCode).toBe(409);
    expect((await f.post('story')).statusCode).toBe(409);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(f.controller.snapshot()).toMatchObject({
      state: 'running',
      facts: { live: false },
      capsule: { status: 'locked', sealedCount: 20 },
    });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(f.controller.snapshot().capsule?.status).toBe('locked');
    await vi.advanceTimersByTimeAsync(18_000);
    expect(f.controller.snapshot().ceremony).toBe('queue');
    await vi.advanceTimersByTimeAsync(16_000);
    expect(f.controller.snapshot()).toMatchObject({
      ceremony: 'prophet',
      vipCount: 1,
    });
    const overlay = (
      await f.app.inject('/api/overlay/state?key=' + f.config.overlayKey)
    ).json();
    expect(overlay.cards).toHaveLength(3);
    expect(overlay.cards[2].cameTrue).toBe(true);
    expect(
      f.twitch.messages.some((m) => m.text.includes('VIP for 30 days.')),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(17_000);
    const done = f.controller.snapshot();
    expect(done).toMatchObject({
      state: 'completed',
      elapsedMs: 90000,
      capsule: { status: 'opened', sealedCount: 20 },
    });
    expect(
      (
        await f.app.inject('/api/overlay/state?key=' + f.config.overlayKey)
      ).json(),
    ).toMatchObject({ stage: 'idle', cards: [] });
    const slug = new URL(done.links.public!).pathname.split('/').at(-1);
    const pub = (await f.app.inject('/api/public/capsules/' + slug)).json();
    expect(pub.prophets).toEqual([
      {
        displayName: 'FutureViewer',
        predictions: 1,
        messages: [
          { number: 3, text: 'We will win the first race without restarting.' },
        ],
      },
    ]);
    expect(JSON.stringify(pub)).not.toContain(sampleViewers[0][1]);
  });
  it('stops the story without losing seals and keeps old demo capsules when starting a new one', async () => {
    const f = await fixture(true);
    await f.post('story');
    await vi.advanceTimersByTimeAsync(9000);
    await f.post('stop');
    const stopped = f.controller.snapshot();
    const count = stopped.capsule?.sealedCount;
    expect(count).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(90000);
    expect(f.controller.snapshot().capsule?.sealedCount).toBe(count);
    await f.post('new', { scenario: 'date' });
    expect(f.controller.snapshot()).toMatchObject({
      state: 'idle',
      elapsedMs: 0,
      capsule: { sealedCount: 0 },
    });
    const old = (
      await f.app.inject({ url: '/api/capsules', headers: f.headers })
    )
      .json()
      .capsules.find((c: { id: number }) => c.id === stopped.capsule?.id);
    expect(old).toMatchObject({ status: 'archived', sealedCount: count });
  });
  it('serves local artwork and embeds the dashboard only within the demo origin', async () => {
    const f = await fixture();
    expect((await f.app.inject('/demo')).body).toContain('Play full story');
    expect(
      (await f.app.inject('/demo/gameplay.svg')).headers['content-type'],
    ).toContain('image/svg+xml');
    const frame = await f.app.inject('/dashboard?key=' + f.config.adminKey);
    expect(frame.body).toContain('DEMO');
    expect(frame.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(frame.headers['content-security-policy']).toContain(
      "frame-ancestors 'self'",
    );
    const project = twitchProject();
    cleanup.push(project.cleanup);
    const real = buildServer(project.config, {
      fetcher: new FakeTwitch().fetch,
      eventsubEnabled: false,
    });
    cleanup.push(() => real.close());
    expect((await real.inject('/api/demo')).statusCode).toBe(404);
    expect((await real.inject('/demo')).statusCode).toBe(404);
    const realFrame = await real.inject(
      '/dashboard?key=' + project.config.adminKey,
    );
    expect(realFrame.headers['x-frame-options']).toBe('DENY');
    expect(realFrame.body).not.toContain('Fake Twitch account');
  });
});
