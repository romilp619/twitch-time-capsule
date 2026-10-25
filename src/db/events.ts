import type Database from 'better-sqlite3';

export interface LogEvent {
  id: number;
  at: string;
  type: string;
  payload: Record<string, unknown>;
}
export class EventLog {
  constructor(
    private readonly db: Database.Database,
    private readonly changed: () => void = () => {},
    private readonly secrets: () => string[] = () => [],
  ) {}
  private clean(value: unknown, depth = 0): unknown {
    if (depth > 4) return '[omitted]';
    if (typeof value === 'string') {
      let text = value;
      for (const secret of this.secrets())
        if (secret.length >= 6) text = text.split(secret).join('[redacted]');
      return text.slice(0, 1000);
    }
    if (
      value === null ||
      typeof value === 'boolean' ||
      typeof value === 'number'
    )
      return value;
    if (Array.isArray(value))
      return value.slice(0, 30).map((entry) => this.clean(entry, depth + 1));
    if (typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .slice(0, 25)
          .map(([key, item]) => [
            key,
            /token|secret|authorization|key|reconnect_url/i.test(key)
              ? '[redacted]'
              : this.clean(item, depth + 1),
          ]),
      );
    return '[omitted]';
  }
  write(type: string, payload: Record<string, unknown> = {}): void {
    const insert = this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO events_log (type, payload) VALUES (?, ?)')
        .run(type.slice(0, 100), JSON.stringify(this.clean(payload)));
      this.db.exec(
        'DELETE FROM events_log WHERE id <= (SELECT COALESCE(MAX(id), 0) - 1000 FROM events_log)',
      );
    });
    insert();
    this.changed();
  }
  latest(): LogEvent[] {
    const rows = this.db
      .prepare(
        'SELECT id, at, type, payload FROM events_log ORDER BY id DESC LIMIT 100',
      )
      .all() as Array<{
      id: number;
      at: string;
      type: string;
      payload: string;
    }>;
    return rows.map((row) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        payload = { message: 'Log payload unavailable.' };
      }
      // Re-redact old rows against currently configured credentials as well.
      return {
        ...row,
        payload: this.clean(payload) as Record<string, unknown>,
      };
    });
  }
}
