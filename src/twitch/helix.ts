import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { TwitchAuth, type AccountRole } from './auth.js';
import { readJson, safeFetch, TwitchError, type TwitchFetch } from './http.js';
export const userSchema = z.object({
  id: z.string(),
  login: z.string(),
  display_name: z.string(),
});
const usersSchema = z.object({ data: z.array(userSchema) });
const moderatorsSchema = z.object({
  data: z.array(z.object({ user_id: z.string() })),
});
const streamsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });
export type TwitchUser = z.infer<typeof userSchema>;
interface RequestOptions {
  expectedUserId?: string;
  method?: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  query?: Record<string, string>;
  body?: unknown;
}
type Sleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;
export class HelixClient {
  constructor(
    private readonly auth: TwitchAuth,
    private readonly fetcher: TwitchFetch = fetch,
    private readonly sleep: Sleep = async (milliseconds, signal) => {
      await delay(milliseconds, undefined, { signal });
    },
    private readonly now: () => number = Date.now,
  ) {}
  async request<T>(
    role: AccountRole,
    path: string,
    schema: z.ZodType<T>,
    options: RequestOptions = {},
  ): Promise<T> {
    if (!/^\/[a-z0-9/]+$/.test(path))
      throw new TwitchError(400, 'Invalid Twitch API path.');
    const url = new URL('https://api.twitch.tv/helix' + path);
    url.search = new URLSearchParams(options.query).toString();
    let credential = await this.auth.accessToken(role);
    let refreshed = false;
    let retries = 0;
    while (true) {
      if (
        options.expectedUserId &&
        this.auth.store.get(credential.role)?.userId !== options.expectedUserId
      )
        throw new TwitchError(
          409,
          'The connected Twitch account changed. Recheck the dashboard.',
        );

      const response = await safeFetch(
        this.fetcher,
        url,
        {
          method: options.method ?? 'GET',
          headers: {
            Authorization: 'Bearer ' + credential.token,
            'Client-Id': this.auth.config.twitchClientId ?? '',
            ...(options.body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
          },
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
        },
        this.auth.controller.signal,
      );
      if (response.status === 401 && !refreshed) {
        const token = await this.auth.refresh(
          credential.role,
          credential.token,
        );
        credential = { role: credential.role, token: token.accessToken };
        refreshed = true;
        continue;
      }
      if (response.status === 429 && retries < 2) {
        const reset = Number(response.headers.get('Ratelimit-Reset'));
        const wait =
          Number.isFinite(reset) && reset > 0
            ? Math.max(1000, reset * 1000 - this.now() + 100)
            : 1000;
        if (wait > 60_000)
          throw new TwitchError(
            429,
            'Twitch rate limit reached. Wait for the limit to reset and check again.',
          );
        retries++;
        try {
          await this.sleep(wait, this.auth.controller.signal);
        } catch {
          throw new TwitchError(0, 'Twitch request was cancelled.');
        }
        continue;
      }
      if (!response.ok) {
        if (
          response.status === 401 &&
          this.auth.store.get(credential.role)?.accessToken === credential.token
        )
          this.auth.invalidate(
            credential.role,
            'Twitch rejected this authorization. Reconnect the account.',
          );
        const message =
          response.status === 401
            ? 'Reconnect this Twitch account.'
            : response.status === 403
              ? 'Twitch denied permission. Reconnect the account and approve all requested scopes.'
              : response.status === 429
                ? 'Twitch rate limit reached. Please try again later.'
                : 'Twitch API request failed. Please try again.';
        throw new TwitchError(response.status, message);
      }
      if (response.status === 204) return schema.parse(undefined);
      return readJson(response, schema);
    }
  }
  async currentUser(role: AccountRole): Promise<TwitchUser> {
    const result = await this.request(role, '/users', usersSchema);
    const user = result.data[0];
    if (!user)
      throw new TwitchError(502, 'Twitch did not return the connected user.');
    return user;
  }
  async userByLogin(
    role: AccountRole,
    login: string,
  ): Promise<TwitchUser | undefined> {
    return (
      await this.request(role, '/users', usersSchema, { query: { login } })
    ).data[0];
  }
  async isModerator(broadcasterId: string, userId: string): Promise<boolean> {
    const result = await this.request(
      'streamer',
      '/moderation/moderators',
      moderatorsSchema,
      {
        query: { broadcaster_id: broadcasterId, user_id: userId },
      },
    );
    return result.data.some((entry) => entry.user_id === userId);
  }
  async isLive(broadcasterId: string): Promise<boolean> {
    return (
      (
        await this.request('streamer', '/streams', streamsSchema, {
          query: { user_id: broadcasterId },
        })
      ).data.length > 0
    );
  }
}
