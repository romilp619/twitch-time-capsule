import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrateDatabase } from './migrations.js';

export function openDatabase(path: string): Database.Database {
  if (path !== ':memory:')
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
    migrateDatabase(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
