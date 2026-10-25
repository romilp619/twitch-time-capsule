import {
  nextTriggerState,
  type TriggerFacts,
  type TriggerAction,
} from './triggers.js';
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import {
  CapsuleError,
  createCapsuleSchema,
  conditionText,
  type Capsule,
  type CapsuleStatus,
  type ChannelIdentity,
} from './model.js';
import { validateSealText } from './moderation.js';

interface CapsuleRow {
  id: number;
  slug: string;
  title: string;
  trigger_type: string;
  trigger_value: string;
  settings: string;
  status: CapsuleStatus;
  created_at: string;
  locked_at: string | null;
  opened_at: string | null;
  ready_at: string | null;
  opening_due_at: string | null;
  postponed_until: string | null;
  broadcaster_id: string;
  channel_login: string;
  channel_name: string;
  sealed_count: number;
  visible_count: number;
}
export interface SealInput {
  broadcasterId: string;
  userId: string;
  userLogin: string;
  displayName: string;
  text: string;
  chatMessageId: string;
}
export interface SealReceipt {
  id: number;
  capsuleId: number;
  number: number;
  userLogin: string;
  capsule: Capsule;
}
const summarySql =
  'SELECT c.*, COUNT(s.id) AS sealed_count, COALESCE(SUM(s.hidden = 0), 0) AS visible_count FROM capsules c LEFT JOIN seals s ON s.capsule_id = c.id';
