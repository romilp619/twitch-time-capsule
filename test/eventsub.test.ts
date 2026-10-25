import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EventSubClient,
  MessageDedupe,
  subscriptionPlan,
  type EventSubscription,
} from '../src/twitch/eventsub.js';
import {
  mockWebSocket,
  notification,
  packet,
  waitFor,
  welcome,
} from './eventsub-helper.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const plan = subscriptionPlan('1', '1', true, true);
describe('EventSub WebSocket lifecycle with a real mock server', () => {
  it('subscribes immediately after welcome and records keepalives', async () => {
    const server = await mockWebSocket();
    cleanup.push(server.close);
    const subscribe = vi.fn<
      (sessionId: string, subscription: EventSubscription) => Promise<void>
    >(async () => {});
    const client = new EventSubClient(plan, {
      url: server.url,
      subscribe,
      onNotification: () => {},
    });
    cleanup.push(() => client.stop());
    client.start();
    await waitFor(() => client.snapshot().status === 'connected');
    expect(subscribe).toHaveBeenCalledTimes(5);
    expect(subscribe.mock.calls.every((call) => call[0] === 'session-1')).toBe(
      true,
    );
    server.sockets[0]?.send(packet('session_keepalive', {}));
    await waitFor(() => client.snapshot().lastKeepalive !== null);
  });
  it('reconnects and resubscribes after missing keepalives', async () => {
    const server = await mockWebSocket((socket, _path, index) =>
      socket.send(welcome('session-' + index, 0.06)),
    );
    cleanup.push(server.close);
    const subscribe = vi.fn<
      (sessionId: string, subscription: EventSubscription) => Promise<void>
    >(async () => {});
    const client = new EventSubClient(plan, {
      url: server.url,
      retryDelayMs: 5,
      subscribe,
      onNotification: () => {},
    });
    cleanup.push(() => client.stop());
    client.start();
    await waitFor(() => subscribe.mock.calls.length >= 10);
    expect(server.sockets.length).toBeGreaterThanOrEqual(2);
  });
  it('allows initial subscription setup and keepalives at the interval boundary', async () => {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const server = await mockWebSocket((socket) => {
      socket.send(welcome('session-1', 0.08));
      timers.push(
        setTimeout(() => socket.send(packet('session_keepalive', {})), 105),
      );
      timers.push(
        setTimeout(() => socket.send(packet('session_keepalive', {})), 188),
      );
    });
    cleanup.push(server.close);
    cleanup.push(() => {
      timers.forEach(clearTimeout);
    });
    const client = new EventSubClient(plan, {
      url: server.url,
      retryDelayMs: 5,
      subscribe: async () => {
        await delay(35);
      },
      onNotification: () => {},
    });
    cleanup.push(() => client.stop());
    client.start();
    await waitFor(() => client.snapshot().lastKeepalive !== null);
    await delay(90);
    expect(server.sockets).toHaveLength(1);
    expect(client.snapshot().status).toBe('connected');
  });
  it('does not time out while keepalives continue to arrive', async () => {
    const server = await mockWebSocket((socket) =>
      socket.send(welcome('session-1', 0.12)),
    );
    cleanup.push(server.close);
    const client = new EventSubClient(plan, {
      url: server.url,
      retryDelayMs: 5,
      subscribe: async () => {},
      onNotification: () => {},
    });
    cleanup.push(() => client.stop());
    client.start();
    await waitFor(() => client.snapshot().status === 'connected');
    for (let index = 0; index < 3; index++) {
      await delay(45);
      server.sockets[0]?.send(packet('session_keepalive', {}));
    }
    expect(server.sockets).toHaveLength(1);
    await waitFor(() => server.sockets.length >= 2);
  });
  it('keeps the old socket until migration welcome, preserves subscriptions, and deduplicates across handover', async () => {
    const server = await mockWebSocket((socket, path) => {
      if (path === '/ws') socket.send(welcome());
    });
    cleanup.push(server.close);
    const subscribe = vi.fn<
      (sessionId: string, subscription: EventSubscription) => Promise<void>
    >(async () => {});
    const received = vi.fn();
    const client = new EventSubClient(plan, {
      url: server.url,
      subscribe,
      onNotification: received,
    });
    cleanup.push(() => client.stop());
    client.start();
    await waitFor(() => client.snapshot().status === 'connected');
    const first = server.sockets[0];
    first?.send(
      packet('session_reconnect', {
        session: {
          reconnect_url: server.url.replace('/ws', '/handover?ticket=private'),
        },
      }),
    );
    await waitFor(() => server.sockets.length === 2);
    expect(first?.readyState).toBe(1);
    first?.send(
      notification(
        'stream.online',
        { broadcaster_user_id: '1' },
        'same-delivery',
      ),
    );
    await waitFor(() => received.mock.calls.length === 1);
    server.sockets[1]?.send(welcome('replacement', null));
    await waitFor(() => first?.readyState === 3);
    server.sockets[1]?.send(
      notification(
        'stream.online',
        { broadcaster_user_id: '1' },
        'same-delivery',
      ),
    );
    await delay(20);
    expect(received).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(5);
    expect(client.snapshot().status).toBe('connected');
  });
  it('reports revocation and ignores invalid JSON and foreign subscription conditions', async () => {
    const server = await mockWebSocket();
    cleanup.push(server.close);
    const notice = vi.fn();
    const received = vi.fn();
    const client = new EventSubClient(plan, {
      url: server.url,
      subscribe: async () => {},
      onNotification: received,
      onNotice: notice,
    });
    cleanup.push(() => client.stop());
    client.start();
    await waitFor(() => client.snapshot().status === 'connected');
    const socket = server.sockets[0];
    socket?.send('broken-json');
    socket?.send(
      packet('notification', {
        subscription: {
          type: 'stream.online',
          version: '1',
          condition: { broadcaster_user_id: 'another-channel' },
        },
        event: { broadcaster_user_id: 'another-channel' },
      }),
    );
    socket?.send(
      packet('revocation', {
        subscription: {
          type: 'channel.chat.message',
          status: 'authorization_revoked',
        },
      }),
    );
    await waitFor(() => client.snapshot().status === 'degraded');
    expect(received).not.toHaveBeenCalled();
    expect(
      client
        .snapshot()
        .subscriptions.find((entry) => entry.type === 'channel.chat.message')
        ?.status,
    ).toBe('revoked');
    expect(
      notice.mock.calls.some(([type]) => type === 'eventsub.revoked'),
    ).toBe(true);
  });
  it('retries a missing welcome, then stops without reconnecting after shutdown', async () => {
    const server = await mockWebSocket(() => {});
    cleanup.push(server.close);
    const client = new EventSubClient(plan, {
      url: server.url,
      retryDelayMs: 5,
      welcomeTimeoutMs: 30,
      subscribe: async () => {},
      onNotification: () => {},
    });
    cleanup.push(() => client.stop());
    client.start();
    await waitFor(() => server.sockets.length >= 2);
    client.stop();
    const count = server.sockets.length;
    await delay(70);
    expect(server.sockets).toHaveLength(count);
  });
  it('rejects reconnect URLs on a different host and recovers on the configured endpoint', async () => {
    const server = await mockWebSocket();
    cleanup.push(server.close);
    const client = new EventSubClient(plan, {
      url: server.url,
      retryDelayMs: 5,
      subscribe: async () => {},
      onNotification: () => {},
    });
    cleanup.push(() => client.stop());
    client.start();
    await waitFor(() => client.snapshot().status === 'connected');
    server.sockets[0]?.send(
      packet('session_reconnect', {
        session: { reconnect_url: 'wss://untrusted.invalid/ws' },
      }),
    );
    await waitFor(() => server.sockets.length >= 2);
  });
});
describe('EventSub plans and dedupe', () => {
  it('keeps broadcaster and separate bot subscription users isolated', () => {
    const broadcaster = subscriptionPlan('1', '1', true, false);
    const bot = subscriptionPlan('1', '2', false, true);
    expect(broadcaster.map((entry) => entry.type)).toEqual([
      'stream.online',
      'stream.offline',
      'channel.update',
      'channel.follow',
    ]);
    expect(broadcaster[3]?.condition).toEqual({
      broadcaster_user_id: '1',
      moderator_user_id: '1',
    });
    expect(bot).toEqual([
      {
        type: 'channel.chat.message',
        version: '1',
        condition: { broadcaster_user_id: '1', user_id: '2' },
      },
    ]);
  });
  it('expires old IDs and bounds the dedupe cache', () => {
    let now = 0;
    const cache = new MessageDedupe(() => now, 50, 2);
    expect(cache.seen('one')).toBe(false);
    expect(cache.seen('one')).toBe(true);
    now = 51;
    expect(cache.seen('one')).toBe(false);
    expect(cache.seen('two')).toBe(false);
    expect(cache.seen('three')).toBe(false);
    expect(cache.seen('one')).toBe(false);
  });
});
