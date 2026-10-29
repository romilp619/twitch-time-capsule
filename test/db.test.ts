import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { migrateDatabase } from '../src/db/migrations.js';
import { temporaryProject } from './helpers.js';

const databases: Database.Database[] = [];
const cleanup: Array<() => void> = [];
afterEach(() => {
  databases.splice(0).forEach((db) => {
    if (db.open) db.close();
  });
  cleanup.splice(0).forEach((fn) => fn());
});
function memory() {
  const db = openDatabase(':memory:');
  databases.push(db);
  return db;
}
function capsule(db: Database.Database, slug: string, status = 'sealing') {
  return db
    .prepare(
      "INSERT INTO capsules (slug, title, trigger_type, trigger_value, status) VALUES (?, 'Future chat', 'manual', 'null', ?)",
    )
    .run(slug, status).lastInsertRowid;
}

describe('SQLite migrations', () => {
  it('creates the schema once and enables foreign keys', () => {
    const db = memory();
    migrateDatabase(db);
    expect(db.prepare('SELECT name FROM schema_migrations').all()).toEqual([
      { name: 'initial_schema' },
      { name: 'capsule_channel_identity' },
      { name: 'capsule_opening_schedule' },
      { name: 'ceremony_runtime' },
      { name: 'prophet_rewards' },
    ]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),
    ).toEqual(
      expect.arrayContaining([
        { name: 'capsules' },
        { name: 'seals' },
        { name: 'prophets' },
        { name: 'events_log' },
      ]),
    );
  });
  it('persists records across reopening a file database', () => {
    const project = temporaryProject();
    cleanup.push(project.cleanup);
    const path = resolve(project.root, 'data', 'capsule.db');
    const db = openDatabase(path);
    capsule(db, 'kept');
    db.close();
    const reopened = openDatabase(path);
    databases.push(reopened);
    expect(reopened.prepare('SELECT slug FROM capsules').get()).toEqual({
      slug: 'kept',
    });
  });
  it('allows only one sealing capsule while allowing multiple locked capsules', () => {
    const db = memory();
    capsule(db, 'first');
    expect(() => capsule(db, 'second')).toThrow('UNIQUE');
    capsule(db, 'locked-1', 'locked');
    capsule(db, 'locked-2', 'locked');
  });
  it('rejects orphan seals and duplicate seal numbers or chat message IDs', () => {
    const db = memory();
    const id = capsule(db, 'first');
    const insert = db.prepare(
      "INSERT INTO seals (capsule_id, number, user_id, user_login, display_name, text, chat_message_id) VALUES (?, ?, 'u', 'viewer', 'Viewer', 'The future is bright', ?)",
    );
    expect(() => insert.run(999, 1, 'orphan')).toThrow('FOREIGN KEY');
    insert.run(id, 1, 'message-1');
    expect(() => insert.run(id, 1, 'message-2')).toThrow('UNIQUE');
    expect(() => insert.run(id, 2, 'message-1')).toThrow('UNIQUE');
  });
  it('rolls back a failed migration including its history entry', () => {
    const db = memory();
    expect(() =>
      migrateDatabase(db, [
        {
          version: 6,
          name: 'broken',
          sql: 'CREATE TABLE should_rollback (id INTEGER); INSERT INTO missing_table VALUES (1);',
        },
      ]),
    ).toThrow();
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE name='should_rollback'")
        .get(),
    ).toBeUndefined();
    expect(
      db.prepare('SELECT version FROM schema_migrations WHERE version=6').get(),
    ).toBeUndefined();
  });
});
