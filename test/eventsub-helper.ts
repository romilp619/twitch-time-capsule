import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';

export async function waitFor(
  condition: () => boolean,
  timeout = 2500,
): Promise<void> {
  const end = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= end)
      throw new Error('Timed out waiting for test condition.');
    await delay(5);
  }
}
export function packet(
  type: string,
  payload: unknown,
  id: string = randomUUID(),
): string {
  return JSON.stringify({
    metadata: {
      message_type: type,
      message_id: id,
      message_timestamp: new Date().toISOString(),
    },
    payload,
  });
}
export function welcome(id = 'session-1', timeout: number | null = 1): string {
  return packet('session_welcome', {
    session: { id, keepalive_timeout_seconds: timeout },
  });
}
export function notification(
  type: string,
  event: unknown,
  id: string = randomUUID(),
  userId = '1',
): string {
  const condition: Record<string, string> = { broadcaster_user_id: '1' };
  if (type === 'channel.chat.message') condition.user_id = userId;
  if (type === 'channel.follow') condition.moderator_user_id = '1';
  const version =
    type === 'channel.update' || type === 'channel.follow' ? '2' : '1';
  return packet(
    'notification',
    { subscription: { type, version, condition }, event },
    id,
  );
}
export async function mockWebSocket(
  onConnection?: (socket: WebSocket, path: string, index: number) => void,
) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const sockets: WebSocket[] = [];
  server.on('connection', (socket, request) => {
    sockets.push(socket);
    socket.on('error', () => {});
    if (onConnection) onConnection(socket, request.url ?? '/', sockets.length);
    else socket.send(welcome('session-' + sockets.length));
  });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected test port.');
  return {
    url: 'ws://127.0.0.1:' + address.port + '/ws',
    sockets,
    close: async () => {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
export function chatEvent(
  text: string,
  userId = 'viewer',
  id: string = randomUUID(),
) {
  return {
    broadcaster_user_id: '1',
    chatter_user_id: userId,
    chatter_user_login: userId,
    chatter_user_name: userId,
    message_id: id,
    message: { text },
    badges: [],
  };
}
