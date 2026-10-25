import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { TwitchAuth } from '../src/twitch/auth.js';
import { CapsuleStore } from '../src/capsule/store.js';
import { openDatabase } from '../src/db/index.js';
import { FakeTwitch, twitchProject } from './twitch-helper.js';
import {
  chatEvent,
  mockWebSocket,
  notification,
  waitFor,
} from './eventsub-helper.js';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(connected = true, live = false) {
  const server = live ? await mockWebSocket() : undefined;
  if (server) cleanup.push(server.close);
  const project = twitchProject();
  cleanup.push(project.cleanup);
  const fake = new FakeTwitch();
  if (connected) {
    const auth = new TwitchAuth(project.config, fake.fetch);
    await auth.connect('streamer', 'streamer-code');
    auth.close();
  }
  const app = buildServer(project.config, {
    fetcher: fake.fetch,
    eventsubEnabled: live,
    eventsubOptions: {
      ...(server ? { url: server.url } : {}),
      batchWindowMs: 15,
    },
  });
  cleanup.push(() => app.close());
  const headers = { 'x-admin-key': project.config.adminKey };
  await app.ready();
  return { ...project, app, headers, fake, server };
}
const createBody = {
  title: 'Predictions for the future',
  triggerType: 'manual',
};
describe('Capsule dashboard and public HTTP APIs', () => {
  it('requires admin access and a connected streamer before creation', async () => {
    const { app, headers } = await fixture(false);
    expect((await app.inject('/api/capsules')).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/capsules',
          payload: createBody,
        })
      ).statusCode,
    ).toBe(401);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/capsules',
      headers,
      payload: createBody,
    });
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error).toContain('Connect');
  });
  it('creates a capsule, returns its metadata, and allows lock then archive', async () => {
    const { app, headers } = await fixture();
    const created = await app.inject({
      method: 'POST',
      url: '/api/capsules',
      headers,
      payload: createBody,
    });
    expect(created.statusCode).toBe(201);
    const capsule = created.json().capsule;
    expect(capsule.channel.login).toBe('streamer');
    expect(capsule.settings.max_length).toBe(280);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/capsules',
          headers,
          payload: createBody,
        })
      ).statusCode,
    ).toBe(409);
    expect((await app.inject('/c/' + capsule.slug)).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/capsules/' + capsule.id + '/lock',
          headers,
        })
      ).json().capsule.status,
    ).toBe('locked');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/capsules/' + capsule.id + '/archive',
          headers,
        })
      ).json().capsule.status,
    ).toBe('archived');
  });
  it('validates conditions, action IDs, and category search without reflecting input', async () => {
    const { app, headers } = await fixture();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/capsules',
          headers,
          payload: {
            ...createBody,
            triggerType: 'followers',
            triggerValue: -1,
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/capsules/not-an-id/lock',
          headers,
        })
      ).statusCode,
    ).toBe(400);
    const categories = await app.inject({
      url: '/api/categories?query=Grand%20Theft',
      headers,
    });
    expect(categories.json()).toEqual({
      categories: [{ id: '32982', name: 'Grand Theft Auto V' }],
    });
    expect(
      (await app.inject({ url: '/api/categories?query=x', headers }))
        .statusCode,
    ).toBe(400);
    expect((await app.inject('/api/public/capsules/unknown')).statusCode).toBe(
      404,
    );
  });
  it('never exposes stored viewer names, IDs, text, or hidden flags in public responses', async () => {
    const { app, headers, config } = await fixture();
    const created = await app.inject({
      method: 'POST',
      url: '/api/capsules',
      headers,
      payload: createBody,
    });
    const capsule = created.json().capsule;
    const db = openDatabase(config.databasePath);
    cleanup.push(() => {
      db.close();
    });
    new CapsuleStore(db).acceptSeal({
      broadcasterId: '1',
      userId: 'PRIVATE_VIEWER_ID',
      userLogin: 'PRIVATE_VIEWER_LOGIN',
      displayName: 'PRIVATE_VIEWER_NAME',
      text: 'TOP_SECRET_SEALED_TEXT',
      chatMessageId: 'private-message-id',
    });
    for (const status of [
      'sealing',
      'locked',
      'ready',
      'opening',
      'opened',
      'archived',
    ]) {
      db.prepare('UPDATE capsules SET status = ? WHERE id = ?').run(
        status,
        capsule.id,
      );
      const response = await app.inject('/api/public/capsules/' + capsule.slug);
      expect(response.statusCode).toBe(200);
      expect(response.json().sealedCount).toBe(1);
      for (const privateValue of [
        'PRIVATE_VIEWER',
        'TOP_SECRET',
        'private-message-id',
        '"hidden"',
        '"visibleCount"',
      ])
        expect(response.body).not.toContain(privateValue);
    }
  });
  it('accepts a seal through EventSub, deletes the exact chat message, updates count, and sends a batched acknowledgement', async () => {
    const { app, headers, config, fake, server } = await fixture(true, true);
    const created = await app.inject({
      method: 'POST',
      url: '/api/capsules',
      headers,
      payload: createBody,
    });
    const capsule = created.json().capsule;
    await waitFor(() => fake.subscriptions.length === 5);
    server?.sockets[0]?.send(
      notification(
        'channel.chat.message',
        chatEvent('!seal PRIVATE_FUTURE_MESSAGE', 'viewer', 'target-message'),
      ),
    );
    await waitFor(() => fake.sentMessages.length === 1);
    expect(fake.deletedMessages).toEqual([
      { broadcaster_id: '1', moderator_id: '1', message_id: 'target-message' },
    ]);
    expect(fake.sentMessages[0]?.message).toContain(
      'Sealed message #1 from @viewer',
    );
    const publicPage = await app.inject('/api/public/capsules/' + capsule.slug);
    expect(publicPage.json().sealedCount).toBe(1);
    expect(publicPage.body).not.toContain('PRIVATE_FUTURE_MESSAGE');
    const logs = await app.inject({ url: '/api/events', headers });
    expect(logs.body).not.toContain('PRIVATE_FUTURE_MESSAGE');
    const db = openDatabase(config.databasePath);
    cleanup.push(() => {
      db.close();
    });
    expect(db.prepare('SELECT hidden FROM seals').get()).toEqual({ hidden: 1 });
  });
  it('never issues a delete without a specific message ID', async () => {
    const { fake, config } = await fixture();
    const auth = new TwitchAuth(config, fake.fetch);
    cleanup.push(() => auth.close());
    await auth.validateAll();
    const { HelixClient } = await import('../src/twitch/helix.js');
    const helix = new HelixClient(auth, fake.fetch);
    await expect(helix.deleteChatMessage('1', '1', '')).rejects.toThrow(
      'specific chat message',
    );
    expect(fake.deletedMessages).toHaveLength(0);
  });
});
