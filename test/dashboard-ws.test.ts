import { once } from 'node:events';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { TwitchAuth } from '../src/twitch/auth.js';
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
async function listen(realRuntime = false) {
  const twitch = await mockWebSocket();
  cleanup.push(twitch.close);
  const project = twitchProject();
  cleanup.push(project.cleanup);
  const fake = new FakeTwitch();
  if (realRuntime) {
    const auth = new TwitchAuth(project.config, fake.fetch);
    await auth.connect('streamer', 'streamer-code');
    auth.close();
  }
  const app = buildServer(project.config, {
    fetcher: fake.fetch,
    eventsubEnabled: realRuntime,
    eventsubOptions: { url: twitch.url, retryDelayMs: 5 },
  });
  cleanup.push(() => app.close());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected HTTP port.');
  return {
    ...project,
    app,
    fake,
    twitch,
    url: 'ws://127.0.0.1:' + address.port + '/ws/dashboard',
  };
}
function rejected(url: string, origin: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Origin: origin } });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('Upgrade did not fail'));
    }, 2000);
    socket.on('error', () => {});
    socket.on('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      response.resume();
      socket.terminate();
      resolve(response.statusCode ?? 0);
    });
  });
}
describe('Dashboard WebSocket authorization and updates', () => {
  it('requires the admin key and the configured browser origin', async () => {
    const { config, url, app } = await listen();
    expect(await rejected(url, config.baseUrl)).toBe(401);
    expect(
      await rejected(
        url + '?key=' + config.adminKey,
        'https://untrusted.example',
      ),
    ).toBe(403);
    const socket = new WebSocket(url + '?key=' + config.adminKey, {
      headers: { Origin: config.baseUrl },
    });
    cleanup.push(() => socket.terminate());
    const [data] = await once(socket, 'message');
    const snapshot = JSON.parse(String(data)) as {
      type: string;
      events: unknown[];
    };
    expect(snapshot.type).toBe('snapshot');
    expect(snapshot.events).toEqual([]);
    expect((await app.inject('/api/events')).statusCode).toBe(401);
  });
  it('sends the current snapshot and live chat log while omitting private seal contents', async () => {
    const { config, url, fake, twitch } = await listen(true);
    const socket = new WebSocket(url + '?key=' + config.adminKey, {
      headers: { Origin: config.baseUrl },
    });
    cleanup.push(() => socket.terminate());
    const packets: Array<{
      type: string;
      events: Array<{ type: string; payload: { text?: string } }>;
    }> = [];
    socket.on('message', (data) =>
      packets.push(JSON.parse(data.toString()) as (typeof packets)[number]),
    );
    await waitFor(() => fake.subscriptions.length === 5 && packets.length > 0);
    twitch.sockets[0]?.send(
      notification('channel.chat.message', chatEvent('hello from a viewer')),
    );
    await waitFor(() =>
      packets.some((packet) =>
        packet.events.some(
          (entry) => entry.payload.text === 'hello from a viewer',
        ),
      ),
    );
    twitch.sockets[0]?.send(
      notification(
        'channel.chat.message',
        chatEvent('!seal do-not-display-this'),
      ),
    );
    await waitFor(() =>
      packets.some((packet) =>
        packet.events.some(
          (entry) => entry.payload.text === '[seal text omitted]',
        ),
      ),
    );
    expect(JSON.stringify(packets)).not.toContain('do-not-display-this');
    expect(JSON.stringify(packets)).not.toContain('streamer-access');
    expect(JSON.stringify(packets)).not.toContain('streamer-refresh');
  });
});
