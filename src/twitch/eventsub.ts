import { safeMessage, TwitchError } from './http.js';
import WebSocket, { type RawData } from 'ws';
import { z } from 'zod';

export interface EventSubscription {
  type:
    | 'stream.online'
    | 'stream.offline'
    | 'channel.update'
    | 'channel.follow'
    | 'channel.chat.message';
  version: string;
  condition: Record<string, string>;
}
export interface EventNotification {
  messageId: string;
  subscription: EventSubscription;
  event: unknown;
}
export class MessageDedupe {
  private readonly entries = new Map<string, number>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttl = 10 * 60_000,
    private readonly max = 5000,
  ) {}
  seen(id: string): boolean {
    const now = this.now();
    for (const [key, at] of this.entries) {
      if (at > now - this.ttl && this.entries.size < this.max) break;
      this.entries.delete(key);
    }
    if (this.entries.has(id)) return true;
    this.entries.set(id, now);
    return false;
  }
}
export function subscriptionPlan(
  broadcasterId: string,
  userId: string,
  broadcaster: boolean,
  chat: boolean,
): EventSubscription[] {
  const subscriptions: EventSubscription[] = broadcaster
    ? [
        {
          type: 'stream.online',
          version: '1',
          condition: { broadcaster_user_id: broadcasterId },
        },
        {
          type: 'stream.offline',
          version: '1',
          condition: { broadcaster_user_id: broadcasterId },
        },
        {
          type: 'channel.update',
          version: '2',
          condition: { broadcaster_user_id: broadcasterId },
        },
        {
          type: 'channel.follow',
          version: '2',
          condition: {
            broadcaster_user_id: broadcasterId,
            moderator_user_id: broadcasterId,
          },
        },
      ]
    : [];
  if (chat)
    subscriptions.push({
      type: 'channel.chat.message',
      version: '1',
      condition: { broadcaster_user_id: broadcasterId, user_id: userId },
    });
  return subscriptions;
}
const envelopeSchema = z.object({
  metadata: z.object({
    message_id: z.string().min(1).max(256),
    message_type: z.string(),
  }),
  payload: z.unknown(),
});
const welcomeSchema = z.object({
  session: z.object({
    id: z.string().min(1),
    keepalive_timeout_seconds: z.number().positive().nullable(),
  }),
});
const reconnectSchema = z.object({
  session: z.object({ reconnect_url: z.string().url() }),
});
const notificationSchema = z.object({
  subscription: z.object({
    type: z.string(),
    version: z.string(),
    condition: z.record(z.string(), z.string()),
  }),
  event: z.unknown(),
});
const revocationSchema = z.object({
  subscription: z.object({ type: z.string(), status: z.string() }),
});
export interface SubscriptionStatus {
  type: string;
  version: string;
  status: 'pending' | 'enabled' | 'error' | 'revoked';
  error: string | null;
}
export interface EventSubState {
  status:
    | 'stopped'
    | 'connecting'
    | 'subscribing'
    | 'connected'
    | 'reconnecting'
    | 'degraded';
  subscriptions: SubscriptionStatus[];
  lastKeepalive: string | null;
  lastNotification: string | null;
  error: string | null;
}
interface SocketContext {
  socket: WebSocket;
  migration: boolean;
  welcomed: boolean;
  keepaliveMs: number;
  welcomeTimer: ReturnType<typeof setTimeout> | undefined;
  watchdog: ReturnType<typeof setTimeout> | undefined;
}
export interface EventSubOptions {
  url?: string;
  retryDelayMs?: number;
  welcomeTimeoutMs?: number;
  now?: () => number;
  onChange?: () => void;
  onNotice?: (type: string, message: string) => void;
  onNotification: (notification: EventNotification) => void | Promise<void>;
  subscribe: (
    sessionId: string,
    subscription: EventSubscription,
  ) => Promise<void>;
}
export class EventSubClient {
  private readonly url: string;
  private readonly now: () => number;
  private readonly dedupe: MessageDedupe;
  private stopped = true;
  private active: SocketContext | undefined;
  private candidate: SocketContext | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryCount = 0;
  private state: EventSubState = {
    status: 'stopped',
    subscriptions: [],
    lastKeepalive: null,
    lastNotification: null,
    error: null,
  };
  constructor(
    readonly subscriptions: readonly EventSubscription[],
    private readonly options: EventSubOptions,
  ) {
    this.url = options.url ?? 'wss://eventsub.wss.twitch.tv/ws';
    this.now = options.now ?? Date.now;
    this.dedupe = new MessageDedupe(this.now);
  }
  snapshot(): EventSubState {
    return {
      ...this.state,
      subscriptions: this.state.subscriptions.map((entry) => ({ ...entry })),
    };
  }
  private update(patch: Partial<EventSubState>): void {
    this.state = { ...this.state, ...patch };
    this.options.onChange?.();
  }
  private notice(type: string, message: string): void {
    this.options.onNotice?.(type, message);
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect(this.url, false);
  }
  restart(): void {
    this.stop();
    this.start();
  }
  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const sockets = [this.active, this.candidate];
    this.active = undefined;
    this.candidate = undefined;
    for (const socket of sockets) if (socket) this.dispose(socket);
    this.update({ status: 'stopped', subscriptions: [], error: null });
  }
  private dispose(context: SocketContext, graceful = false): void {
    if (context.welcomeTimer) clearTimeout(context.welcomeTimer);
    if (context.watchdog) clearTimeout(context.watchdog);
    if (graceful && context.socket.readyState === WebSocket.OPEN)
      context.socket.close(1000);
    else context.socket.terminate();
  }
  private current(context: SocketContext): boolean {
    return (
      !this.stopped && (context === this.active || context === this.candidate)
    );
  }
  private connect(url: string, migration: boolean): void {
    if (this.stopped) return;
    this.update({
      status: migration ? 'reconnecting' : 'connecting',
      error: null,
    });
    const socket = new WebSocket(url, {
      handshakeTimeout: 10_000,
      maxPayload: 1024 * 1024,
      followRedirects: false,
    });
    const context: SocketContext = {
      socket,
      migration,
      welcomed: false,
      keepaliveMs: 10_000,
      welcomeTimer: undefined,
      watchdog: undefined,
    };
    if (migration) this.candidate = context;
    else this.active = context;
    context.welcomeTimer = setTimeout(() => {
      if (!this.current(context) || context.welcomed) return;
      this.notice(
        'eventsub.timeout',
        'Twitch did not send a welcome message. Reconnecting.',
      );
      socket.terminate();
    }, this.options.welcomeTimeoutMs ?? 10_000);
    context.welcomeTimer.unref();
    socket.on('message', (data: RawData) => this.message(context, data));
    socket.on('error', () => {
      if (this.current(context))
        this.update({ error: 'Twitch WebSocket connection failed. Retrying.' });
    });
    socket.on('close', (code) => {
      if (!this.current(context)) return;
      this.dispose(context);
      if (this.active === context) this.active = undefined;
      if (this.candidate === context) {
        this.candidate = undefined;
        if (this.active) {
          this.dispose(this.active);
          this.active = undefined;
        }
      }
      this.notice(
        'eventsub.disconnected',
        'Twitch WebSocket closed (code ' + code + '). Reconnecting.',
      );
      if (!this.candidate) this.scheduleReconnect();
    });
  }
  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return;
    this.update({
      status: 'reconnecting',
      subscriptions: [],
      error:
        this.state.error ??
        'Connection interrupted. Events during the gap cannot be replayed.',
    });
    const delay = Math.min(
      30_000,
      (this.options.retryDelayMs ?? 1000) * 2 ** Math.min(this.retryCount++, 5),
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect(this.url, false);
    }, delay);
    this.retryTimer.unref();
  }
  private armWatchdog(context: SocketContext): void {
    if (context.watchdog) clearTimeout(context.watchdog);
    context.watchdog = setTimeout(
      () => {
        if (!this.current(context)) return;
        this.notice(
          'eventsub.timeout',
          'Twitch keepalive timed out. Reconnecting and resubscribing.',
        );
        context.socket.terminate();
      },
      context.keepaliveMs + Math.min(1000, context.keepaliveMs * 0.1),
    );
    context.watchdog.unref();
  }
  private message(context: SocketContext, data: RawData): void {
    if (!this.current(context)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(
        Buffer.isBuffer(data)
          ? data.toString()
          : Array.isArray(data)
            ? Buffer.concat(data).toString()
            : Buffer.from(data).toString(),
      );
    } catch {
      this.notice('eventsub.invalid', 'Ignored invalid Twitch WebSocket JSON.');
      return;
    }
    const parsed = envelopeSchema.safeParse(raw);
    if (!parsed.success) {
      this.notice(
        'eventsub.invalid',
        'Ignored an invalid Twitch WebSocket message.',
      );
      return;
    }
    const { metadata, payload } = parsed.data;
    if (metadata.message_type === 'session_welcome') {
      this.welcome(context, payload);
      return;
    }
    if (!context.welcomed) return;
    this.armWatchdog(context);
    if (metadata.message_type === 'session_keepalive') {
      this.update({ lastKeepalive: new Date(this.now()).toISOString() });
      return;
    }
    if (metadata.message_type === 'session_reconnect') {
      this.migrate(context, payload);
      return;
    }
    if (this.dedupe.seen(metadata.message_id)) return;
    if (metadata.message_type === 'revocation') {
      const revoked = revocationSchema.safeParse(payload);
      if (!revoked.success) return;
      const message =
        'Twitch revoked ' +
        revoked.data.subscription.type +
        ' (' +
        revoked.data.subscription.status +
        '). Recheck permissions and reconnect the account.';
      this.update({
        status: 'degraded',
        error: message,
        subscriptions: this.state.subscriptions.map((entry) =>
          entry.type === revoked.data.subscription.type
            ? { ...entry, status: 'revoked', error: message }
            : entry,
        ),
      });
      this.notice('eventsub.revoked', message);
      return;
    }
    if (metadata.message_type !== 'notification') return;
    const notification = notificationSchema.safeParse(payload);
    if (!notification.success) {
      this.notice('eventsub.invalid', 'Ignored an invalid event notification.');
      return;
    }
    const expected = this.subscriptions.find(
      (entry) =>
        entry.type === notification.data.subscription.type &&
        entry.version === notification.data.subscription.version,
    );
    if (
      !expected ||
      !Object.entries(expected.condition).every(
        ([key, value]) =>
          notification.data.subscription.condition[key] === value,
      )
    )
      return;
    this.update({ lastNotification: new Date(this.now()).toISOString() });
    void Promise.resolve()
      .then(() =>
        this.options.onNotification({
          messageId: metadata.message_id,
          subscription: expected,
          event: notification.data.event,
        }),
      )
      .catch(() => {
        this.notice(
          'eventsub.handler_error',
          'An event could not be processed. Check the dashboard connection and retry.',
        );
      });
  }
  private welcome(context: SocketContext, payload: unknown): void {
    if (context.welcomed) return;
    const parsed = welcomeSchema.safeParse(payload);
    if (!parsed.success) {
      context.socket.terminate();
      return;
    }
    context.welcomed = true;
    if (context.welcomeTimer) clearTimeout(context.welcomeTimer);
    context.keepaliveMs =
      (parsed.data.session.keepalive_timeout_seconds ??
        (this.active?.keepaliveMs ?? 10_000) / 1000) * 1000;
    this.armWatchdog(context);
    if (context.migration) {
      const old = this.active;
      this.active = context;
      this.candidate = undefined;
      if (old) this.dispose(old, true);
      this.update({
        status: this.state.subscriptions.every(
          (entry) => entry.status === 'enabled',
        )
          ? 'connected'
          : 'degraded',
        error: this.state.subscriptions.some(
          (entry) => entry.status !== 'enabled',
        )
          ? this.state.error
          : null,
      });
      this.notice(
        'eventsub.reconnected',
        'Twitch moved the connection; subscriptions were preserved.',
      );
      return;
    }
    this.update({
      status: 'subscribing',
      error: null,
      subscriptions: this.subscriptions.map((entry) => ({
        type: entry.type,
        version: entry.version,
        status: 'pending',
        error: null,
      })),
    });
    void this.subscribeAll(context, parsed.data.session.id);
  }
  private async subscribeAll(
    context: SocketContext,
    sessionId: string,
  ): Promise<void> {
    await Promise.all(
      this.subscriptions.map(async (subscription) => {
        try {
          await this.options.subscribe(sessionId, subscription);
          if (!this.current(context) || this.active !== context) return;
          this.update({
            subscriptions: this.state.subscriptions.map((entry) =>
              entry.type === subscription.type && entry.status === 'pending'
                ? { ...entry, status: 'enabled', error: null }
                : entry,
            ),
          });
        } catch (cause) {
          if (!this.current(context) || this.active !== context) return;
          const error =
            'Could not subscribe to ' +
            subscription.type +
            (cause instanceof TwitchError
              ? ' (HTTP ' + cause.status + '): ' + safeMessage(cause)
              : '. Recheck account permissions and connection.');
          this.update({
            error,
            subscriptions: this.state.subscriptions.map((entry) =>
              entry.type === subscription.type && entry.status === 'pending'
                ? { ...entry, status: 'error', error }
                : entry,
            ),
          });
          this.notice('eventsub.subscription_error', error);
        }
      }),
    );
    if (!this.current(context) || this.active !== context) return;
    const complete = this.state.subscriptions.every(
      (entry) => entry.status === 'enabled',
    );
    if (complete) {
      this.retryCount = 0;
      // Twitch's first idle interval starts after subscriptions are established.
      // Allow a bounded delivery margin at the interval boundary.
      this.armWatchdog(context);
    }
    this.update({ status: complete ? 'connected' : 'degraded' });
    this.notice(
      'eventsub.subscribed',
      complete
        ? 'Twitch EventSub subscriptions are connected.'
        : 'Some Twitch subscriptions failed. Use Recheck connection.',
    );
  }
  private migrate(context: SocketContext, payload: unknown): void {
    if (context !== this.active || this.candidate) return;
    const parsed = reconnectSchema.safeParse(payload);
    if (!parsed.success) return;
    const url = new URL(parsed.data.session.reconnect_url);
    const original = new URL(this.url);
    if (url.origin !== original.origin || url.username || url.password) {
      this.update({
        error:
          'Twitch supplied an unexpected reconnect host. Reconnecting safely.',
      });
      context.socket.terminate();
      return;
    }
    this.connect(parsed.data.session.reconnect_url, true);
  }
}