export class CapsuleStore {
  constructor(
    private readonly db: Database.Database,
    private readonly changed: () => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}
  private capsule(row: CapsuleRow): Capsule {
    const input = createCapsuleSchema.parse({
      title: row.title,
      triggerType: row.trigger_type,
      triggerValue: JSON.parse(row.trigger_value) as unknown,
      settings: JSON.parse(row.settings) as unknown,
    });
    return {
      ...input,
      id: row.id,
      slug: row.slug,
      status: row.status,
      createdAt: row.created_at,
      lockedAt: row.locked_at,
      openedAt: row.opened_at,
      readyAt: row.ready_at,
      openingDueAt: row.opening_due_at,
      postponedUntil: row.postponed_until,
      channel: {
        id: row.broadcaster_id,
        login: row.channel_login,
        displayName: row.channel_name,
      },
      sealedCount: row.sealed_count,
      visibleCount: row.visible_count,
    };
  }
  list(): Capsule[] {
    return (
      this.db
        .prepare(
          summarySql +
            " GROUP BY c.id ORDER BY (c.status = 'sealing') DESC, c.id DESC LIMIT 200",
        )
        .all() as CapsuleRow[]
    ).map((row) => this.capsule(row));
  }
  get(id: number): Capsule | null {
    const row = this.db
      .prepare(summarySql + ' WHERE c.id = ? GROUP BY c.id')
      .get(id) as CapsuleRow | undefined;
    return row ? this.capsule(row) : null;
  }
  bySlug(slug: string): Capsule | null {
    const row = this.db
      .prepare(summarySql + ' WHERE c.slug = ? GROUP BY c.id')
      .get(slug) as CapsuleRow | undefined;
    return row ? this.capsule(row) : null;
  }
  active(broadcasterId: string): Capsule | null {
    const row = this.db
      .prepare(
        summarySql +
          " WHERE c.status = 'sealing' AND c.broadcaster_id = ? GROUP BY c.id",
      )
      .get(broadcasterId) as CapsuleRow | undefined;
    return row ? this.capsule(row) : null;
  }
  waiting(broadcasterId: string): Capsule[] {
    return (
      this.db
        .prepare(
          summarySql +
            " WHERE c.broadcaster_id = ? AND c.status IN ('sealing', 'locked', 'ready') GROUP BY c.id ORDER BY c.id",
        )
        .all(broadcasterId) as CapsuleRow[]
    ).map((row) => this.capsule(row));
  }
  hasOpening(): boolean {
    return Boolean(
      this.db.prepare("SELECT id FROM capsules WHERE status = 'opening'").get(),
    );
  }
  trigger(
    id: number,
    facts: TriggerFacts,
    action: TriggerAction = 'check',
  ): Capsule {
    let changed = false;
    this.db
      .transaction(() => {
        const capsule = this.get(id);
        if (!capsule) throw new CapsuleError(404, 'Capsule not found.');
        const next = nextTriggerState(
          capsule,
          {
            ...facts,
            openingAllowed:
              facts.openingAllowed !== false && !this.hasOpening(),
          },
          action,
        );
        if (
          next.status === capsule.status &&
          next.readyAt === capsule.readyAt &&
          next.openingDueAt === capsule.openingDueAt &&
          next.postponedUntil === capsule.postponedUntil
        )
          return;
        this.db
          .prepare(
            "UPDATE capsules SET status = ?, ready_at = ?, opening_due_at = ?, postponed_until = ?, locked_at = CASE WHEN ? IN ('ready', 'opening') THEN COALESCE(locked_at, ?) ELSE locked_at END WHERE id = ?",
          )
          .run(
            next.status,
            next.readyAt,
            next.openingDueAt,
            next.postponedUntil,
            next.status,
            new Date(facts.now).toISOString(),
            id,
          );
        changed = true;
      })
      .immediate();
    if (changed) this.changed();
    return this.get(id)!;
  }
  create(raw: unknown, channel: ChannelIdentity): Capsule {
    const result = createCapsuleSchema.safeParse(raw);
    if (!result.success)
      throw new CapsuleError(
        400,
        'Check the capsule title, opening condition, and limits.',
      );
    const input = result.data;
    if (!channel.id || !channel.login)
      throw new CapsuleError(
        409,
        'Connect the streamer account before creating a capsule.',
      );
    if (
      input.triggerType === 'date' &&
      Date.parse(input.triggerValue) <= this.now()
    )
      throw new CapsuleError(400, 'Choose an opening date in the future.');
    const stem =
      input.title
        .normalize('NFKD')
        .replace(/\p{Mark}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .slice(0, 60)
        .replace(/-+$/u, '') || 'capsule';
    const slug = stem + '-' + randomBytes(5).toString('hex');
    const create = this.db.transaction(() => {
      if (
        this.db
          .prepare("SELECT id FROM capsules WHERE status = 'sealing'")
          .get()
      )
        throw new CapsuleError(
          409,
          'Lock or archive the current sealing capsule before creating another.',
        );
      return this.db
        .prepare(
          'INSERT INTO capsules (slug, title, trigger_type, trigger_value, settings, broadcaster_id, channel_login, channel_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          slug,
          input.title,
          input.triggerType,
          JSON.stringify(input.triggerValue),
          JSON.stringify(input.settings),
          channel.id,
          channel.login,
          channel.displayName,
          new Date(this.now()).toISOString(),
        ).lastInsertRowid;
    });
    const id = Number(create.immediate());
    this.changed();
    const capsule = this.get(id);
    if (!capsule) throw new Error('Capsule creation failed.');
    return capsule;
  }
  changeStatus(id: number, action: 'lock' | 'archive'): Capsule {
    const update = this.db.transaction(() => {
      const capsule = this.get(id);
      if (!capsule) throw new CapsuleError(404, 'Capsule not found.');
      const next = action === 'lock' ? 'locked' : 'archived';
      if (capsule.status === next) return;
      if (action === 'lock' && capsule.status !== 'sealing')
        throw new CapsuleError(409, 'Only a sealing capsule can be locked.');
      if (
        action === 'archive' &&
        !['sealing', 'locked', 'ready', 'opened'].includes(capsule.status)
      )
        throw new CapsuleError(
          409,
          'This capsule cannot be archived during an opening.',
        );
      this.db
        .prepare(
          'UPDATE capsules SET status = ?, locked_at = COALESCE(locked_at, ?) WHERE id = ?',
        )
        .run(next, new Date(this.now()).toISOString(), id);
    });
    update.immediate();
    this.changed();
    const capsule = this.get(id);
    if (!capsule) throw new Error('Capsule status update failed.');
    return capsule;
  }
  acceptSeal(
    input: SealInput,
    blocked: (text: string) => boolean = () => false,
  ): SealReceipt | null {
    const insert = this.db.transaction(() => {
      if (
        this.db
          .prepare('SELECT id FROM seals WHERE chat_message_id = ?')
          .get(input.chatMessageId)
      )
        return null;
      const capsule = this.active(input.broadcasterId);
      if (!capsule)
        throw new CapsuleError(
          409,
          'No capsule is open for sealing right now.',
        );
      const text = input.text.trim();
      validateSealText(text, capsule.settings.max_length);
      if (blocked(text))
        throw new CapsuleError(400, 'That message contains a blocked word.');
      const usage = this.db
        .prepare(
          'SELECT COUNT(*) AS count, MAX(created_at) AS last_at FROM seals WHERE capsule_id = ? AND user_id = ?',
        )
        .get(capsule.id, input.userId) as {
        count: number;
        last_at: string | null;
      };
      if (usage.count >= capsule.settings.max_seals_per_user)
        throw new CapsuleError(
          429,
          "You have reached this capsule's per-user seal limit.",
        );
      if (usage.last_at && this.now() - Date.parse(usage.last_at) < 10_000)
        throw new CapsuleError(429, 'Wait 10 seconds between seals.');
      const row = this.db
        .prepare(
          'SELECT COALESCE(MAX(number), 0) + 1 AS next FROM seals WHERE capsule_id = ?',
        )
        .get(capsule.id) as { next: number };
      const result = this.db
        .prepare(
          'INSERT INTO seals (capsule_id, number, user_id, user_login, display_name, text, created_at, chat_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          capsule.id,
          row.next,
          input.userId,
          input.userLogin,
          input.displayName,
          text,
          new Date(this.now()).toISOString(),
          input.chatMessageId,
        );
      return {
        id: Number(result.lastInsertRowid),
        capsuleId: capsule.id,
        number: row.next,
        userLogin: input.userLogin,
        capsule,
      };
    });
    const result = insert.immediate();
    if (result) this.changed();
    return result;
  }
  setHidden(id: number, hidden: boolean): void {
    this.db
      .prepare('UPDATE seals SET hidden = ? WHERE id = ?')
      .run(hidden ? 1 : 0, id);
    this.changed();
  }
  publicView(slug: string) {
    const row = this.db
      .prepare(summarySql + ' WHERE c.slug = ? GROUP BY c.id')
      .get(slug) as CapsuleRow | undefined;
    if (!row) return null;
    const capsule = this.capsule(row);
    // Explicit allow-list: never spread rows or return viewer identities/texts.
    return {
      slug: capsule.slug,
      title: capsule.title,
      status: capsule.status,
      channel: {
        login: capsule.channel.login,
        displayName: capsule.channel.displayName,
      },
      triggerType: capsule.triggerType,
      triggerValue: capsule.triggerValue,
      condition: conditionText(capsule, this.now()),
      createdAt: capsule.createdAt,
      sealedCount: capsule.sealedCount,
      maxLength: capsule.settings.max_length,
      maxSealsPerUser: capsule.settings.max_seals_per_user,
    };
  }
}
