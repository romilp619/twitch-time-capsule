import type { ChatEvent } from '../twitch/chat.js';
import type { EventLog } from '../db/events.js';
import { safeMessage } from '../twitch/http.js';
import { CapsuleError, conditionText, type Capsule } from './model.js';
import { BlockedWords, parseSealCommand } from './moderation.js';
import { CapsuleStore } from './store.js';
import { ReplyBatcher, type ReplySender, type SendContext } from './replies.js';

export type DeleteChatMessage = (
  broadcasterId: string,
  senderId: string,
  messageId: string,
) => Promise<void>;
function clipped(text: string, length: number): string {
  const points = Array.from(text);
  return points.length > length
    ? points.slice(0, Math.max(0, length - 3)).join('') + '...'
    : text;
}
export class CapsuleCommands {
  readonly batcher: ReplyBatcher;
  readonly warnings: string[] = [];
  private readonly rejectedAt = new Map<string, number>();
  constructor(
    private readonly store: CapsuleStore,
    private readonly blocked: BlockedWords,
    private readonly sender: ReplySender,
    private readonly remove: DeleteChatMessage,
    private readonly log: EventLog,
    private readonly baseUrl: string,
    private readonly now: () => number = Date.now,
    batchWindowMs = 3000,
  ) {
    this.batcher = new ReplyBatcher(
      sender,
      log,
      (message) => this.warn(message),
      batchWindowMs,
    );
  }
  private warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
    if (this.warnings.length > 5) this.warnings.shift();
  }
  private latest(broadcasterId: string): Capsule | null {
    return (
      this.store.active(broadcasterId) ??
      this.store
        .list()
        .find(
          (capsule) =>
            capsule.channel.id === broadcasterId &&
            capsule.status !== 'archived',
        ) ??
      null
    );
  }
  describe(broadcasterId: string): string {
    const capsule = this.latest(broadcasterId);
    if (!capsule) return 'No capsule is open for sealing right now.';
    const url = new URL('/c/' + capsule.slug, this.baseUrl).toString();
    const title = clipped(capsule.title, 60);
    const detail = clipped(
      conditionText(capsule, this.now()),
      Math.max(30, 420 - Array.from(url + title).length),
    );
    return (
      title +
      ' | ' +
      capsule.status +
      ' | ' +
      capsule.sealedCount +
      ' sealed. Opens: ' +
      detail +
      '. ' +
      url
    );
  }
  private reject(
    event: ChatEvent,
    context: SendContext,
    message: string,
  ): void {
    const key = event.broadcaster_user_id + ':' + event.chatter_user_id;
    const now = this.now();
    for (const [user, at] of this.rejectedAt)
      if (at < now - 60_000 || this.rejectedAt.size >= 5000)
        this.rejectedAt.delete(user);
    if (now - (this.rejectedAt.get(key) ?? -Infinity) < 10_000) return;
    this.rejectedAt.set(key, now);
    this.batcher.reject({
      userLogin: event.chatter_user_login,
      message,
      context,
    });
  }
  async handle(event: ChatEvent, senderId: string): Promise<boolean> {
    const context = { broadcasterId: event.broadcaster_user_id, senderId };
    const text = parseSealCommand(event.message.text);
    if (text !== null) {
      let receipt;
      try {
        receipt = this.store.acceptSeal(
          {
            broadcasterId: event.broadcaster_user_id,
            userId: event.chatter_user_id,
            userLogin: event.chatter_user_login,
            displayName: event.chatter_user_name,
            text,
            chatMessageId: event.message_id,
          },
          (value) => this.blocked.contains(value),
        );
      } catch (error) {
        const message =
          error instanceof CapsuleError
            ? error.message
            : 'The seal could not be stored. Please try again.';
        if (!(error instanceof CapsuleError) || error.status >= 500)
          this.warn(message);
        this.log.write('seal.rejected', {
          login: event.chatter_user_login,
          message,
        });
        this.reject(event, context, message);
        return true;
      }
      if (!receipt) return true;
      let visibility: 'hidden' | 'restricted' | 'failed' = 'restricted';
      const restricted = event.badges.some((badge) =>
        ['broadcaster', 'moderator'].includes(badge.set_id),
      );
      if (!restricted) {
        try {
          await this.remove(
            event.broadcaster_user_id,
            senderId,
            event.message_id,
          );
          this.store.setHidden(receipt.id, true);
          visibility = 'hidden';
        } catch (error) {
          visibility = 'failed';
          const message =
            'Seal #' +
            receipt.number +
            ' was stored but could not be hidden in chat. ' +
            safeMessage(error);
          this.warn(message);
          this.log.write('seal.hide_error', {
            capsuleId: receipt.capsuleId,
            number: receipt.number,
            message,
          });
        }
      }
      this.log.write('seal.accepted', {
        capsuleId: receipt.capsuleId,
        number: receipt.number,
        login: receipt.userLogin,
        hidden: visibility === 'hidden',
      });
      this.batcher.acknowledge({
        capsuleId: receipt.capsuleId,
        number: receipt.number,
        userLogin: receipt.userLogin,
        condition: conditionText(receipt.capsule, this.now()),
        visibility,
        context,
      });
      return true;
    }
    const command = /^!capsule\s+(lock|status)\s*$/iu
      .exec(event.message.text.trim())?.[1]
      ?.toLowerCase();
    if (!command) return false;
    if (
      !event.badges.some((badge) =>
        ['broadcaster', 'moderator'].includes(badge.set_id),
      )
    ) {
      this.reject(
        event,
        context,
        'Only channel moderators and the streamer can use that command.',
      );
      return true;
    }
    if (command === 'lock') {
      const capsule = this.store.active(event.broadcaster_user_id);
      if (!capsule)
        this.reject(
          event,
          context,
          'No capsule is open for sealing right now.',
        );
      else {
        this.store.changeStatus(capsule.id, 'lock');
        this.log.write('capsule.locked', { capsuleId: capsule.id });
        await this.sender.send(
          'Capsule locked. No more seals are being accepted.',
          context,
        );
      }
    } else
      await this.sender.send(this.describe(event.broadcaster_user_id), context);
    return true;
  }
  async close(): Promise<void> {
    await this.batcher.close();
  }
}
