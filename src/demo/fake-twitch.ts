import { randomUUID } from 'node:crypto';
import { scopes } from '../twitch/auth.js';
import type { TwitchFetch } from '../twitch/http.js';
export const demoChannel = {
  id: '10001',
  login: 'capsule_demo',
  displayName: 'Capsule Demo',
};
export const demoCategory = { id: 'demo-gta-vi', name: 'Grand Theft Auto VI' };
// IDs are synthetic digits, never a claim about Twitch's real category catalog.
export const demoCategoryId = '900000001';
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
export class FakeTwitch {
  live = false;
  followers = 812;
  categoryId = '900000000';
  categoryName = 'Just Chatting';
  readonly vips = new Set<string>();
  readonly deleted = new Set<string>();
  readonly messages: Array<{ id: string; text: string; at: string }> = [];
  constructor(private readonly now: () => number = Date.now) {}
  resetFacts(): void {
    this.live = false;
    this.followers = 812;
    this.categoryId = '900000000';
    this.categoryName = 'Just Chatting';
  }
  readonly fetch: TwitchFetch = async (input, init) => {
    const url = new URL(String(input));
    if (!['https://id.twitch.tv', 'https://api.twitch.tv'].includes(url.origin))
      throw new Error('Demo network access is disabled.');
    if (url.pathname === '/oauth2/token')
      return json({
        access_token: 'demo-only-access',
        refresh_token: 'demo-only-refresh',
        expires_in: 3600,
        scope: scopes.streamer,
      });
    if (url.pathname === '/oauth2/validate')
      return json({
        client_id: 'demo-only-client',
        user_id: demoChannel.id,
        login: demoChannel.login,
        scopes: scopes.streamer,
        expires_in: 3600,
      });
    const headers = new Headers(init?.headers);
    if (
      headers.get('Authorization') !== 'Bearer demo-only-access' ||
      headers.get('Client-Id') !== 'demo-only-client'
    )
      return json({}, 401);
    if (url.pathname === '/helix/users')
      return json({
        data: [
          {
            id: demoChannel.id,
            login: demoChannel.login,
            display_name: demoChannel.displayName,
          },
        ],
      });
    if (url.pathname === '/helix/streams')
      return json({ data: this.live ? [{ id: 'demo-stream' }] : [] });
    if (url.pathname === '/helix/channels/followers')
      return json({ total: this.followers });
    if (url.pathname === '/helix/channels')
      return json({
        data: [
          {
            broadcaster_id: demoChannel.id,
            game_id: this.categoryId,
            game_name: this.categoryName,
          },
        ],
      });
    if (url.pathname === '/helix/moderation/moderators')
      return json({ data: [] });
    if (url.pathname === '/helix/search/categories')
      return json({
        data: [
          { id: demoCategoryId, name: demoCategory.name },
          { id: '900000000', name: 'Just Chatting' },
        ],
      });
    if (
      url.pathname === '/helix/moderation/chat' &&
      init?.method === 'DELETE'
    ) {
      const message = url.searchParams.get('message_id');
      if (!message) return json({}, 400);
      this.deleted.add(message);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/helix/chat/messages' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as {
        message?: string;
        broadcaster_id?: string;
        sender_id?: string;
      };
      if (
        body.broadcaster_id !== demoChannel.id ||
        body.sender_id !== demoChannel.id ||
        typeof body.message !== 'string'
      )
        return json({}, 400);
      const id = randomUUID();
      this.messages.push({
        id,
        text: body.message,
        at: new Date(this.now()).toISOString(),
      });
      if (this.messages.length > 50) this.messages.shift();
      return json({ data: [{ message_id: id, is_sent: true }] });
    }
    if (url.pathname === '/helix/channels/vips') {
      const user = url.searchParams.get('user_id');
      if (url.searchParams.get('broadcaster_id') !== demoChannel.id || !user)
        return json({}, 400);
      if (!init?.method || init.method === 'GET')
        return json({
          data: this.vips.has(user)
            ? [
                {
                  user_id: user,
                  user_name: 'Demo viewer',
                  user_login: 'demo_viewer',
                },
              ]
            : [],
        });
      if (init.method === 'POST') {
        if (this.vips.has(user)) return json({}, 422);
        this.vips.add(user);
      } else if (init.method === 'DELETE') {
        if (!this.vips.delete(user)) return json({}, 422);
      } else return json({}, 400);
      return new Response(null, { status: 204 });
    }
    throw new Error('Unexpected demo Twitch endpoint. No request was sent.');
  };
}
