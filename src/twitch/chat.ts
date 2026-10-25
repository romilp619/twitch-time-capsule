import type { CapsuleCommands } from '../capsule/commands.js';
import type { SendContext } from '../capsule/replies.js';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { TwitchAuth } from './auth.js';
import { HelixClient } from './helix.js';
import { TwitchError } from './http.js';
import { MessageDedupe } from './eventsub.js';
import type { EventLog } from '../db/events.js';

export const chatEventSchema = z.object({
  broadcaster_user_id: z.string().min(1),
  chatter_user_id: z.string().min(1),
  chatter_user_login: z.string().min(1).max(100),
  chatter_user_name: z.string().max(100),
  message_id: z.string().min(1).max(256),
  message: z.object({ text: z.string().max(2000) }),
  badges: z.array(z.object({ set_id: z.string().max(100) })).max(100),
});
export type ChatEvent = z.infer<typeof chatEventSchema>;
const sendSchema = z.object({
  data: z.array(z.object({ message_id: z.string(), is_sent: z.boolean() })),
});
export function truncateChat(text: string): string {
  return Array.from(text).slice(0, 500).join('');
}

export class ChatSender {
  private tail: Promise<void> = Promise.resolve();
  private nextSendAt = 0;
  constructor(
    private readonly auth: TwitchAuth,
    private readonly helix: HelixClient,
    private readonly now: () => number = Date.now,
  ) {}
  send(text: string, context?: SendContext): Promise<string> {
    const expectedBroadcaster =
      context?.broadcasterId ?? this.auth.publicAccount('streamer').userId;
    const expectedSender =
      context?.senderId ??
      this.auth.publicAccount(this.auth.effectiveRole('bot')).userId;

    const work = this.tail.then(async () => {
      const message = truncateChat(text.trim());
      if (!message) throw new TwitchError(400, 'A chat reply cannot be empty.');
      const broadcaster = this.auth.publicAccount('streamer');
      const sender = this.auth.publicAccount(this.auth.effectiveRole('bot'));
      if (
        broadcaster.status !== 'connected' ||
        sender.status !== 'connected' ||
        !broadcaster.userId ||
        !sender.userId
      )
        throw new TwitchError(
          401,
          'Reconnect the streamer and bot before sending chat.',
        );
      if (
        broadcaster.userId !== expectedBroadcaster ||
        sender.userId !== expectedSender
      )
        throw new TwitchError(
          409,
          'The connected channel changed. The queued reply was cancelled.',
        );
      const wait = this.nextSendAt - this.now();
      if (wait > 0)
        await delay(wait, undefined, { signal: this.auth.controller.signal });
      if (
        this.auth.publicAccount('streamer').userId !== expectedBroadcaster ||
        this.auth.publicAccount(this.auth.effectiveRole('bot')).userId !==
          expectedSender
      )
        throw new TwitchError(
          409,
          'The connected channel changed. The queued reply was cancelled.',
        );
      this.nextSendAt = this.now() + 1500;
      const result = await this.helix.request(
        'bot',
        '/chat/messages',
        sendSchema,
        {
          method: 'POST',
          expectedUserId: sender.userId,
          body: {
            broadcaster_id: broadcaster.userId,
            sender_id: sender.userId,
            message,
          },
        },
      );
      const sent = result.data[0];
      if (!sent?.is_sent || !sent.message_id)
        throw new TwitchError(
          422,
          'Twitch did not send the reply. Check AutoMod, channel settings, and chat restrictions.',
        );
      return sent.message_id;
    });
    this.tail = work.then(
      () => {},
      () => {},
    );
    return work;
  }
  async close(): Promise<void> {
    await this.tail;
  }
}
export class ChatCommands {
  private readonly dedupe: MessageDedupe;
  private lastCapsuleAt = -Infinity;
  constructor(
    private readonly sender: ChatSender,
    private readonly log: EventLog,
    private readonly now: () => number = Date.now,
    private readonly capsules?: CapsuleCommands,
  ) {
    this.dedupe = new MessageDedupe(now);
  }
  async receive(event: ChatEvent, senderId: string): Promise<void> {
    if (this.dedupe.seen(event.message_id)) return;
    const self = event.chatter_user_id === senderId;
    const isSeal = /^!seal(?:\s|$)/i.test(event.message.text.trim());
    this.log.write('chat.received', {
      login: event.chatter_user_login,
      displayName: event.chatter_user_name,
      text: isSeal ? '[seal text omitted]' : event.message.text,
      messageId: event.message_id,
      self,
    });
    if (self) return;
    if (this.capsules && (await this.capsules.handle(event, senderId))) return;
    if (!/^!capsule\s*$/i.test(event.message.text.trim())) return;
    const now = this.now();
    if (now - this.lastCapsuleAt < 30_000) return;
    this.lastCapsuleAt = now;
    try {
      const message =
        this.capsules?.describe(event.broadcaster_user_id) ??
        'No capsule is open for sealing right now.';
      const messageId = await this.sender.send(message);
      this.log.write('chat.sent', { message, messageId });
    } catch (error) {
      if (this.lastCapsuleAt === now) this.lastCapsuleAt = -Infinity;
      throw error;
    }
  }
}
