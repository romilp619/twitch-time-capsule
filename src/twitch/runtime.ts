import type { TriggerScheduler } from '../capsule/scheduler.js';
import { CapsuleCommands } from '../capsule/commands.js';
import type { CapsuleStore } from '../capsule/store.js';
import type { BlockedWords } from '../capsule/moderation.js';
import { z } from 'zod';
import { TwitchAuth, type AccountRole } from './auth.js';
import { HelixClient } from './helix.js';
import {
  EventSubClient,
  subscriptionPlan,
  type EventNotification,
} from './eventsub.js';
import { ChatCommands, ChatSender, chatEventSchema } from './chat.js';
import { safeMessage } from './http.js';
import type { EventLog } from '../db/events.js';

const createdSubscriptionSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      type: z.string(),
      version: z.string(),
      transport: z.object({ method: z.string(), session_id: z.string() }),
    }),
  ),
});
const broadcasterSchema = z.object({ broadcaster_user_id: z.string() });
const categorySchema = broadcasterSchema.extend({
  category_id: z.string(),
  category_name: z.string().max(200),
});
const followSchema = broadcasterSchema.extend({
  user_id: z.string(),
  user_login: z.string().max(100),
});
export interface RuntimeOptions {
  capsules?: CapsuleStore;
  triggers?: TriggerScheduler;
  blockedWords?: BlockedWords;
  batchWindowMs?: number;
  url?: string;
  retryDelayMs?: number;
  welcomeTimeoutMs?: number;
}
interface ManagedConnection {
  role: AccountRole;
  userId: string;
  signature: string;
  client: EventSubClient;
}
export class TwitchRuntime {
  private readonly clients = new Map<AccountRole, ManagedConnection>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly sender: ChatSender;
  private readonly commands: ChatCommands;
  private readonly capsuleCommands: CapsuleCommands | undefined;
  private stopped = false;
  private setupError: string | null = null;
  constructor(
    private readonly auth: TwitchAuth,
    private readonly helix: HelixClient,
    private readonly log: EventLog,
    private readonly changed: () => void,
    private readonly setLive: (live: boolean) => void,
    private readonly options: RuntimeOptions = {},
  ) {
    this.sender = new ChatSender(auth, helix);
    this.capsuleCommands =
      options.capsules && options.blockedWords
        ? new CapsuleCommands(
            options.capsules,
            options.blockedWords,
            this.sender,
            (broadcasterId, senderId, messageId) =>
              helix.deleteChatMessage(broadcasterId, senderId, messageId),
            log,
            auth.config.baseUrl,
            Date.now,
            options.batchWindowMs,
            options.triggers
              ? (id) => options.triggers!.action(id, 'open')
              : undefined,
          )
        : undefined;
    this.commands = new ChatCommands(
      this.sender,
      log,
      Date.now,
      this.capsuleCommands,
    );
  }
  snapshot() {
    const connections = [...this.clients.values()].map((entry) => ({
      role: entry.role,
      userId: entry.userId,
      ...entry.client.snapshot(),
    }));
    const allConnected =
      connections.length > 0 &&
      connections.every((entry) => entry.status === 'connected') &&
      !this.setupError;
    const warnings = connections.flatMap((entry) =>
      entry.error ? [entry.role + ': ' + entry.error] : [],
    );
    if (this.setupError) warnings.push(this.setupError);
    warnings.push(...(this.capsuleCommands?.warnings ?? []));
    return {
      status: allConnected
        ? 'connected'
        : connections.length
          ? Boolean(this.setupError) ||
            connections.some((entry) => entry.status === 'degraded')
            ? 'degraded'
            : 'connecting'
          : 'disconnected',
      connections,
      warnings,
      subscriptions: connections.flatMap((entry) =>
        entry.subscriptions.map((subscription) => ({
          ...subscription,
          role: entry.role,
        })),
      ),
      lastKeepalive:
        connections
          .map((entry) => entry.lastKeepalive)
          .filter((value): value is string => value !== null)
          .sort()
          .at(-1) ?? null,
    };
  }
  async sync(): Promise<void> {
    if (this.stopped) return;
    this.setupError = null;
    const streamer = this.auth.publicAccount('streamer');
    const desired = new Map<
      AccountRole,
      { userId: string; chat: boolean; broadcaster: boolean }
    >();
    if (streamer.status === 'connected' && streamer.userId) {
      const separate = Boolean(this.auth.store.get('bot'));
      desired.set('streamer', {
        userId: streamer.userId,
        broadcaster: true,
        chat: !separate,
      });
      const bot = this.auth.publicAccount('bot');
      if (separate && bot.status !== 'connected')
        this.setupError =
          'Bot authorization is unavailable. Recheck or reconnect the bot.';
      if (separate && bot.status === 'connected' && bot.userId)
        desired.set('bot', {
          userId: bot.userId,
          broadcaster: false,
          chat: true,
        });
    }
    for (const [role, existing] of this.clients) {
      const plan = desired.get(role);
      if (!plan || existing.signature !== JSON.stringify(plan)) {
        existing.client.stop();
        this.clients.delete(role);
      }
    }
    for (const [role, plan] of desired) {
      const existing = this.clients.get(role);
      if (existing) {
        if (existing.client.snapshot().status === 'degraded')
          existing.client.restart();
        continue;
      }
      try {
        await this.auth.accessToken(role);
      } catch (error) {
        this.setupError = safeMessage(error);
        continue;
      }
      if (this.stopped || !streamer.userId) return;
      const subscriptions = subscriptionPlan(
        streamer.userId,
        plan.userId,
        plan.broadcaster,
        plan.chat,
      );
      const client = new EventSubClient(subscriptions, {
        ...this.options,
        onChange: this.changed,
        onNotice: (type, message) => this.log.write(type, { role, message }),
        onNotification: (event) =>
          this.track(this.receive(event, streamer.userId ?? '', plan.userId)),
        subscribe: async (sessionId, subscription) => {
          const result = await this.helix.request(
            role,
            '/eventsub/subscriptions',
            createdSubscriptionSchema,
            {
              method: 'POST',
              expectedUserId: plan.userId,
              body: {
                ...subscription,
                transport: { method: 'websocket', session_id: sessionId },
              },
            },
          );
          if (
            !result.data.some(
              (entry) =>
                entry.type === subscription.type &&
                entry.version === subscription.version &&
                entry.status === 'enabled' &&
                entry.transport.session_id === sessionId,
            )
          )
            throw new Error('Unexpected subscription response.');
        },
      });
      this.clients.set(role, {
        role,
        userId: plan.userId,
        signature: JSON.stringify(plan),
        client,
      });
      client.start();
    }
    this.changed();
  }
  private track(task: Promise<void>): Promise<void> {
    const safe = task.catch((error: unknown) => {
      if (!this.stopped)
        this.log.write('eventsub.handler_error', {
          message: safeMessage(error),
        });
    });
    this.tasks.add(safe);
    void safe.finally(() => this.tasks.delete(safe));
    return safe;
  }
  private async receive(
    notification: EventNotification,
    broadcasterId: string,
    senderId: string,
  ): Promise<void> {
    if (
      this.stopped ||
      this.auth.publicAccount('streamer').userId !== broadcasterId
    )
      return;
    if (notification.subscription.type === 'channel.chat.message') {
      const parsed = chatEventSchema.safeParse(notification.event);
      if (!parsed.success || parsed.data.broadcaster_user_id !== broadcasterId)
        return;
      await this.commands.receive(parsed.data, senderId);
      return;
    }
    const parsed = broadcasterSchema.safeParse(notification.event);
    if (!parsed.success || parsed.data.broadcaster_user_id !== broadcasterId)
      return;
    switch (notification.subscription.type) {
      case 'stream.online':
      case 'stream.offline': {
        const live = notification.subscription.type === 'stream.online';
        this.setLive(live);
        await this.options.triggers?.stream(broadcasterId, live);
        this.log.write(notification.subscription.type, { live });
        break;
      }
      case 'channel.update': {
        const category = categorySchema.safeParse(notification.event);
        if (category.success) {
          this.options.triggers?.category(
            broadcasterId,
            category.data.category_id,
            category.data.category_name,
          );
          this.log.write('channel.update', {
            categoryId: category.data.category_id,
            categoryName: category.data.category_name,
          });
        }
        break;
      }
      case 'channel.follow': {
        const follow = followSchema.safeParse(notification.event);
        if (follow.success) {
          await this.options.triggers?.follow(broadcasterId);
          this.log.write('channel.follow', {
            login: follow.data.user_login,
            userId: follow.data.user_id,
          });
        }
        break;
      }
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    for (const entry of this.clients.values()) entry.client.stop();
    this.clients.clear();
    await Promise.allSettled([...this.tasks]);
    await this.capsuleCommands?.close();
    await this.sender.close();
  }
}
