import { ProphetShowcase } from './showcase.js';
import type Database from 'better-sqlite3';
import type { EventLog } from '../db/events.js';
import { CapsuleError } from './model.js';
import type { CapsuleStore } from './store.js';
import type { BlockedWords } from './moderation.js';
import {
  idleCeremony,
  ceremonyStateSchema,
  overlaySettingsSchema,
  isCeremonyActive,
  transitionCeremony,
  type CeremonyState,
} from './ceremony-state.js';

interface SealRow {
  id: number;
  number: number;
  display_name: string;
  text: string;
  created_at: string;
  revealed_at: string | null;
  status: string;
  came_true: number;
}
export type QueueFilter =
  'pending' | 'approved' | 'rejected' | 'revealed' | 'all';
export class Ceremony {
  readonly showcase: ProphetShowcase;
  private timer: ReturnType<typeof setInterval> | undefined;
  private previewAt: number | null = null;
  private previewSignature = '';
  private revision = 0;
  private error: string | null = null;
  constructor(
    private readonly db: Database.Database,
    private readonly store: CapsuleStore,
    private readonly blocked: BlockedWords,
    private readonly log: EventLog,
    private readonly changed: () => void,
    private readonly now: () => number = Date.now,
  ) {
    this.showcase = new ProphetShowcase(db, store, log, changed, now);
    db.prepare(
      'INSERT OR IGNORE INTO ceremony_runtime (id, state, settings) VALUES (1, ?, ?)',
    ).run(
      JSON.stringify(idleCeremony()),
      JSON.stringify(overlaySettingsSchema.parse({})),
    );
  }
  state(): CeremonyState {
    const row = this.db
      .prepare('SELECT state FROM ceremony_runtime WHERE id = 1')
      .get() as { state: string };
    return ceremonyStateSchema.parse(JSON.parse(row.state) as unknown);
  }
  settings() {
    const row = this.db
      .prepare('SELECT settings FROM ceremony_runtime WHERE id = 1')
      .get() as { settings: string };
    return overlaySettingsSchema.parse(JSON.parse(row.settings) as unknown);
  }
  private save(state: CeremonyState): void {
    this.db
      .prepare('UPDATE ceremony_runtime SET state = ? WHERE id = 1')
      .run(JSON.stringify(state));
  }
  private notify(): void {
    this.revision++;
    this.error = null;
    this.changed();
  }
  private requireActive(): CeremonyState {
    const state = this.state();
    if (!isCeremonyActive(state) || !state.capsuleId)
      throw new CapsuleError(409, 'No ceremony is running.');
    return state;
  }
  begin(id: number): void {
    const current = this.state();
    if (isCeremonyActive(current) && current.capsuleId === id) return;
    const capsule = this.store.get(id);
    if (!capsule || capsule.status !== 'opening')
      throw new CapsuleError(
        409,
        'The capsule must be opening before its ceremony can begin.',
      );
    this.showcase.stop();
    this.save(
      transitionCeremony(current, { type: 'begin', capsuleId: id }, this.now()),
    );
    this.previewAt = null;
    this.log.write('ceremony.opening', { capsuleId: id });
    this.notify();
  }
  start(): void {
    this.safeTick();
    this.timer = setInterval(() => this.safeTick(), 250);
    this.timer.unref();
  }
  private safeTick(): void {
    try {
      this.tick();
    } catch {
      if (!this.error) {
        this.error =
          'Ceremony updates could not be saved. Check local storage and restart the app.';
        this.changed();
      }
    }
  }
  tick(): void {
    this.showcase.tick();
    let state = this.state();
    if (!isCeremonyActive(state)) {
      const opening = this.db
        .prepare(
          "SELECT id FROM capsules WHERE status = 'opening' ORDER BY id LIMIT 1",
        )
        .get() as { id: number } | undefined;
      if (opening) {
        this.begin(opening.id);
        state = this.state();
      }
    }
    const next = transitionCeremony(state, { type: 'tick' }, this.now());
    if (next !== state) {
      this.save(next);
      this.log.write('ceremony.queue', { capsuleId: next.capsuleId });
      this.notify();
      state = next;
    }
    if (
      state.autoReveal &&
      state.lastRevealAt !== null &&
      this.now() - state.lastRevealAt >=
        this.settings().autoRevealSeconds * 1000
    ) {
      if (this.counts(state.capsuleId).approved > 0) this.revealNext();
      else {
        this.save(
          transitionCeremony(
            state,
            { type: 'auto', enabled: false },
            this.now(),
          ),
        );
        this.log.write('ceremony.auto_paused', {
          capsuleId: state.capsuleId,
          message: 'No approved messages remain.',
        });
        this.notify();
      }
    }
    if (this.previewAt !== null) {
      const elapsed = this.now() - this.previewAt;
      if (elapsed >= 10_000) {
        this.previewAt = null;
        this.previewSignature = '';
        this.notify();
      } else {
        const signature =
          elapsed < 3000
            ? 'opening'
            : elapsed >= 8000
              ? 'prophet'
              : String(Math.min(3, 1 + Math.floor((elapsed - 3000) / 2000)));
        if (signature !== this.previewSignature) {
          this.previewSignature = signature;
          this.notify();
        }
      }
    }
  }
  counts(capsuleId: number | null) {
    const result = { pending: 0, approved: 0, rejected: 0, revealed: 0 };
    if (!capsuleId) return result;
    const rows = this.db
      .prepare(
        'SELECT status, COUNT(*) AS count FROM seals WHERE capsule_id = ? GROUP BY status',
      )
      .all(capsuleId) as Array<{ status: keyof typeof result; count: number }>;
    for (const row of rows) result[row.status] = row.count;
    return result;
  }
  dashboard() {
    const state = this.state();
    const capsule = state.capsuleId ? this.store.get(state.capsuleId) : null;
    return {
      revision: this.revision,
      state,
      settings: this.settings(),
      active: isCeremonyActive(state),
      previewActive: this.previewAt !== null,
      capsule: capsule
        ? {
            id: capsule.id,
            title: capsule.title,
            createdAt: capsule.createdAt,
            sealedCount: capsule.sealedCount,
          }
        : null,
      counts: this.counts(state.capsuleId),
      warnings: this.error ? [this.error] : [],
    };
  }
  queue(filter: QueueFilter, offset = 0, limit = 50) {
    const state = this.requireActive();
    const where = filter === 'all' ? '' : ' AND status = ?';
    const params =
      filter === 'all' ? [state.capsuleId] : [state.capsuleId, filter];
    const rows = this.db
      .prepare(
        'SELECT id, number, display_name, text, created_at, revealed_at, status, came_true FROM seals WHERE capsule_id = ?' +
          where +
          ' ORDER BY number LIMIT ? OFFSET ?',
      )
      .all(...params, limit, offset) as SealRow[];
    const total = this.db
      .prepare(
        'SELECT COUNT(*) AS total FROM seals WHERE capsule_id = ?' + where,
      )
      .get(...params) as { total: number };
    return {
      capsuleId: state.capsuleId,
      total: total.total,
      offset,
      limit,
      seals: rows.map((row) => ({
        ...this.card(row),
        status: row.status,
        flagged: this.blocked.contains(row.text),
      })),
    };
  }
  moderate(id: number, status: 'approved' | 'rejected'): void {
    this.db
      .transaction(() => {
        const state = this.requireActive();
        const row = this.db
          .prepare('SELECT status FROM seals WHERE id = ? AND capsule_id = ?')
          .get(id, state.capsuleId) as { status: string } | undefined;
        if (!row)
          throw new CapsuleError(404, 'Message not found in this ceremony.');
        if (row.status === 'revealed')
          throw new CapsuleError(409, 'A revealed message cannot be changed.');
        this.db
          .prepare(
            'UPDATE seals SET status = ? WHERE id = ? AND capsule_id = ?',
          )
          .run(status, id, state.capsuleId);
      })
      .immediate();
    this.log.write('seal.' + status, {
      sealId: id,
      capsuleId: this.state().capsuleId,
    });
    this.notify();
  }
  approveAllPending(): number {
    let capsuleId: number | null = null;
    const approved = this.db
      .transaction(() => {
        const state = this.requireActive();
        capsuleId = state.capsuleId;
        return this.db
          .prepare(
            "UPDATE seals SET status = 'approved' WHERE capsule_id = ? AND status = 'pending'",
          )
          .run(capsuleId).changes;
      })
      .immediate();
    if (approved > 0) {
      this.log.write('seal.approved_all', { capsuleId, count: approved });
      this.notify();
    }
    return approved;
  }
  revealNext(): void {
    let selected: number | undefined;
    this.db
      .transaction(() => {
        const state = this.requireActive();
        if (!['queue', 'reveal', 'prophet'].includes(state.stage))
          throw new CapsuleError(
            409,
            'Wait for the opening animation before revealing messages.',
          );
        const row = this.db
          .prepare(
            "SELECT id FROM seals WHERE capsule_id = ? AND status = 'approved' ORDER BY number LIMIT 1",
          )
          .get(state.capsuleId) as { id: number } | undefined;
        if (!row)
          throw new CapsuleError(409, 'Approve a message before revealing it.');
        const next = transitionCeremony(
          state,
          { type: 'reveal', sealId: row.id },
          this.now(),
        );
        this.db
          .prepare(
            "UPDATE seals SET status = 'revealed', revealed_at = ? WHERE id = ? AND status = 'approved'",
          )
          .run(new Date(this.now()).toISOString(), row.id);
        this.save(next);
        selected = row.id;
      })
      .immediate();
    this.log.write('ceremony.reveal', {
      capsuleId: this.state().capsuleId,
      sealId: selected,
    });
    this.notify();
  }
  prophet(sealId: number, capsuleId: number): void {
    const state = this.state();
    if (
      state.capsuleId !== capsuleId ||
      !['reveal', 'prophet'].includes(state.stage)
    )
      return;
    this.save(
      transitionCeremony(state, { type: 'prophet', sealId }, this.now()),
    );
    this.notify();
  }
  private prophetBanner(sealId: number | null) {
    if (!sealId) return null;
    const row = this.db
      .prepare(
        `SELECT s.display_name, p.vip_status, c.settings FROM prophets p
      JOIN seals s ON s.id=p.seal_id JOIN capsules c ON c.id=p.capsule_id WHERE p.seal_id=?`,
      )
      .get(sealId) as
      | { display_name: string; vip_status: string; settings: string }
      | undefined;
    if (!row) return null;
    const days = (JSON.parse(row.settings) as { vip_days: number }).vip_days;
    return (
      '@' +
      row.display_name +
      (row.vip_status === 'granted'
        ? ' gets VIP for ' + days + ' days!'
        : row.vip_status === 'pending'
          ? ' is a Prophet! Checking VIP reward…'
          : row.vip_status === 'existing'
            ? ' is a Prophet! Existing VIP preserved.'
            : ['error', 'uncertain'].includes(row.vip_status)
              ? ' is a Prophet! Check the dashboard for the VIP reward.'
              : ' is a Prophet!')
    );
  }
  setAuto(enabled: boolean): void {
    const state = this.requireActive();
    if (enabled && this.counts(state.capsuleId).approved === 0)
      throw new CapsuleError(
        409,
        'Approve a message before enabling auto-reveal.',
      );
    this.save(transitionCeremony(state, { type: 'auto', enabled }, this.now()));
    this.log.write('ceremony.auto', { capsuleId: state.capsuleId, enabled });
    this.notify();
  }
  configure(raw: unknown): void {
    const parsed = overlaySettingsSchema.safeParse(raw);
    if (!parsed.success)
      throw new CapsuleError(
        400,
        'Choose left/right, a supported card scale, and an interval from 3 to 60 seconds.',
      );
    this.db
      .prepare('UPDATE ceremony_runtime SET settings = ? WHERE id = 1')
      .run(JSON.stringify(parsed.data));
    this.notify();
  }
  end(): void {
    this.db
      .transaction(() => {
        const state = this.requireActive();
        this.save(transitionCeremony(state, { type: 'end' }, this.now()));
        this.db
          .prepare(
            "UPDATE capsules SET status = 'opened', opened_at = ? WHERE id = ? AND status = 'opening'",
          )
          .run(new Date(this.now()).toISOString(), state.capsuleId);
      })
      .immediate();
    this.log.write('ceremony.ended', { capsuleId: this.state().capsuleId });
    this.notify();
  }
  preview(): void {
    if (this.showcase.active)
      throw new CapsuleError(
        409,
        'Stop the Prophet showcase before starting a preview.',
      );
    if (isCeremonyActive(this.state()))
      throw new CapsuleError(
        409,
        'End the current ceremony before starting a preview.',
      );
    if (this.previewAt !== null)
      throw new CapsuleError(409, 'The ten-second preview is already playing.');
    this.previewAt = this.now();
    this.previewSignature = 'opening';
    this.notify();
  }
  private card(row: SealRow) {
    return {
      id: row.id,
      number: row.number,
      displayName: row.display_name,
      text: row.text,
      createdAt: row.created_at,
      revealedAt: row.revealed_at,
      cameTrue: Boolean(row.came_true),
    };
  }
  overlay() {
    const settings = this.settings();
    const showcase = this.showcase.overlay(settings);
    if (showcase) return showcase;
    if (this.previewAt !== null) {
      const elapsed = this.now() - this.previewAt;
      const messages = [
        'We will beat the final boss on our first try.',
        'Chat will still remember this moment next year.',
        'One more attempt will be the winning run.',
      ];
      const count =
        elapsed < 3000
          ? 0
          : Math.min(3, 1 + Math.floor((elapsed - 3000) / 2000));
      return {
        type: 'ceremony',
        stage:
          elapsed < 3000 ? 'opening' : elapsed >= 8000 ? 'prophet' : 'reveal',
        prophet: elapsed >= 8000 ? '@FutureViewer is a Prophet!' : null,
        preview: true,
        capsuleId: -1,
        startedAt: this.previewAt,
        title: 'A glimpse of the future',
        createdAt: new Date(this.previewAt - 7 * 86400_000).toISOString(),
        sealedCount: 3,
        settings,
        cards: messages.slice(0, count).map((text, i) => ({
          id: -i - 1,
          cameTrue: i === 0 && elapsed >= 8000,
          number: i + 1,
          displayName: ['FutureViewer', 'CapsuleKeeper', 'OneMoreTry'][i],
          text,
          createdAt: new Date(this.previewAt! - 7 * 86400_000).toISOString(),
          revealedAt: new Date(this.now()).toISOString(),
        })),
      };
    }
    const state = this.state();
    const capsule = state.capsuleId ? this.store.get(state.capsuleId) : null;
    if (!isCeremonyActive(state) || !capsule)
      return {
        type: 'ceremony',
        stage: 'idle',
        preview: false,
        settings,
        cards: [],
      };
    const cards = state.recentSealIds.flatMap((id) => {
      const row = this.db
        .prepare(
          "SELECT id, number, display_name, text, created_at, revealed_at, status, came_true FROM seals WHERE id = ? AND capsule_id = ? AND status = 'revealed'",
        )
        .get(id, state.capsuleId) as SealRow | undefined;
      return row ? [this.card(row)] : [];
    });
    return {
      type: 'ceremony',
      stage: state.stage,
      prophet: this.prophetBanner(state.prophetSealId),
      preview: false,
      capsuleId: capsule.id,
      startedAt: state.startedAt,
      title: capsule.title,
      createdAt: capsule.createdAt,
      sealedCount: capsule.sealedCount,
      settings,
      cards,
    };
  }
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.previewAt = null;
  }
}
