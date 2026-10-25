import { afterEach, describe, expect, it, vi } from 'vitest';
import { TwitchAuth } from '../src/twitch/auth.js';
import { HelixClient } from '../src/twitch/helix.js';
import { TwitchRuntime } from '../src/twitch/runtime.js';
import { openDatabase } from '../src/db/index.js';
import { EventLog } from '../src/db/events.js';
import { FakeTwitch, twitchProject } from './twitch-helper.js';
import {
  mockWebSocket,
  notification,
  chatEvent,
  waitFor,
} from './eventsub-helper.js';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(separate = false) {
  const server = await mockWebSocket();
  cleanup.push(server.close);
  const project = twitchProject();
  cleanup.push(project.cleanup);
  const fake = new FakeTwitch();
  const auth = new TwitchAuth(project.config, fake.fetch);
  await auth.connect('streamer', 'streamer-code');
  if (separate) await auth.connect('bot', 'bot-code');
  const db = openDatabase(':memory:');
  cleanup.push(() => {
    db.close();
  });
  const log = new EventLog(db);
  const live = vi.fn();
  const runtime = new TwitchRuntime(
    auth,
    new HelixClient(auth, fake.fetch),
    log,
    () => {},
    live,
    { url: server.url, retryDelayMs: 5 },
  );
  cleanup.push(async () => {
    auth.close();
    await runtime.close();
  });
  await runtime.sync();
  await waitFor(() => runtime.snapshot().status === 'connected');
  return { server, auth, runtime, fake, log, live };
}
describe('Per-user Twitch runtime', () => {
  it('creates five user-token subscriptions in single-account mode and handles incoming chat and stream state', async () => {
    const { server, fake, live, log } = await fixture();
    expect(fake.subscriptions).toHaveLength(5);
    expect(fake.subscriptions.every((entry) => entry.role === 'streamer')).toBe(
      true,
    );
    const event = chatEvent('!capsule');
    server.sockets[0]?.send(notification('channel.chat.message', event));
    await waitFor(() => fake.sentMessages.length === 1);
    server.sockets[0]?.send(notification('channel.chat.message', event));
    server.sockets[0]?.send(
      notification('stream.online', { broadcaster_user_id: '1' }),
    );
    await waitFor(() => live.mock.calls.length === 1);
    expect(live).toHaveBeenCalledWith(true);
    expect(fake.sentMessages).toHaveLength(1);
    expect(log.latest().some((entry) => entry.type === 'chat.received')).toBe(
      true,
    );
  });
  it('uses distinct token users for broadcaster and bot connections and migrates back to single-account mode', async () => {
    const { fake, auth, runtime, server } = await fixture(true);
    expect(runtime.snapshot().connections).toHaveLength(2);
    expect(
      fake.subscriptions.filter((entry) => entry.role === 'streamer'),
    ).toHaveLength(4);
    expect(
      fake.subscriptions.filter((entry) => entry.role === 'bot'),
    ).toHaveLength(1);
    expect(
      fake.subscriptions.find((entry) => entry.role === 'bot')?.body.condition
        .user_id,
    ).toBe('2');
    auth.disconnect('bot');
    await runtime.sync();
    await waitFor(
      () =>
        runtime.snapshot().status === 'connected' &&
        server.sockets.length === 3,
    );
    expect(runtime.snapshot().connections).toHaveLength(1);
    expect(runtime.snapshot().subscriptions).toHaveLength(5);
  });
  it('preserves sockets during token refresh for the same user', async () => {
    const { runtime, auth, server } = await fixture();
    await auth.refresh('streamer');
    await runtime.sync();
    expect(server.sockets).toHaveLength(1);
    expect(runtime.snapshot().status).toBe('connected');
  });
});
