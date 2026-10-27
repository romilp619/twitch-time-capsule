import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { TwitchAuth } from '../src/twitch/auth.js';
import { FakeTwitch, twitchProject } from './twitch-helper.js';
import {
  mockWebSocket,
  waitFor,
  notification,
  chatEvent,
} from './eventsub-helper.js';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  const server = await mockWebSocket();
  cleanup.push(server.close);
  const project = twitchProject();
  cleanup.push(project.cleanup);
  const fake = new FakeTwitch();
  const auth = new TwitchAuth(project.config, fake.fetch);
  await auth.connect('streamer', 'streamer-code');
  auth.close();
  let now = Date.now();
  const app = buildServer(project.config, {
    fetcher: fake.fetch,
    now: () => now,
    eventsubOptions: { url: server.url, batchWindowMs: 1 },
  });
  cleanup.push(() => app.close());
  await app.ready();
  await waitFor(() => fake.subscriptions.length === 5);
  const headers = { 'x-admin-key': project.config.adminKey };
  async function state(id: number) {
    return (await app.inject({ url: '/api/capsules', headers }))
      .json()
      .capsules.find((c: { id: number }) => c.id === id);
  }
  async function create(triggerType: string, triggerValue?: unknown) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/capsules',
      headers,
      payload: {
        title: 'Trigger test',
        triggerType,
        ...(triggerValue === undefined ? {} : { triggerValue }),
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json().capsule;
  }
  async function action(id: number, name: string) {
    return app.inject({
      method: 'POST',
      url: '/api/capsules/' + id + '/' + name,
      headers,
    });
  }
  return {
    app,
    fake,
    headers,
    server,
    create,
    action,
    state,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe('Phase 5 HTTP and EventSub integration', () => {
  it('protects opening controls, postpones offline, and preserves public privacy and counts', async () => {
    const { app, headers, create, action } = await fixture();
    const c = await create('manual');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/capsules/' + c.id + '/open',
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/capsules/' + c.id + '/postpone',
          headers: { ...headers, origin: 'https://evil.invalid' },
        })
      ).statusCode,
    ).toBe(403);
    const ready = (await action(c.id, 'open')).json().capsule;
    expect(ready.status).toBe('ready');
    expect(ready.openingDueAt).toBeNull();
    const postponed = (await action(c.id, 'postpone')).json().capsule;
    expect(postponed.status).toBe('ready');
    expect(postponed.postponedUntil).toBeTruthy();
    const resumed = (await action(c.id, 'open')).json().capsule;
    expect(resumed.postponedUntil).toBeNull();
    expect(resumed.openingDueAt).toBeNull();
    expect(
      (await app.inject('/api/public/capsules/' + c.slug)).body,
    ).not.toContain('openingDueAt');
    expect((await action(c.id, 'archive')).json().capsule.status).toBe(
      'archived',
    );
    expect((await action(c.id, 'open')).statusCode).toBe(409);
  });
  it('opens a category capsule only after online plus the matching category ID', async () => {
    const { fake, server, create, state, advance, app, headers } =
      await fixture();
    const c = await create('category', {
      category_id: '998',
      category_name: 'Grand Theft Auto V',
    });
    fake.live = true;
    server.sockets[0]!.send(
      notification('stream.online', { broadcaster_user_id: '1' }),
    );
    await waitFor(() =>
      fake.fetch.mock.calls.some(([url]) => String(url).includes('/channels?')),
    );
    expect((await state(c.id)).status).toBe('sealing');
    fake.categoryId = '998';
    server.sockets[0]!.send(
      notification('channel.update', {
        broadcaster_user_id: '1',
        category_id: '998',
        category_name: 'Renamed category',
      }),
    );
    for (let i = 0; i < 100 && (await state(c.id)).status !== 'ready'; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await state(c.id)).status).toBe('ready');
    advance(5000);
    server.sockets[0]!.send(
      notification('channel.update', {
        broadcaster_user_id: '1',
        category_id: '998',
        category_name: 'Renamed category',
      }),
    );
    for (let i = 0; i < 100 && (await state(c.id)).status !== 'opening'; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await state(c.id)).status).toBe('opening');
    expect(
      (await app.inject({ url: '/api/ceremony', headers })).json().ceremony,
    ).toMatchObject({
      active: true,
      state: { capsuleId: c.id, stage: 'opening' },
    });
    const log = (await app.inject({ url: '/api/events', headers })).json();
    expect(
      log.filter((e: { type: string }) => e.type === 'capsule.opening'),
    ).toHaveLength(1);
  });
  it('handles real follow notification envelopes and publishes current follower totals', async () => {
    const { fake, server, create, state, app, headers } = await fixture();
    const c = await create('followers', 10);
    fake.followers = 12;
    server.sockets[0]!.send(
      notification('channel.follow', {
        broadcaster_user_id: '1',
        user_id: 'new-viewer',
        user_login: 'newviewer',
      }),
    );
    for (let i = 0; i < 100 && (await state(c.id)).status !== 'ready'; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await state(c.id)).status).toBe('ready');
    expect(
      (await app.inject('/api/public/capsules/' + c.slug)).json(),
    ).toMatchObject({ followers: 12, sealedCount: 0 });
    expect(
      (await app.inject({ url: '/api/connection', headers })).json().triggers
        .followers,
    ).toBe(12);
  });
  it('allows moderator open commands, rejects VIPs, and ignores the sending account', async () => {
    const { server, create, state, fake } = await fixture();
    const c = await create('manual');
    server.sockets[0]!.send(
      notification('channel.chat.message', {
        ...chatEvent('!capsule open', 'vip'),
        badges: [{ set_id: 'vip' }],
      }),
    );
    await waitFor(() => fake.sentMessages.length === 1);
    expect((await state(c.id)).status).toBe('sealing');
    server.sockets[0]!.send(
      notification('channel.chat.message', {
        ...chatEvent('!capsule open', '1'),
        badges: [{ set_id: 'broadcaster' }],
      }),
    );
    server.sockets[0]!.send(
      notification('channel.chat.message', {
        ...chatEvent('!capsule open', 'mod'),
        badges: [{ set_id: 'moderator' }],
      }),
    );
    for (let i = 0; i < 100 && (await state(c.id)).status !== 'ready'; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await state(c.id)).status).toBe('ready');
    expect((await state(c.id)).openingDueAt).toBeNull();
  });
});
