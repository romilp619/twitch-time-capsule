import type { EventLog } from '../db/events.js';
import { safeMessage } from '../twitch/http.js';

export interface SendContext {
  broadcasterId: string;
  senderId: string;
}
export interface ReplySender {
  send(text: string, context?: SendContext): Promise<string>;
}
export interface SealAcknowledgement {
  capsuleId: number;
  number: number;
  userLogin: string;
  condition: string;
  visibility: 'hidden' | 'restricted' | 'failed';
  context: SendContext;
}
interface Rejection {
  userLogin: string;
  message: string;
  context: SendContext;
}
function names(logins: readonly string[]): string {
  const users = [...new Set(logins)];
  return (
    users
      .slice(0, 5)
      .map((user) => '@' + user)
      .join(', ') + (users.length > 5 ? '...' : '')
  );
}
function numbers(values: readonly number[]): string {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  if (
    sorted.length > 1 &&
    sorted.every(
      (value, index) => index === 0 || value === (sorted[index - 1] ?? 0) + 1,
    )
  )
    return '#' + sorted[0] + '-' + sorted.at(-1);
  return (
    sorted
      .slice(0, 6)
      .map((value) => '#' + value)
      .join(', ') + (sorted.length > 6 ? '...' : '')
  );
}
export function acknowledgementText(
  entries: readonly SealAcknowledgement[],
): string {
  const first = entries[0];
  if (!first) return '';
  const prefix =
    entries.length === 1 && first.visibility === 'hidden'
      ? 'Sealed message '
      : 'Sealed ';
  let result =
    prefix +
    numbers(entries.map((entry) => entry.number)) +
    ' from ' +
    names(entries.map((entry) => entry.userLogin));
  if (first.visibility === 'restricted')
    result += " (mods' and the streamer's messages can't be hidden in chat)";
  if (first.visibility === 'failed')
    result += " (couldn't hide this message in chat)";
  return result + '. Opens: ' + first.condition + '.';
}
export class ReplyBatcher {
  private readonly accepted: SealAcknowledgement[] = [];
  private readonly rejected: Rejection[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly tasks = new Set<Promise<void>>();
  private closed = false;
  constructor(
    private readonly sender: ReplySender,
    private readonly log: EventLog,
    private readonly warning: (message: string) => void,
    private readonly windowMs = 3000,
  ) {}
  acknowledge(entry: SealAcknowledgement): void {
    if (this.closed) return;
    this.accepted.push(entry);
    this.schedule();
  }
  reject(entry: Rejection): void {
    if (this.closed) return;
    this.rejected.push(entry);
    this.schedule();
  }
  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      void this.flush();
    }, this.windowMs);
    this.timer.unref();
  }
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const accepted = this.accepted.splice(0);
    const rejected = this.rejected.splice(0);
    const groups = new Map<string, SealAcknowledgement[]>();
    for (const entry of accepted) {
      const key = JSON.stringify([
        entry.context,
        entry.capsuleId,
        entry.visibility,
        entry.condition,
      ]);
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }
    const failures = new Map<string, Rejection[]>();
    for (const entry of rejected) {
      const key = JSON.stringify([entry.context, entry.message]);
      const group = failures.get(key) ?? [];
      group.push(entry);
      failures.set(key, group);
    }
    const messages: Array<{ text: string; context: SendContext }> = [];
    for (const entries of groups.values()) {
      const first = entries[0];
      if (first)
        messages.push({
          text: acknowledgementText(entries),
          context: first.context,
        });
    }
    for (const entries of failures.values()) {
      const first = entries[0];
      if (first)
        messages.push({
          text:
            names(entries.map((entry) => entry.userLogin)) +
            ': ' +
            first.message,
          context: first.context,
        });
    }
    const work = (async () => {
      for (const message of messages) {
        if (this.closed) break;
        try {
          const messageId = await this.sender.send(
            message.text,
            message.context,
          );
          this.log.write('chat.sent', { message: message.text, messageId });
        } catch (error) {
          const detail =
            'Could not send a seal reply. Stored seals are safe. ' +
            safeMessage(error);
          this.warning(detail);
          this.log.write('seal.reply_error', { message: detail });
        }
      }
    })();
    this.tasks.add(work);
    try {
      await work;
    } finally {
      this.tasks.delete(work);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const pending = this.accepted.length;
    this.accepted.length = 0;
    this.rejected.length = 0;
    if (pending)
      this.log.write('seal.reply_cancelled', {
        count: pending,
        message:
          'Acknowledgements cancelled during shutdown; seals remain stored.',
      });
    await Promise.allSettled([...this.tasks]);
  }
}
