import { vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { scopes, type AccountRole } from '../src/twitch/auth.js';
import { temporaryProject } from './helpers.js';
export function twitchProject() {
  const project = temporaryProject();
  return {
    ...project,
    config: loadConfig(
      {
        LOG_LEVEL: 'silent',
        TWITCH_CLIENT_ID: 'client-id',
        TWITCH_CLIENT_SECRET: 'private-client-secret',
      },
      project.root,
    ),
  };
}
export function json(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
export class FakeTwitch {
  isMod = false;
  dropMessages = false;
  deleteStatus = 204;
  deletedMessages: Array<{
    broadcaster_id: string | null;
    moderator_id: string | null;
    message_id: string | null;
  }> = [];

  sentMessages: Array<{
    broadcaster_id: string;
    sender_id: string;
    message: string;
  }> = [];
  subscriptions: Array<{
    role: string;
    body: {
      type: string;
      version: string;
      condition: Record<string, string>;
      transport: { method: string; session_id: string };
    };
  }> = [];

  live = false;
  followers = 0;
  categoryId = '32982';
  categoryName = 'Grand Theft Auto V';
  invalidAccess = new Set<string>();
  refreshStatus = 200;
  validationStatus = 200;
  validationClient = 'client-id';
  missingScope = false;
  expiresIn = 3600;
  userName = 'Streamer Name';
  refreshes = 0;
  fetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (url.pathname === '/oauth2/token') {
      const body = new URLSearchParams(String(init?.body));
      const role: AccountRole = (
        body.get('code') ??
        body.get('refresh_token') ??
        ''
      ).startsWith('bot')
        ? 'bot'
        : 'streamer';
      const refreshing = body.get('grant_type') === 'refresh_token';
      if (refreshing) this.refreshes++;
      if (refreshing && this.refreshStatus !== 200)
        return json({ message: 'private-provider-token' }, this.refreshStatus);
      return json({
        access_token: role + (refreshing ? '-renewed' : '-access'),
        refresh_token:
          role + (refreshing ? '-rotated-refresh+/%' : '-refresh+/%'),
        expires_in: 3600,
        scope: scopes[role],
      });
    }
    const authorization = headers.get('Authorization') ?? '';
    const role: AccountRole = authorization.includes('bot-')
      ? 'bot'
      : 'streamer';
    const userId = role === 'bot' ? '2' : '1';
    if (url.pathname === '/oauth2/validate') {
      if (this.validationStatus !== 200)
        return json(
          { message: 'private-provider-token' },
          this.validationStatus,
        );
      if (this.invalidAccess.has(authorization.replace('OAuth ', '')))
        return json({}, 401);
      return json({
        client_id: this.validationClient,
        user_id: userId,
        login: role,
        scopes: this.missingScope ? [] : scopes[role],
        expires_in: this.expiresIn,
      });
    }
    if (
      url.pathname === '/helix/moderation/chat' &&
      init?.method === 'DELETE'
    ) {
      this.deletedMessages.push({
        broadcaster_id: url.searchParams.get('broadcaster_id'),
        moderator_id: url.searchParams.get('moderator_id'),
        message_id: url.searchParams.get('message_id'),
      });
      return this.deleteStatus === 204
        ? new Response(null, { status: 204 })
        : json({ message: 'provider detail' }, this.deleteStatus);
    }
    if (url.pathname === '/helix/search/categories')
      return json({
        data: [
          {
            id: '32982',
            name: 'Grand Theft Auto V',
            box_art_url: 'https://example.invalid/art',
          },
        ],
      });
    if (url.pathname === '/helix/eventsub/subscriptions') {
      const body = JSON.parse(String(init?.body)) as {
        type: string;
        version: string;
        condition: Record<string, string>;
        transport: { method: string; session_id: string };
      };
      this.subscriptions.push({ role, body });
      return json(
        {
          data: [
            {
              ...body,
              id: 'subscription-' + this.subscriptions.length,
              status: 'enabled',
            },
          ],
        },
        202,
      );
    }
    if (url.pathname === '/helix/chat/messages') {
      const body = JSON.parse(String(init?.body)) as {
        broadcaster_id: string;
        sender_id: string;
        message: string;
      };
      if (body.sender_id !== userId) return json({}, 401);
      this.sentMessages.push(body);
      return json({
        data: [
          {
            message_id: 'reply-' + this.sentMessages.length,
            is_sent: !this.dropMessages,
          },
        ],
      });
    }
    if (url.pathname === '/helix/users')
      return json({
        data: [
          {
            id: userId,
            login: role,
            display_name: role === 'bot' ? 'Capsule Bot' : this.userName,
          },
        ],
      });
    if (url.pathname === '/helix/moderation/moderators')
      return json({ data: this.isMod ? [{ user_id: '2' }] : [] });
    if (url.pathname === '/helix/channels/followers')
      return json({ total: this.followers, data: [], pagination: {} });
    if (url.pathname === '/helix/channels')
      return json({
        data: [
          {
            broadcaster_id: '1',
            game_id: this.categoryId,
            game_name: this.categoryName,
          },
        ],
      });
    if (url.pathname === '/helix/streams')
      return json({ data: this.live ? [{ id: 'live-stream' }] : [] });
    throw new Error('Unexpected fake Twitch route');
  });
}
