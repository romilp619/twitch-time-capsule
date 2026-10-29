import {
  ceremonyStateSchema,
  idleCeremony,
  isCeremonyActive,
} from './ceremony-state.js';
import type Database from 'better-sqlite3';
import type { EventLog } from '../db/events.js';
import { TwitchError } from '../twitch/http.js';
import { CapsuleError, settingsSchema } from './model.js';

export interface ProphetTwitch {
  isVip(channel: string, user: string): Promise<boolean>;
  changeVip(channel: string, user: string, remove?: boolean): Promise<void>;
  announce(channel: string, text: string): Promise<unknown>;
  currentChannel(): string | undefined;
}
interface RewardRow {
  id: number;
  capsule_id: number;
  number: number;
  display_name: string;
  user_id: string;
  user_login: string;
  text: string;
  status: string;
  broadcaster_id: string;
  capsule_status: string;
  title: string;
  settings: string;
  came_true: number;
  vip_status: string | null;
  vip_error: string | null;
  vip_granted_at: string | null;
  vip_expires_at: string | null;
  vip_removed_at: string | null;
  chat_attempted_at: string | null;
  chat_announced_at: string | null;
  chat_error: string | null;
}
interface Award {
  broadcaster_id: string;
  user_id: string;
  status: 'granting' | 'owned' | 'uncertain' | 'removing' | 'released';
  granted_at: string | null;
  expires_at: string;
  error: string | null;
}
const rowsSql = `SELECT s.*, c.broadcaster_id, c.title, c.settings, c.status AS capsule_status,
 p.vip_status, p.vip_error, p.vip_granted_at, p.vip_expires_at, p.vip_removed_at,
 p.chat_attempted_at, p.chat_announced_at, p.chat_error
 FROM seals s JOIN capsules c ON c.id=s.capsule_id
 LEFT JOIN prophets p ON p.seal_id=s.id`;
