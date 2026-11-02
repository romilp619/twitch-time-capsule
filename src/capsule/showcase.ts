import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { EventLog } from '../db/events.js';
import type { CapsuleStore } from './store.js';
import type { OverlaySettings } from './ceremony-state.js';
import { CapsuleError } from './model.js';

const playbackSchema = z.object({
  status: z.enum(['idle', 'playing', 'paused', 'finished']),
  capsuleId: z.number().int().positive().nullable(),
  intervalSeconds: z.number().int().min(3).max(60),
  cursor: z.number().int().nonnegative(),
  shown: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  recent: z.array(z.number().int().positive()).max(3),
  lastAt: z.number(),
  startedAt: z.number(),
});

// Playback reads one indexed row at a time and retains at most three card IDs.
// It never re-grants VIPs, re-announces chat, or modifies reveal decisions.
export class ProphetShowcase {
  private status: 'idle' | 'playing' | 'paused' | 'finished' = 'idle';
  private capsuleId: number | null = null;
  private intervalSeconds = 5;
  private cursor = 0;
  private shown = 0;
  private total = 0;
  private recent: number[] = [];
  private lastAt = 0;
  private startedAt = 0;
  constructor(
    private readonly db: Database.Database,
    private readonly store: CapsuleStore,
    private readonly log: EventLog,
    private readonly changed: () => void,
    private readonly now: () => number = Date.now,
  ) {
    const row = db
      .prepare('SELECT showcase FROM ceremony_runtime WHERE id=1')
      .get() as { showcase: string } | undefined;
    try {
      const saved = playbackSchema.safeParse(JSON.parse(row?.showcase ?? '{}'));
      if (saved.success) {
        Object.assign(this, saved.data);
        // A restart restores progress paused, never starts unattended playback.
        if (this.status === 'playing') this.status = 'paused';
      }
    } catch {
      /* A malformed playback record must not prevent the app from starting. */
    }
  }
  private publish(): void {
    this.db.prepare('UPDATE ceremony_runtime SET showcase=? WHERE id=1').run(
      JSON.stringify({
        ...this.dashboard(),
        cursor: this.cursor,
        recent: this.recent,
        lastAt: this.lastAt,
        startedAt: this.startedAt,
      }),
    );
    this.changed();
  }
  get active(): boolean {
    return this.status === 'playing' || this.status === 'paused';
  }
  dashboard() {
    return {
      status: this.status,
      capsuleId: this.capsuleId,
      intervalSeconds: this.intervalSeconds,
      shown: this.shown,
      total: this.total,
    };
  }
  options() {
    return this.db
      .prepare(
        `SELECT c.id, c.title, COUNT(*) AS total
      FROM capsules c JOIN seals s ON s.capsule_id=c.id
      WHERE c.opened_at IS NOT NULL AND c.status IN ('opened','archived')
        AND s.status='revealed' AND s.came_true=1
      GROUP BY c.id ORDER BY c.id DESC`,
      )
      .all() as Array<{ id: number; title: string; total: number }>;
  }
  start(capsuleId: number, intervalSeconds: number): void {
    if (
      !Number.isInteger(intervalSeconds) ||
      intervalSeconds < 3 ||
      intervalSeconds > 60
    )
      throw new CapsuleError(400, 'Choose an interval from 3 to 60 seconds.');
    if (this.store.hasOpening())
      throw new CapsuleError(
        409,
        'End the opening ceremony before starting a Prophet showcase.',
      );
    const capsule = this.store.get(capsuleId);
    if (!capsule?.openedAt)
      throw new CapsuleError(409, 'Choose a capsule whose ceremony has ended.');
    const { total } = this.db
      .prepare(
        "SELECT COUNT(*) AS total FROM seals WHERE capsule_id=? AND status='revealed' AND came_true=1",
      )
      .get(capsuleId) as { total: number };
    if (!total)
      throw new CapsuleError(
        409,
        'Mark at least one revealed prediction as Came true first.',
      );
    this.capsuleId = capsuleId;
    this.intervalSeconds = intervalSeconds;
    this.total = total;
    this.cursor = 0;
    this.shown = 0;
    this.recent = [];
    this.startedAt = this.now();
    this.status = 'playing';
    this.next();
    this.log.write('showcase.started', {
      capsuleId,
      count: total,
      intervalSeconds,
    });
  }
  pause(paused: boolean): void {
    if (!this.active)
      throw new CapsuleError(409, 'Start a Prophet showcase first.');
    this.status = paused ? 'paused' : 'playing';
    this.lastAt = this.now();
    this.publish();
  }
  next(): void {
    if (!this.active)
      throw new CapsuleError(409, 'Start a Prophet showcase first.');
    const row = this.db
      .prepare(
        `SELECT id, number FROM seals
      WHERE capsule_id=? AND status='revealed' AND came_true=1 AND number>?
      ORDER BY number LIMIT 1`,
      )
      .get(this.capsuleId, this.cursor) as
      { id: number; number: number } | undefined;
    if (!row || !this.store.get(this.capsuleId!)) {
      this.status = 'finished';
      this.recent = [];
    } else {
      this.cursor = row.number;
      this.shown++;
      this.recent = [...this.recent, row.id].slice(-3);
      this.lastAt = this.now();
    }
    this.publish();
  }
  tick(): void {
    if (
      this.status === 'playing' &&
      this.now() - this.lastAt >= this.intervalSeconds * 1000
    )
      this.next();
  }
  stop(): void {
    if (this.status === 'idle') return;
    this.status = 'idle';
    this.recent = [];
    this.publish();
  }
  overlay(settings: OverlaySettings) {
    if (!this.active) return null;
    const capsule = this.store.get(this.capsuleId!);
    if (!capsule) {
      this.stop();
      return null;
    }
    const cards = this.recent.flatMap((id) => {
      const row = this.db
        .prepare(
          `SELECT id, number, display_name, text, created_at, revealed_at
        FROM seals WHERE id=? AND capsule_id=? AND status='revealed' AND came_true=1`,
        )
        .get(id, this.capsuleId) as
        | {
            id: number;
            number: number;
            display_name: string;
            text: string;
            created_at: string;
            revealed_at: string;
          }
        | undefined;
      return row
        ? [
            {
              id: row.id,
              number: row.number,
              displayName: row.display_name,
              text: row.text,
              createdAt: row.created_at,
              revealedAt: row.revealed_at,
              cameTrue: true,
            },
          ]
        : [];
    });
    return {
      type: 'ceremony',
      stage: 'prophet',
      preview: false,
      showcase: true,
      capsuleId: capsule.id,
      startedAt: this.startedAt,
      title: capsule.title + ' · Wall of Prophets',
      createdAt: capsule.createdAt,
      sealedCount: capsule.sealedCount,
      settings,
      cards,
      prophet: 'Prophet showcase · ' + this.shown + ' of ' + this.total,
    };
  }
}
