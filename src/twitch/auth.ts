import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import {
  readJson,
  safeFetch,
  safeMessage,
  TwitchError,
  type TwitchFetch,
} from './http.js';

export const roles = ['streamer', 'bot'] as const;
export type AccountRole = (typeof roles)[number];
export const scopes: Record<AccountRole, readonly string[]> = {
  streamer: [
    'channel:manage:vips',
    'moderator:read:followers',
    'moderation:read',
    'user:read:chat',
    'user:write:chat',
    'moderator:manage:chat_messages',
  ],
  bot: ['user:read:chat', 'user:write:chat', 'moderator:manage:chat_messages'],
};
const tokenSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  userId: z.string().min(1),
  login: z.string().min(1),
  displayName: z.string().min(1),
  scopes: z.array(z.string()),
  expiresAt: z.number().finite(),
  validatedAt: z.number().finite(),
});
export type TokenRecord = z.infer<typeof tokenSchema>;
const fileSchema = z.object({
  version: z.literal(1),
  accounts: z.object({
    streamer: tokenSchema.optional(),
    bot: tokenSchema.optional(),
  }),
});
const grantSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  scope: z.array(z.string()),
});
const validationSchema = z.object({
  client_id: z.string(),
  user_id: z.string().min(1),
  login: z.string().min(1),
  scopes: z.array(z.string()),
  expires_in: z.number().int().nonnegative(),
});
type Validation = z.infer<typeof validationSchema>;
export function constantEqual(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class TokenStore {
  private accounts: Partial<Record<AccountRole, TokenRecord | undefined>> = {};
  private readonly path: string;
  constructor(dataDir: string) {
    this.path = resolve(dataDir, 'tokens.json');
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return;
      // eslint-disable-next-line preserve-caught-error -- Never attach private filesystem or token details to errors.
      throw new Error('Cannot read data/tokens.json. Check file permissions.');
    }
    try {
      this.accounts = fileSchema.parse(JSON.parse(raw) as unknown).accounts;
      chmodSync(this.path, 0o600);
    } catch {
      throw new Error(
        'Cannot read data/tokens.json. Restore the private token file or remove it and reconnect your accounts.',
      );
    }
  }
  get(role: AccountRole): TokenRecord | undefined {
    return this.accounts[role];
  }
  set(role: AccountRole, token: TokenRecord | undefined): void {
    const next = { ...this.accounts };
    if (token) next[role] = token;
    else delete next[role];
    const temp = this.path + '.' + randomBytes(8).toString('hex') + '.tmp';
    try {
      writeFileSync(
        temp,
        JSON.stringify({ version: 1, accounts: next }, null, 2) + '\n',
        { mode: 0o600, flag: 'wx' },
      );
      renameSync(temp, this.path);
      this.accounts = next;
    } catch {
      throw new Error(
        'Cannot save Twitch tokens. Check data directory permissions.',
      );
    } finally {
      rmSync(temp, { force: true });
    }
  }
}
interface PendingState {
  role: AccountRole;
  binding: string;
  expiresAt: number;
}
export interface PublicAccount {
  status: 'disconnected' | 'checking' | 'connected' | 'error';
  userId: string | null;
  login: string | null;
  displayName: string | null;
  scopes: string[];
  expiresAt: string | null;
  validatedAt: string | null;
  error: string | null;
}

