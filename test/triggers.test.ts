import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { CapsuleStore } from '../src/capsule/store.js';
import {
  nextTriggerState,
  type TriggerFacts,
} from '../src/capsule/triggers.js';
import type { Capsule, CapsuleInput } from '../src/capsule/model.js';
const dbs: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
const epoch = Date.parse('2026-10-25T10:00:00Z');
const owner = { id: '1', login: 'streamer', displayName: 'Streamer' };
function capsule(input: Partial<CapsuleInput> = {}): Capsule {
  const db = openDatabase(':memory:');
  dbs.push(db);
  return new CapsuleStore(
    db,
    () => {},
    () => epoch,
  ).create({ title: 'The future', triggerType: 'manual', ...input }, owner);
}
function facts(overrides: Partial<TriggerFacts> = {}): TriggerFacts {
  return {
    now: epoch,
    live: false,
    followers: null,
    categoryId: null,
    offlineDelayMs: 60_000,
    ...overrides,
  };
}
function advance(
  c: Capsule,
  f: TriggerFacts,
  action: 'check' | 'open' | 'postpone' = 'check',
): Capsule {
  return { ...c, ...nextTriggerState(c, f, action) };
}
describe('Pure trigger decisions', () => {
  it('does not trigger a manual capsule without an explicit action', () => {
    const c = capsule();
    const original = structuredClone(c);
    expect(
      nextTriggerState(
        c,
        facts({ live: true, followers: 999, categoryId: '32982' }),
      ).status,
    ).toBe('sealing');
    expect(c).toEqual(original);
  });
  it('makes a reached date ready offline and never opens it offline', () => {
    const c = capsule({
      triggerType: 'date',
      triggerValue: new Date(epoch + 1000).toISOString(),
    });
    expect(nextTriggerState(c, facts()).status).toBe('sealing');
    const ready = advance(c, facts({ now: epoch + 1000 }));
    expect(ready.status).toBe('ready');
    expect(ready.openingDueAt).toBeNull();
    expect(
      nextTriggerState(ready, facts({ now: epoch + 9999999 })).status,
    ).toBe('ready');
  });
  it('uses the authoritative follower total and handles unknown or below-goal facts', () => {
    const c = capsule({ triggerType: 'followers', triggerValue: 1000 });
    for (const followers of [null, 999])
      expect(nextTriggerState(c, facts({ followers })).status).toBe('sealing');
    expect(nextTriggerState(c, facts({ followers: 1000 })).status).toBe(
      'ready',
    );
    expect(nextTriggerState(c, facts({ followers: 1001 })).status).toBe(
      'ready',
    );
  });
  it('compares category ID and requires live for first-stream category triggers', () => {
    const c = capsule({
      triggerType: 'category',
      triggerValue: { category_id: '32982', category_name: 'Same name' },
    });
    expect(nextTriggerState(c, facts({ categoryId: '32982' })).status).toBe(
      'sealing',
    );
    expect(
      nextTriggerState(c, facts({ live: true, categoryId: '999' })).status,
    ).toBe('sealing');
    expect(
      nextTriggerState(c, facts({ live: true, categoryId: '32982' })).status,
    ).toBe('ready');
    const renamed = {
      ...c,
      triggerValue: { category_id: '32982', category_name: 'Renamed game' },
    } as Capsule;
    expect(
      nextTriggerState(renamed, facts({ live: true, categoryId: '32982' }))
        .status,
    ).toBe('ready');
  });
  it('waits exactly five seconds when the condition is reached live', () => {
    const c = capsule({ triggerType: 'followers', triggerValue: 1 });
    const ready = advance(c, facts({ live: true, followers: 1 }));
    expect(ready.openingDueAt).toBe(new Date(epoch + 5000).toISOString());
    expect(
      nextTriggerState(ready, facts({ live: true, now: epoch + 4999 })).status,
    ).toBe('ready');
    expect(
      nextTriggerState(ready, facts({ live: true, now: epoch + 5000 })).status,
    ).toBe('opening');
  });
  it('waits the configured settling delay for a capsule that was ready offline', () => {
    const ready = advance(capsule(), facts(), 'open');
    const live = advance(
      ready,
      facts({ live: true, now: epoch + 1000, offlineDelayMs: 90_000 }),
    );
    expect(live.openingDueAt).toBe(new Date(epoch + 91_000).toISOString());
    expect(
      nextTriggerState(live, facts({ live: true, now: epoch + 90_999 })).status,
    ).toBe('ready');
    expect(
      nextTriggerState(live, facts({ live: true, now: epoch + 91_000 })).status,
    ).toBe('opening');
  });
  it('cancels a countdown offline or when live status is unknown and starts a fresh delay next live', () => {
    const ready = advance(capsule(), facts({ live: true }), 'open');
    for (const live of [false, null]) {
      const offline = advance(ready, facts({ live, now: epoch + 6000 }));
      expect(offline.openingDueAt).toBeNull();
      expect(
        advance(offline, facts({ live: true, now: epoch + 7000 })).openingDueAt,
      ).toBe(new Date(epoch + 67_000).toISOString());
    }
  });
  it('postpones ten minutes and open now overrides the postponement while keeping the live gate', () => {
    const ready = advance(capsule(), facts({ live: true }), 'open');
    const postponed = advance(ready, facts({ live: true }), 'postpone');
    expect(postponed.postponedUntil).toBe(
      new Date(epoch + 600_000).toISOString(),
    );
    expect(
      nextTriggerState(postponed, facts({ live: true, now: epoch + 5000 }))
        .status,
    ).toBe('ready');
    expect(
      nextTriggerState(postponed, facts({ live: true, now: epoch + 600_000 }))
        .status,
    ).toBe('opening');
    const resumed = advance(
      postponed,
      facts({ live: true, now: epoch + 10_000 }),
      'open',
    );
    expect(resumed.postponedUntil).toBeNull();
    expect(resumed.openingDueAt).toBe(new Date(epoch + 15_000).toISOString());
    expect(advance(postponed, facts(), 'open').openingDueAt).toBeNull();
  });
  it('keeps the first live deadline when Open now is clicked repeatedly', () => {
    let ready = advance(capsule(), facts({ live: true }), 'open');
    const due = ready.openingDueAt;
    for (const elapsed of [1000, 2000, 4000, 5000]) {
      ready = advance(
        ready,
        facts({ live: true, now: epoch + elapsed, openingAllowed: false }),
        'open',
      );
      expect(ready.openingDueAt).toBe(due);
    }
    expect(
      advance(ready, facts({ live: true, now: epoch + 5000 })).status,
    ).toBe('opening');
  });
  it('can shorten an offline settling delay once without resetting it on retries', () => {
    const offline = advance(capsule(), facts(), 'open');
    const live = advance(offline, facts({ live: true, now: epoch + 1000 }));
    const sooner = advance(
      live,
      facts({ live: true, now: epoch + 2000 }),
      'open',
    );
    expect(sooner.openingDueAt).toBe(new Date(epoch + 7000).toISOString());
    expect(
      advance(sooner, facts({ live: true, now: epoch + 6000 }), 'open')
        .openingDueAt,
    ).toBe(sooner.openingDueAt);
  });
  it('supports postponing before a condition is reached without replacing that condition', () => {
    const c = capsule({ triggerType: 'followers', triggerValue: 10 });
    const postponed = advance(c, facts(), 'postpone');
    expect(postponed.status).toBe('sealing');
    expect(advance(postponed, facts({ live: true, followers: 9 })).status).toBe(
      'sealing',
    );
    const ready = advance(postponed, facts({ live: true, followers: 10 }));
    expect(ready.openingDueAt).toBe(postponed.postponedUntil);
  });
  it('leaves terminal states unchanged and respects another active opening', () => {
    for (const status of ['opening', 'opened', 'archived'] as const) {
      const c = { ...capsule(), status };
      expect(nextTriggerState(c, facts({ live: true }), 'open').status).toBe(
        status,
      );
      expect(
        nextTriggerState(c, facts(), 'postpone').postponedUntil,
      ).toBeNull();
    }
    const ready = advance(capsule(), facts({ live: true }), 'open');
    expect(
      nextTriggerState(
        ready,
        facts({ live: true, now: epoch + 5000, openingAllowed: false }),
      ).status,
    ).toBe('ready');
  });
});