export function vipErrorMessage(error: unknown, removing = false): string {
  const code = error instanceof TwitchError ? error.status : 0;
  const messages: Record<number, string> = {
    400: 'Twitch rejected the channel or viewer ID. Check the connected channel.',
    401: 'Reconnect the streamer account with channel:manage:vips permission.',
    403: 'Only the broadcaster can manage these VIP rewards. Reconnect the streamer.',
    404: 'Twitch could not find this channel or viewer.',
    409: 'No free VIP slots. Free a slot in Twitch, then retry VIP.',
    422: removing
      ? 'This viewer is no longer a VIP.'
      : 'This viewer is a moderator or already a VIP. Existing roles are preserved.',
    425: 'Complete Twitch’s Build a Community achievement before granting VIP.',
    429: 'Too many VIP changes. Wait at least 10 seconds, then retry.',
  };
  return (
    messages[code] ??
    'Twitch could not confirm the VIP change. Check the viewer’s role in Twitch before retrying.'
  );
}
// Only confirmed app-owned awards are selected. An interrupted network operation
// never establishes ownership of an existing VIP role.
export function expiredVipAwards(db: Database.Database, now: number): Award[] {
  return db
    .prepare(
      "SELECT * FROM vip_awards WHERE status='owned' AND expires_at <= ? ORDER BY expires_at",
    )
    .all(new Date(now).toISOString()) as Award[];
}
export class Prophets {
  private timer: ReturnType<typeof setInterval> | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private warning: string | null = null;
  constructor(
    private readonly db: Database.Database,
    private readonly twitch: ProphetTwitch,
    private readonly log: EventLog,
    private readonly changed: () => void,
    private readonly onProphet: (sealId: number, capsuleId: number) => void,
    private readonly now: () => number = Date.now,
  ) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(new CapsuleError(503, 'Rewards are stopping.'));
    const operation = this.tail.then(work);
    this.tail = operation.catch(() => {});
    return operation;
  }
  // Deletion shares the reward queue so an in-flight grant or announcement can finish first.
  withRewardLock<T>(work: () => T): Promise<T> {
    return this.serial(async () => work());
  }
  private row(id: number): RewardRow {
    const row = this.db.prepare(rowsSql + ' WHERE s.id=?').get(id) as
      RewardRow | undefined;
    if (!row || row.status !== 'revealed')
      throw new CapsuleError(
        409,
        'Only a revealed message can become a Prophet.',
      );
    return row;
  }
  private checkChannel(row: RewardRow): void {
    const current = this.twitch.currentChannel();
    if (current && current !== row.broadcaster_id)
      throw new CapsuleError(
        409,
        'Reconnect the channel that owns this capsule before changing its rewards.',
      );
  }
  list(offset = 0, limit = 50) {
    const rows = this.db
      .prepare(
        rowsSql +
          " WHERE s.status='revealed' ORDER BY s.revealed_at DESC, s.id DESC LIMIT ? OFFSET ?",
      )
      .all(limit, offset) as RewardRow[];
    const { total } = this.db
      .prepare("SELECT COUNT(*) AS total FROM seals WHERE status='revealed'")
      .get() as { total: number };
    return {
      total,
      offset,
      limit,
      warnings: this.warning ? [this.warning] : [],
      seals: rows.map((row) => ({
        id: row.id,
        capsuleId: row.capsule_id,
        title: row.title,
        number: row.number,
        displayName: row.display_name,
        text: row.text,
        cameTrue: Boolean(row.came_true),
        canDelete: row.capsule_status !== 'opening',
        vipEnabled: settingsSchema.parse(JSON.parse(row.settings) as unknown)
          .vip_reward,
        vipStatus: row.vip_status,
        vipRetryable:
          ['error', 'pending', 'uncertain'].includes(row.vip_status ?? '') &&
          !row.vip_granted_at,
        vipError: row.vip_error,
        vipExpiresAt: row.vip_expires_at,
        chatError: row.chat_error,
        chatAnnounced: Boolean(row.chat_announced_at),
      })),
    };
  }
  deletePredictions(id?: number): Promise<number> {
    return this.serial(async () => {
      const deleted = this.db
        .transaction(() => {
          const where =
            " WHERE status = 'revealed'" +
            (id === undefined ? '' : ' AND id = ?');
          const params = id === undefined ? [] : [id];
          const targets = this.db
            .prepare('SELECT id, capsule_id FROM seals' + where)
            .all(...params) as Array<{ id: number; capsule_id: number }>;
          if (id !== undefined && !targets.length)
            throw new CapsuleError(404, 'Revealed prediction not found.');
          const capsuleIds = new Set(targets.map((row) => row.capsule_id));
          const runtime = this.db
            .prepare('SELECT state FROM ceremony_runtime WHERE id = 1')
            .get() as { state: string } | undefined;
          const state = runtime
            ? ceremonyStateSchema.parse(JSON.parse(runtime.state) as unknown)
            : null;
          const touchesCeremony =
            state?.capsuleId != null && capsuleIds.has(state.capsuleId);
          const opening = this.db
            .prepare(
              "SELECT id FROM capsules WHERE status = 'opening' AND id IN (SELECT capsule_id FROM seals" +
                where +
                ')',
            )
            .get(...params);
          if (opening || (touchesCeremony && state && isCeremonyActive(state)))
            throw new CapsuleError(
              409,
              'End the opening ceremony before deleting its predictions.',
            );
          this.db
            .prepare(
              'DELETE FROM prophets WHERE seal_id IN (SELECT id FROM seals' +
                where +
                ')',
            )
            .run(...params);
          const result = this.db
            .prepare('DELETE FROM seals' + where)
            .run(...params);
          if (touchesCeremony)
            this.db
              .prepare('UPDATE ceremony_runtime SET state = ? WHERE id = 1')
              .run(JSON.stringify(idleCeremony()));
          return result.changes;
        })
        .immediate();
      this.log.write(
        id === undefined ? 'prophet.deleted_all' : 'prophet.deleted',
        { count: deleted, ...(id === undefined ? {} : { sealId: id }) },
      );
      this.changed();
      return deleted;
    });
  }
  mark(id: number): Promise<void> {
    return this.serial(async () => {
      const row = this.row(id);
      this.checkChannel(row);
      if (row.came_true) return;
      const settings = settingsSchema.parse(
        JSON.parse(row.settings) as unknown,
      );
      this.db
        .transaction(() => {
          this.db.prepare('UPDATE seals SET came_true=1 WHERE id=?').run(id);
          this.db
            .prepare(
              `INSERT INTO prophets (capsule_id, seal_id, user_id, user_login, created_at, vip_status)
          VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
              row.capsule_id,
              id,
              row.user_id,
              row.user_login,
              new Date(this.now()).toISOString(),
              settings.vip_reward ? 'pending' : 'off',
            );
        })
        .immediate();
      this.onProphet(id, row.capsule_id);
      this.log.write('prophet.marked', {
        capsuleId: row.capsule_id,
        sealId: id,
      });
      this.changed();
      if (settings.vip_reward) await this.grant(this.row(id));
      await this.announce(this.row(id));
      this.changed();
    });
  }
  retry(id: number, action: 'vip' | 'chat'): Promise<void> {
    return this.serial(async () => {
      const row = this.row(id);
      this.checkChannel(row);
      if (!row.came_true)
        throw new CapsuleError(409, 'Mark this prediction as true first.');
      if (action === 'chat') {
        if (row.chat_announced_at)
          throw new CapsuleError(409, 'This Prophet was already announced.');
        await this.announce(row);
      } else {
        if (
          !['error', 'uncertain', 'pending'].includes(row.vip_status ?? '') ||
          row.vip_granted_at
        )
          throw new CapsuleError(409, 'This reward does not need a VIP retry.');
        await this.grant(row);
      }
      this.changed();
    });
  }
  private award(row: RewardRow): Award | undefined {
    return this.db
      .prepare('SELECT * FROM vip_awards WHERE broadcaster_id=? AND user_id=?')
      .get(row.broadcaster_id, row.user_id) as Award | undefined;
  }
  private async grant(row: RewardRow): Promise<void> {
    const settings = settingsSchema.parse(JSON.parse(row.settings) as unknown);
    if (!settings.vip_reward) return;
    try {
      const expires = new Date(
        this.now() + settings.vip_days * 86400_000,
      ).toISOString();
      const award = this.award(row);
      const existing = await this.twitch.isVip(row.broadcaster_id, row.user_id);
      if (existing && award?.status === 'owned') {
        this.owned(
          row,
          award.granted_at!,
          expires > award.expires_at ? expires : award.expires_at,
        );
        return;
      }
      if (existing) {
        this.db
          .prepare(
            "UPDATE prophets SET vip_status='existing', vip_error=? WHERE seal_id=?",
          )
          .run(
            'Already VIP. This app will preserve that existing role and will not expire it.',
            row.id,
          );
        return;
      }
      // A stored intent survives a crash, but is never treated as a confirmed grant.
      this.db
        .prepare(
          `INSERT INTO vip_awards (broadcaster_id,user_id,status,expires_at)
        VALUES (?,?,'granting',?) ON CONFLICT(broadcaster_id,user_id)
        DO UPDATE SET status='granting',expires_at=excluded.expires_at,granted_at=NULL,removed_at=NULL,error=NULL`,
        )
        .run(row.broadcaster_id, row.user_id, expires);
      try {
        await this.twitch.changeVip(row.broadcaster_id, row.user_id);
      } catch (error) {
        const uncertain =
          !(error instanceof TwitchError) ||
          error.status === 0 ||
          error.status >= 500;
        this.db
          .prepare(
            'UPDATE vip_awards SET status=?,error=? WHERE broadcaster_id=? AND user_id=?',
          )
          .run(
            uncertain ? 'uncertain' : 'released',
            vipErrorMessage(error),
            row.broadcaster_id,
            row.user_id,
          );
        throw error;
      }
      this.owned(row, new Date(this.now()).toISOString(), expires);
      this.log.write('prophet.vip_granted', {
        sealId: row.id,
        capsuleId: row.capsule_id,
        expiresAt: expires,
      });
    } catch (error) {
      const uncertain = this.award(row)?.status === 'uncertain';
      this.db
        .prepare('UPDATE prophets SET vip_status=?,vip_error=? WHERE seal_id=?')
        .run(uncertain ? 'uncertain' : 'error', vipErrorMessage(error), row.id);
      this.log.write('prophet.vip_error', {
        sealId: row.id,
        message: vipErrorMessage(error),
      });
    } finally {
      this.changed();
    }
  }
  private owned(row: RewardRow, granted: string, expires: string): void {
    this.db
      .transaction(() => {
        this.db
          .prepare(
            "UPDATE vip_awards SET status='owned',granted_at=?,expires_at=?,error=NULL WHERE broadcaster_id=? AND user_id=?",
          )
          .run(granted, expires, row.broadcaster_id, row.user_id);
        this.db
          .prepare(
            `UPDATE prophets SET vip_status='granted',vip_granted_at=?,vip_expires_at=?,vip_removed_at=NULL,vip_error=NULL
        WHERE (seal_id=? OR (vip_status='granted' AND user_id=? AND capsule_id IN
          (SELECT id FROM capsules WHERE broadcaster_id=?)))`,
          )
          .run(granted, expires, row.id, row.user_id, row.broadcaster_id);
      })
      .immediate();
  }
  private async announce(row: RewardRow): Promise<void> {
    this.db
      .prepare(
        'UPDATE prophets SET chat_attempted_at=?,chat_error=NULL WHERE seal_id=?',
      )
      .run(new Date(this.now()).toISOString(), row.id);
    try {
      const days = settingsSchema.parse(
        JSON.parse(row.settings) as unknown,
      ).vip_days;
      await this.twitch.announce(
        row.broadcaster_id,
        '@' +
          row.user_login +
          "'s prediction came true. Prophet!" +
          (row.vip_status === 'granted' ? ' VIP for ' + days + ' days.' : ''),
      );
      this.db
        .prepare(
          'UPDATE prophets SET chat_announced_at=?,chat_error=NULL WHERE seal_id=?',
        )
        .run(new Date(this.now()).toISOString(), row.id);
      this.log.write('prophet.announced', { sealId: row.id });
    } catch {
      this.db
        .prepare('UPDATE prophets SET chat_error=? WHERE seal_id=?')
        .run(
          'The chat announcement was not confirmed. Check chat before retrying to avoid a duplicate.',
          row.id,
        );
      this.log.write('prophet.chat_error', { sealId: row.id });
    }
  }
  start(): Promise<void> {
    // Never guess whether an interrupted request changed a remote role.
    this.db
      .prepare(
        "UPDATE vip_awards SET status='uncertain',error='Interrupted VIP request. Check this role in Twitch.' WHERE status IN ('granting','removing')",
      )
      .run();
    this.db
      .prepare(
        "UPDATE prophets SET vip_status='uncertain',vip_error='Interrupted VIP request. Check Twitch before retrying.' WHERE vip_status='pending' OR (vip_status='granted' AND EXISTS (SELECT 1 FROM vip_awards a JOIN capsules c ON c.broadcaster_id=a.broadcaster_id WHERE c.id=prophets.capsule_id AND a.user_id=prophets.user_id AND a.status='uncertain'))",
      )
      .run();
    this.db
      .prepare(
        "UPDATE prophets SET chat_error='Announcement was interrupted. Check chat before retrying.' WHERE chat_announced_at IS NULL AND chat_error IS NULL",
      )
      .run();
    this.timer = setInterval(() => {
      void this.expire();
    }, 60 * 60_000);
    this.timer.unref();
    return this.expire();
  }
  expire(): Promise<void> {
    return this.serial(async () => {
      try {
        this.warning = null;
        for (const award of expiredVipAwards(this.db, this.now())) {
          if (this.twitch.currentChannel() !== award.broadcaster_id) {
            this.warning =
              'Reconnect the original streamer to remove expired VIP rewards.';
            continue;
          }
          this.db
            .prepare(
              "UPDATE vip_awards SET status='removing' WHERE broadcaster_id=? AND user_id=?",
            )
            .run(award.broadcaster_id, award.user_id);
          try {
            await this.twitch.changeVip(
              award.broadcaster_id,
              award.user_id,
              true,
            );
            this.removed(award);
          } catch (error) {
            if (error instanceof TwitchError && error.status === 422)
              this.removed(award);
            else {
              const message = vipErrorMessage(error, true);
              const uncertain =
                !(error instanceof TwitchError) ||
                error.status === 0 ||
                error.status >= 500;
              this.db
                .prepare(
                  'UPDATE vip_awards SET status=?,error=? WHERE broadcaster_id=? AND user_id=?',
                )
                .run(
                  uncertain ? 'uncertain' : 'owned',
                  message,
                  award.broadcaster_id,
                  award.user_id,
                );
              this.db
                .prepare(
                  `UPDATE prophets SET vip_error=? WHERE user_id=? AND vip_status='granted'
                AND capsule_id IN (SELECT id FROM capsules WHERE broadcaster_id=?)`,
                )
                .run(message, award.user_id, award.broadcaster_id);
              if (uncertain)
                this.db
                  .prepare(
                    `UPDATE prophets SET vip_status='uncertain',vip_error=?
                WHERE user_id=? AND vip_status='granted' AND capsule_id IN (SELECT id FROM capsules WHERE broadcaster_id=?)`,
                  )
                  .run(
                    'VIP removal was not confirmed. Automatic expiry is paused; review this viewer’s role in Twitch.',
                    award.user_id,
                    award.broadcaster_id,
                  );
              this.log.write('prophet.vip_expiry_error', { message });
            }
          }
        }
      } catch {
        this.warning =
          'VIP expiry checks failed. Check local storage and reconnect Twitch, then retry expiry.';
      }
      this.changed();
    });
  }
  private removed(award: Award): void {
    const at = new Date(this.now()).toISOString();
    this.db
      .transaction(() => {
        this.db
          .prepare(
            "UPDATE vip_awards SET status='released',removed_at=?,error=NULL WHERE broadcaster_id=? AND user_id=?",
          )
          .run(at, award.broadcaster_id, award.user_id);
        this.db
          .prepare(
            `UPDATE prophets SET vip_status='expired',vip_removed_at=?,vip_error=NULL
        WHERE user_id=? AND vip_status='granted' AND capsule_id IN (SELECT id FROM capsules WHERE broadcaster_id=?)`,
          )
          .run(at, award.user_id, award.broadcaster_id);
      })
      .immediate();
    this.log.write('prophet.vip_expired', { channelId: award.broadcaster_id });
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.tail;
  }
}
