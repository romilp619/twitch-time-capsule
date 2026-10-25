import { TwitchAuth, roles } from './auth.js';
import { HelixClient } from './helix.js';
import type { TwitchRuntime } from './runtime.js';
import { safeMessage } from './http.js';
export class TwitchConnection {
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> | undefined;
  private moderator: {
    state: 'unknown' | 'yes' | 'no' | 'error';
    message: string;
  } = {
    state: 'unknown',
    message: 'Connect the streamer to check chat moderation.',
  };
  private live: boolean | null = null;
  private checkedAt: string | null = null;
  private warnings: string[] = [];
  private callbackNotice: string | null = null;
  constructor(
    readonly auth: TwitchAuth,
    readonly helix: HelixClient,
    private readonly events?: TwitchRuntime,
  ) {}
  snapshot() {
    const streamer = this.auth.publicAccount('streamer');
    const bot = this.auth.publicAccount('bot');
    const singleAccount = !this.auth.store.get('bot');
    return {
      configured: this.auth.configured,
      streamer,
      bot,
      singleAccount,
      effectiveBot: singleAccount ? streamer : bot,
      moderator: this.moderator,
      live: this.live,
      checkedAt: this.checkedAt,
      refreshing: Boolean(this.pending),
      warnings: [
        ...this.warnings,
        ...(this.callbackNotice ? [this.callbackNotice] : []),
      ],
      eventsub: this.events?.snapshot() ?? {
        status: 'disconnected',
        connections: [],
        warnings: [],
        subscriptions: [],
        lastKeepalive: null,
      },
    };
  }
  notice(message: string | null): void {
    this.callbackNotice = message;
  }
  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, 60 * 60_000);
    this.timer.unref();
  }
  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    const operation = this.performRefresh()
      .then(() => this.events?.sync())
      .catch((error: unknown) => {
        this.warnings = [safeMessage(error)];
      });
    this.pending = operation;
    void operation.finally(() => {
      if (this.pending === operation) this.pending = undefined;
    });
    return operation;
  }
  private async performRefresh(): Promise<void> {
    this.warnings = [];
    this.live = null;
    this.moderator = {
      state: 'unknown',
      message: 'Connect the streamer to check chat moderation.',
    };
    if (!this.auth.configured) {
      this.warnings.push(
        'Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to .env and restart to connect Twitch.',
      );
      this.checkedAt = new Date().toISOString();
      return;
    }
    await this.auth.validateAll();
    for (const role of roles) {
      if (this.auth.publicAccount(role).status !== 'connected') continue;
      try {
        this.auth.updateUser(role, await this.helix.currentUser(role));
      } catch (error) {
        this.warnings.push(safeMessage(error));
      }
    }
    const streamer = this.auth.publicAccount('streamer');
    const effectiveBot = this.auth.publicAccount(
      this.auth.effectiveRole('bot'),
    );
    if (streamer.status === 'connected' && streamer.userId) {
      try {
        this.live = await this.helix.isLive(streamer.userId);
      } catch (error) {
        this.warnings.push(safeMessage(error));
      }
      if (effectiveBot.status === 'connected' && effectiveBot.userId) {
        if (effectiveBot.userId === streamer.userId) {
          this.moderator = {
            state: 'yes',
            message:
              'Single-account mode: the broadcaster can moderate this channel.',
          };
        } else {
          try {
            const isMod = await this.helix.isModerator(
              streamer.userId,
              effectiveBot.userId,
            );
            this.moderator = {
              state: isMod ? 'yes' : 'no',
              message: isMod
                ? '@' + effectiveBot.login + ' is a moderator.'
                : 'Type /mod ' + effectiveBot.login + ' in your chat',
            };
          } catch (error) {
            this.moderator = { state: 'error', message: safeMessage(error) };
          }
        }
      }
    }
    this.checkedAt = new Date().toISOString();
  }
  setLive(live: boolean): void {
    this.live = live;
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.auth.close();
    await this.events?.close();
    await this.pending;
  }
}