export class TwitchAuth {
  readonly store: TokenStore;
  readonly controller = new AbortController();
  private readonly states = new Map<string, PendingState>();
  private readonly refreshes = new Map<AccountRole, Promise<TokenRecord>>();
  private readonly verified = new Set<AccountRole>();
  private readonly errors = new Map<AccountRole, string>();
  constructor(
    readonly config: AppConfig,
    private readonly fetcher: TwitchFetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.store = new TokenStore(config.dataDir);
  }
  get configured(): boolean {
    return Boolean(
      this.config.twitchClientId && this.config.twitchClientSecret,
    );
  }
  effectiveRole(role: AccountRole): AccountRole {
    return role === 'bot' && !this.store.get('bot') ? 'streamer' : role;
  }
  begin(role: AccountRole) {
    if (!this.configured)
      throw new TwitchError(
        503,
        'Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env, then restart the server.',
      );
    for (const [key, entry] of this.states)
      if (entry.expiresAt <= this.now()) this.states.delete(key);
    if (this.states.size >= 32)
      throw new TwitchError(
        429,
        'Too many pending connections. Wait ten minutes and try again.',
      );
    const state = randomBytes(32).toString('hex');
    const binding = randomBytes(32).toString('hex');
    this.states.set(state, {
      role,
      binding,
      expiresAt: this.now() + 10 * 60_000,
    });
    const url = new URL('https://id.twitch.tv/oauth2/authorize');
    url.search = new URLSearchParams({
      client_id: this.config.twitchClientId ?? '',
      redirect_uri: this.config.twitchRedirectUri,
      response_type: 'code',
      scope: scopes[role].join(' '),
      state,
      force_verify: 'true',
    }).toString();
    return {
      url: url.toString(),
      state,
      binding,
      cookieName: this.cookieName(state),
    };
  }
  cookieName(state: string): string {
    return 'tc_oauth_' + state.slice(0, 16);
  }
  consumeState(state: string, binding: string): AccountRole {
    const entry = this.states.get(state);
    this.states.delete(state);
    if (
      !entry ||
      entry.expiresAt <= this.now() ||
      !constantEqual(binding, entry.binding)
    )
      throw new TwitchError(
        400,
        'This connection link expired or belongs to another browser. Start again from the dashboard.',
      );
    return entry.role;
  }
  private async validate(
    accessToken: string,
    role: AccountRole,
  ): Promise<Validation> {
    const response = await safeFetch(
      this.fetcher,
      'https://id.twitch.tv/oauth2/validate',
      { headers: { Authorization: 'OAuth ' + accessToken } },
      this.controller.signal,
    );
    if (!response.ok)
      throw new TwitchError(
        response.status,
        response.status === 401
          ? 'Twitch authorization expired. Reconnect this account.'
          : 'Twitch token validation is unavailable. Please try again.',
      );
    const info = await readJson(response, validationSchema);
    if (
      info.client_id !== this.config.twitchClientId ||
      !scopes[role].every((scope) => info.scopes.includes(scope))
    )
      throw new TwitchError(
        403,
        'The Twitch account is missing required permissions or belongs to a different app. Reconnect it.',
      );
    return info;
  }
  private record(
    grant: z.infer<typeof grantSchema>,
    info: Validation,
  ): TokenRecord {
    return {
      accessToken: grant.access_token,
      refreshToken: grant.refresh_token,
      userId: info.user_id,
      login: info.login,
      displayName: info.login,
      scopes: info.scopes,
      expiresAt: this.now() + info.expires_in * 1000,
      validatedAt: this.now(),
    };
  }
  private async grant(parameters: Record<string, string>) {
    const response = await safeFetch(
      this.fetcher,
      'https://id.twitch.tv/oauth2/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.config.twitchClientId ?? '',
          client_secret: this.config.twitchClientSecret ?? '',
          ...parameters,
        }),
      },
      this.controller.signal,
    );
    if (!response.ok)
      throw new TwitchError(
        response.status,
        [400, 401].includes(response.status)
          ? 'Twitch authorization could not be renewed. Reconnect this account.'
          : 'Twitch authorization is temporarily unavailable. Please try again.',
      );
    return readJson(response, grantSchema);
  }
  async connect(role: AccountRole, code: string): Promise<void> {
    const grant = await this.grant({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.twitchRedirectUri,
    });
    const info = await this.validate(grant.access_token, role);
    const other = this.store.get(role === 'bot' ? 'streamer' : 'bot');
    if (other?.userId === info.user_id)
      throw new TwitchError(
        400,
        'Streamer and bot must be different accounts. For single-account mode, disconnect the separate bot and connect only the streamer.',
      );
    this.store.set(role, this.record(grant, info));
    this.verified.add(role);
    this.errors.delete(role);
  }
  disconnect(role: AccountRole): void {
    this.store.set(role, undefined);
    this.verified.delete(role);
    this.errors.delete(role);
  }
  invalidate(role: AccountRole, message: string): void {
    this.disconnect(role);
    this.errors.set(role, message);
  }
  async refresh(
    role: AccountRole,
    failedAccessToken?: string,
  ): Promise<TokenRecord> {
    const current = this.store.get(role);
    if (!current)
      throw new TwitchError(
        401,
        'Connect this Twitch account in the dashboard.',
      );
    if (failedAccessToken && current.accessToken !== failedAccessToken)
      return current;
    const pending = this.refreshes.get(role);
    if (pending) return pending;
    const operation = this.performRefresh(role, current);
    this.refreshes.set(role, operation);
    try {
      return await operation;
    } finally {
      this.refreshes.delete(role);
    }
  }
  private async performRefresh(
    role: AccountRole,
    previous: TokenRecord,
  ): Promise<TokenRecord> {
    try {
      const grant = await this.grant({
        grant_type: 'refresh_token',
        refresh_token: previous.refreshToken,
      });
      const info = await this.validate(grant.access_token, role);
      if (info.user_id !== previous.userId)
        throw new TwitchError(
          403,
          'Twitch returned a different account. Reconnect this account.',
        );
      const current = this.store.get(role);
      if (!current || current.accessToken !== previous.accessToken)
        throw new TwitchError(
          409,
          'Account changed during refresh. Please try again.',
        );
      const next = {
        ...this.record(grant, info),
        displayName: current.displayName,
      };
      this.store.set(role, next);
      this.verified.add(role);
      this.errors.delete(role);
      return next;
    } catch (error) {
      if (
        this.store.get(role)?.accessToken === previous.accessToken &&
        error instanceof TwitchError &&
        [400, 401, 403].includes(error.status)
      )
        this.invalidate(
          role,
          'Authorization was revoked or expired. Reconnect this account.',
        );
      throw error;
    }
  }
  async validateAll(): Promise<void> {
    for (const role of roles) {
      const token = this.store.get(role);
      if (!token) continue;
      try {
        let info: Validation;
        try {
          info = await this.validate(token.accessToken, role);
        } catch (error) {
          if (error instanceof TwitchError && error.status === 401) {
            await this.refresh(role, token.accessToken);
            continue;
          }
          throw error;
        }
        if (info.user_id !== token.userId)
          throw new TwitchError(
            403,
            'Twitch account identity changed. Reconnect this account.',
          );
        if (this.store.get(role)?.accessToken !== token.accessToken) continue;
        this.store.set(role, {
          ...token,
          login: info.login,
          scopes: info.scopes,
          validatedAt: this.now(),
          expiresAt: this.now() + info.expires_in * 1000,
        });
        this.verified.add(role);
        this.errors.delete(role);
        if (info.expires_in <= 60) await this.refresh(role);
      } catch (error) {
        if (this.store.get(role)?.accessToken !== token.accessToken) continue;
        if (error instanceof TwitchError && [401, 403].includes(error.status))
          this.invalidate(role, safeMessage(error));
        else {
          this.verified.delete(role);
          this.errors.set(role, safeMessage(error));
        }
      }
    }
  }
  async accessToken(
    requestedRole: AccountRole,
  ): Promise<{ role: AccountRole; token: string }> {
    const role = this.effectiveRole(requestedRole);
    const token = this.store.get(role);
    if (!token || !this.verified.has(role))
      throw new TwitchError(
        401,
        'Validate or reconnect this Twitch account in the dashboard.',
      );
    const current =
      token.expiresAt <= this.now() + 60_000 ? await this.refresh(role) : token;
    return { role, token: current.accessToken };
  }
  updateUser(
    role: AccountRole,
    user: { id: string; login: string; display_name: string },
  ): void {
    const current = this.store.get(role);
    if (current && current.userId === user.id)
      this.store.set(role, {
        ...current,
        login: user.login,
        displayName: user.display_name,
      });
  }
  publicAccount(role: AccountRole): PublicAccount {
    const token = this.store.get(role);
    const error = this.errors.get(role) ?? null;
    return {
      status: error
        ? 'error'
        : !token
          ? 'disconnected'
          : this.verified.has(role)
            ? 'connected'
            : 'checking',
      userId: token?.userId ?? null,
      login: token?.login ?? null,
      displayName: token?.displayName ?? null,
      scopes: token?.scopes ?? [],
      expiresAt: token ? new Date(token.expiresAt).toISOString() : null,
      validatedAt: token ? new Date(token.validatedAt).toISOString() : null,
      error,
    };
  }
  close(): void {
    this.controller.abort();
    this.states.clear();
  }
}
