import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE capsules (
        id INTEGER PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
        trigger_type TEXT NOT NULL CHECK (trigger_type IN ('date', 'followers', 'category', 'manual')),
        trigger_value TEXT NOT NULL CHECK (json_valid(trigger_value)),
        status TEXT NOT NULL DEFAULT 'sealing'
          CHECK (status IN ('sealing', 'locked', 'ready', 'opening', 'opened', 'archived')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        locked_at TEXT,
        ready_at TEXT,
        opened_at TEXT,
        settings TEXT NOT NULL DEFAULT '{"max_seals_per_user":3,"max_length":280,"vip_reward":false,"vip_days":30}'
          CHECK (json_valid(settings))
      );
      CREATE UNIQUE INDEX one_sealing_capsule ON capsules(status) WHERE status = 'sealing';

      CREATE TABLE seals (
        id INTEGER PRIMARY KEY,
        capsule_id INTEGER NOT NULL REFERENCES capsules(id),
        number INTEGER NOT NULL CHECK (number > 0),
        user_id TEXT NOT NULL,
        user_login TEXT NOT NULL,
        display_name TEXT NOT NULL,
        text TEXT NOT NULL CHECK (length(text) BETWEEN 3 AND 280),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        chat_message_id TEXT NOT NULL UNIQUE,
        hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'approved', 'rejected', 'revealed')),
        came_true INTEGER NOT NULL DEFAULT 0 CHECK (came_true IN (0, 1)),
        revealed_at TEXT,
        UNIQUE (capsule_id, number),
        UNIQUE (id, capsule_id, user_id, user_login)
      );
      CREATE INDEX seals_queue ON seals(capsule_id, status, number);
      CREATE INDEX seals_by_user ON seals(capsule_id, user_id);

      CREATE TABLE prophets (
        id INTEGER PRIMARY KEY,
        capsule_id INTEGER NOT NULL REFERENCES capsules(id),
        seal_id INTEGER NOT NULL UNIQUE,
        user_id TEXT NOT NULL,
        user_login TEXT NOT NULL,
        vip_granted_at TEXT,
        vip_expires_at TEXT,
        vip_removed_at TEXT,
        vip_error TEXT,
        FOREIGN KEY (seal_id, capsule_id, user_id, user_login)
          REFERENCES seals(id, capsule_id, user_id, user_login)
      );
      CREATE INDEX prophets_expiry ON prophets(vip_expires_at)
        WHERE vip_granted_at IS NOT NULL AND vip_removed_at IS NULL;

      CREATE TABLE events_log (
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        type TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload))
      );
    `,
  },
  {
    version: 2,
    name: 'capsule_channel_identity',
    sql: `
      ALTER TABLE capsules ADD COLUMN broadcaster_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE capsules ADD COLUMN channel_login TEXT NOT NULL DEFAULT '';
      ALTER TABLE capsules ADD COLUMN channel_name TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    version: 3,
    name: 'capsule_opening_schedule',
    sql: `
      ALTER TABLE capsules ADD COLUMN opening_due_at TEXT;
      ALTER TABLE capsules ADD COLUMN postponed_until TEXT;
      CREATE UNIQUE INDEX one_opening_capsule ON capsules(status) WHERE status = 'opening';
    `,
  },
  {
    version: 4,
    name: 'ceremony_runtime',
    sql: `
      CREATE TABLE ceremony_runtime (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state TEXT NOT NULL CHECK (json_valid(state)),
        settings TEXT NOT NULL CHECK (json_valid(settings))
      );
    `,
  },
  {
    version: 5,
    name: 'prophet_rewards',
    sql: `
      ALTER TABLE prophets ADD COLUMN created_at TEXT;
      ALTER TABLE prophets ADD COLUMN vip_status TEXT NOT NULL DEFAULT 'off';
      ALTER TABLE prophets ADD COLUMN chat_attempted_at TEXT;
      ALTER TABLE prophets ADD COLUMN chat_announced_at TEXT;
      ALTER TABLE prophets ADD COLUMN chat_error TEXT;
      CREATE TABLE vip_awards (
        broadcaster_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('granting', 'owned', 'uncertain', 'removing', 'released')),
        granted_at TEXT,
        expires_at TEXT NOT NULL,
        removed_at TEXT,
        error TEXT,
        PRIMARY KEY (broadcaster_id, user_id)
      );
      CREATE INDEX vip_awards_due ON vip_awards(status, expires_at);
    `,
  },
  {
    version: 6,
    name: 'persistent_record_ids',
    sql: `
      CREATE TABLE record_ids (
        entity TEXT PRIMARY KEY CHECK (entity IN ('capsules', 'seals')),
        last_id INTEGER NOT NULL CHECK (last_id >= 0)
      );
      INSERT INTO record_ids VALUES ('capsules', (SELECT COALESCE(MAX(id), 0) FROM capsules));
      INSERT INTO record_ids VALUES ('seals', (SELECT COALESCE(MAX(id), 0) FROM seals));
    `,
  },
  {
    version: 7,
    name: 'large_prophet_collections',
    sql: `
      CREATE INDEX seals_showcase ON seals(capsule_id, came_true, status, number);
      CREATE INDEX seals_revealed_list ON seals(status, came_true, revealed_at DESC, id DESC);
      CREATE INDEX prophets_wall ON prophets(capsule_id, user_id, id);
    `,
  },
  {
    version: 8,
    name: 'showcase_playback_progress',
    sql: `ALTER TABLE ceremony_runtime ADD COLUMN showcase TEXT NOT NULL DEFAULT '{}';`,
  },
];

export function migrateDatabase(
  db: Database.Database,
  steps: readonly Migration[] = migrations,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
  const apply = db.transaction(() => {
    for (const migration of steps) {
      const applied = db
        .prepare('SELECT version FROM schema_migrations WHERE version = ?')
        .get(migration.version);
      if (applied) continue;
      db.exec(migration.sql);
      db.prepare(
        'INSERT INTO schema_migrations (version, name) VALUES (?, ?)',
      ).run(migration.version, migration.name);
    }
  });
  apply.immediate();
}
