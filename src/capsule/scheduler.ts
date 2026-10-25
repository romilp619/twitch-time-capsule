import type { TwitchAuth } from '../twitch/auth.js';
import type { HelixClient } from '../twitch/helix.js';
import { safeMessage } from '../twitch/http.js';
import type { EventLog } from '../db/events.js';
import { CapsuleError } from './model.js';
import type { CapsuleStore } from './store.js';
import type { TriggerAction, TriggerFacts } from './triggers.js';

export class TriggerScheduler {
  private channelId: string | null = null;
  private live: boolean | null = null;
  private followers: number | null = null;
  private categoryId: string | null = null;
  private categoryName: string | null = null;
  private categoryRevision = 0;
  private liveRevision = 0;
  private warnings = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private dueTimer: ReturnType<typeof setTimeout> | undefined;
  private requests = new Map<string, Promise<void>>();
  private stopped = false;
  constructor(
    private readonly store: CapsuleStore,
    private readonly auth: TwitchAuth,
    private readonly helix: HelixClient,
    private readonly log: EventLog,
    private readonly changed: () => void,
    private readonly offlineDelayMs: number,
    private readonly now: () => number = Date.now,
  ) {}
  snapshot() {
    return {
      channelId: this.channelId,
      live: this.live,
      followers: this.followers,
      categoryId: this.categoryId,
      categoryName: this.categoryName,
      warnings: [...this.warnings.values()],
    };
  }
  start(): void {
    this.timer = setInterval(() => this.safeTick(), 30_000);
    this.poll = setInterval(() => {
      void this.sync().catch(() => this.storageWarning());
    }, 5 * 60_000);
    this.timer.unref();
    this.poll.unref();
  }
  private current(): boolean {
    const account = this.auth.publicAccount('streamer');
    return (
      !this.stopped &&
      account.status === 'connected' &&
      account.userId === this.channelId
    );
  }
  async sync(live?: boolean | null): Promise<void> {
    if (this.stopped) return;
    const account = this.auth.publicAccount('streamer');
    const id = account.status === 'connected' ? account.userId : null;
    if (id !== this.channelId) {
      this.channelId = id;
      this.live = null;
      this.followers = null;
      this.categoryId = null;
      this.categoryName = null;
      this.liveRevision++;
      this.categoryRevision++;
      this.warnings.clear();
      // Clear a persisted countdown until this session has verified live state.
      if (id) this.tick();
    }
    if (!id) {
      this.arm();
      this.changed();
      return;
    }
    if (live !== undefined) this.setLive(live);
    else await this.read('live');
    await Promise.all([this.read('followers'), this.refreshCategory()]);
    this.safeTick();
  }
  private read(kind: 'followers' | 'category' | 'live'): Promise<void> {
    const id = this.channelId;
    if (!id || !this.current()) return Promise.resolve();
    const key = id + ':' + kind;
    const pending = this.requests.get(key);
    if (pending) return pending;
    const categoryRevision = this.categoryRevision;
    const liveRevision = this.liveRevision;
    const request = (async () => {
      try {
        if (kind === 'followers') {
          const total = await this.helix.followerTotal(id);
          if (this.current() && this.channelId === id) this.followers = total;
        } else if (kind === 'category') {
          const category = await this.helix.channelCategory(id);
          if (
            this.current() &&
            this.channelId === id &&
            categoryRevision === this.categoryRevision
          ) {
            this.categoryId = category.game_id;
            this.categoryName = category.game_name;
          }
        } else {
          const live = await this.helix.isLive(id);
          if (
            this.current() &&
            this.channelId === id &&
            liveRevision === this.liveRevision
          )
            this.setLive(live);
        }
        if (this.channelId === id) this.warnings.delete(kind);
      } catch (error) {
        if (!this.stopped && this.channelId === id) {
          this.warnings.set(
            kind,
            'Opening checks (' + kind + '): ' + safeMessage(error),
          );
          if (kind === 'live') this.setLive(null);
          if (kind === 'followers') this.followers = null;
          if (kind === 'category' && categoryRevision === this.categoryRevision)
            this.categoryId = null;
          this.log.write('trigger.check_error', {
            kind,
            message: safeMessage(error),
          });
        }
      }
      this.changed();
    })().finally(() => {
      this.requests.delete(key);
    });
    this.requests.set(key, request);
    return request;
  }
  async follow(broadcasterId: string): Promise<void> {
    if (broadcasterId !== this.channelId || !this.current()) return;
    // If a snapshot was already in flight when this follow arrived, read again
    // after it completes rather than assuming the earlier total includes it.
    const pending = this.requests.get(broadcasterId + ':followers');
    if (pending) await pending;
    await this.read('followers');
    this.safeTick();
  }
  category(broadcasterId: string, id: string, name: string): void {
    if (broadcasterId !== this.channelId || !this.current()) return;
    this.categoryRevision++;
    this.categoryId = id;
    this.categoryName = name;
    this.safeTick();
    this.changed();
  }
  async stream(broadcasterId: string, live: boolean): Promise<void> {
    if (broadcasterId !== this.channelId || !this.current()) return;
    this.setLive(live);
    if (live) await this.refreshCategory();
    this.safeTick();
    this.changed();
  }
  private async refreshCategory(): Promise<void> {
    const pending = this.requests.get(this.channelId + ':category');
    if (pending) await pending;
    await this.read('category');
  }
  private setLive(live: boolean | null): void {
    if (live === true && this.live !== true) {
      this.categoryId = null;
      this.categoryName = null;
      this.categoryRevision++;
    }
    if (this.live !== live) this.liveRevision++;
    this.live = live;
    this.safeTick();
  }
  private facts(openingAllowed = false): TriggerFacts {
    return {
      now: this.now(),
      live: this.current() ? this.live : null,
      followers: this.followers,
      categoryId: this.categoryId,
      offlineDelayMs: this.offlineDelayMs,
      openingAllowed,
    };
  }
  tick(openingAllowed = false): void {
    if (this.stopped) return;
    if (this.channelId) {
      for (const capsule of this.store.waiting(this.channelId)) {
        const result = this.store.trigger(
          capsule.id,
          this.facts(openingAllowed),
        );
        if (result.status !== capsule.status)
          this.log.write('capsule.' + result.status, {
            capsuleId: capsule.id,
            triggerType: capsule.triggerType,
          });
      }
    }
    this.arm();
  }
  private safeTick(openingAllowed = false): void {
    try {
      this.tick(openingAllowed);
      this.warnings.delete('storage');
    } catch {
      this.storageWarning();
    }
  }
  private storageWarning(): void {
    if (this.stopped) return;
    this.warnings.set(
      'storage',
      'Opening state could not be saved. Check local storage and recheck the connection.',
    );
    this.changed();
  }
  action(id: number, action: Exclude<TriggerAction, 'check'>) {
    const capsule = this.store.get(id);
    if (!capsule) throw new CapsuleError(404, 'Capsule not found.');
    if (!this.current() || capsule.channel.id !== this.channelId)
      throw new CapsuleError(
        409,
        'Connect this capsule’s streamer account before changing its opening.',
      );
    if (!['sealing', 'locked', 'ready'].includes(capsule.status))
      throw new CapsuleError(
        409,
        'Only a waiting capsule can be opened or postponed.',
      );
    const result = this.store.trigger(id, this.facts(), action);
    this.log.write(
      action === 'open' ? 'capsule.open_requested' : 'capsule.postponed',
      { capsuleId: id, postponedUntil: result.postponedUntil },
    );
    this.arm();
    return result;
  }
  private arm(): void {
    if (this.dueTimer) clearTimeout(this.dueTimer);
    this.dueTimer = undefined;
    if (
      !this.current() ||
      this.live !== true ||
      !this.channelId ||
      this.store.hasOpening()
    )
      return;
    const due = this.store
      .waiting(this.channelId)
      .flatMap((c) => (c.openingDueAt ? [Date.parse(c.openingDueAt)] : []));
    if (!due.length) return;
    this.dueTimer = setTimeout(
      () => {
        void this.openDue().catch(() => this.storageWarning());
      },
      Math.max(100, Math.min(...due) - this.now()),
    );
    this.dueTimer.unref();
  }
  private async openDue(): Promise<void> {
    // Revalidate with Helix at the deadline, including after a lost EventSub socket.
    await this.read('live');
    if (!this.current() || this.live !== true) {
      this.safeTick();
      return;
    }
    this.safeTick(true);
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.poll) clearInterval(this.poll);
    if (this.dueTimer) clearTimeout(this.dueTimer);
    await Promise.allSettled([...this.requests.values()]);
  }
}
