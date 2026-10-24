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
