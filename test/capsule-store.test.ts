import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { CapsuleStore, type SealInput } from '../src/capsule/store.js';
import {
  BlockedWords,
  containsBlockedWord,
  parseSealCommand,
  validateSealText,
} from '../src/capsule/moderation.js';
import { openDatabase } from '../src/db/index.js';
import { twitchProject } from './twitch-helper.js';
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
});
const owner = { id: '1', login: 'streamer', displayName: 'Streamer' };
function fixture() {
  const db = openDatabase(':memory:');
  cleanup.push(() => {
    db.close();
  });
  let now = Date.now();
  const store = new CapsuleStore(
    db,
    () => {},
    () => now,
  );
  return {
    db,
    store,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}
function seal(
  userId: string = randomUUID(),
  text = 'A prediction for tomorrow',
): SealInput {
  return {
    broadcasterId: '1',
    userId,
    userLogin: userId,
    displayName: userId,
    text,
    chatMessageId: randomUUID(),
  };
}
describe('Seal parsing and moderation', () => {
  it('parses exact commands and leaves unrelated chat alone', () => {
    expect(parseSealCommand(' !SeAl   future prediction ')).toBe(
      'future prediction',
    );
    expect(parseSealCommand('!seal')).toBe('');
    expect(parseSealCommand('!sealed text')).toBeNull();
    expect(parseSealCommand('hello !seal text')).toBeNull();
  });
  it('validates Unicode length and rejects unsafe control characters', () => {
    expect(() => validateSealText('', 280)).toThrow(
      'Add your prediction after !seal. Example: !seal',
    );
    expect(() => validateSealText('ab', 280)).toThrow('too short');
    expect(() => validateSealText('x'.repeat(281), 280)).toThrow(
      'at most 280 characters',
    );
    expect(() =>
      validateSealText(String.fromCodePoint(0x1f52e).repeat(280), 280),
    ).not.toThrow();
    expect(() =>
      validateSealText('ab' + String.fromCharCode(0) + 'cd', 280),
    ).toThrow('control');
  });
  it('matches blocked words case-insensitively with Unicode whole-word boundaries', () => {
    expect(containsBlockedWord('That is BAD!', ['bad'])).toBe(true);
    expect(containsBlockedWord('badminton is fine', ['bad'])).toBe(false);
    expect(containsBlockedWord('badger', ['bad'])).toBe(false);
    expect(containsBlockedWord('Cafe CAFÉ!', ['café'])).toBe(true);
    expect(containsBlockedWord('I use c++ today', ['c++'])).toBe(true);
    expect(
      containsBlockedWord('Two blocked words here', ['blocked words']),
    ).toBe(true);
  });
  it('reloads the editable blocked-word list and fails closed if it becomes unreadable', () => {
    const project = twitchProject();
    cleanup.push(project.cleanup);
    const words = new BlockedWords(project.config.dataDir);
    writeFileSync(words.path, '# comment\nbad\n');
    expect(words.contains('BAD!')).toBe(true);
    writeFileSync(words.path, 'different\n');
    expect(words.contains('bad')).toBe(false);
    expect(words.contains('different')).toBe(true);
    writeFileSync(words.path, 'x'.repeat(65 * 1024));
    expect(() => words.contains('hello')).toThrow('Cannot read blocked words');
  });
});
describe('Transactional capsules and seals', () => {
  it('creates all four condition types with defaults and channel ownership', () => {
    const { store } = fixture();
    const conditions = [
      { triggerType: 'manual', triggerValue: null },
      {
        triggerType: 'date',
        triggerValue: new Date(Date.now() + 86400_000).toISOString(),
      },
      { triggerType: 'followers', triggerValue: 1000 },
      {
        triggerType: 'category',
        triggerValue: {
          category_id: '32982',
          category_name: 'Grand Theft Auto V',
        },
      },
    ];
    for (const condition of conditions) {
      const capsule = store.create(
        { title: 'Future thoughts', ...condition },
        owner,
      );
      expect(capsule.settings.max_seals_per_user).toBe(3);
      expect(capsule.settings.max_length).toBe(280);
      expect(capsule.channel).toEqual(owner);
      expect(capsule.slug).toMatch(/^[a-z0-9-]+$/);
      store.changeStatus(capsule.id, 'lock');
    }
  });
  it('rejects invalid conditions and a second sealing capsule', () => {
    const { store } = fixture();
    expect(() =>
      store.create(
        {
          title: 'Old',
          triggerType: 'date',
          triggerValue: '2020-01-01T00:00:00Z',
        },
        owner,
      ),
    ).toThrow('future');
    expect(() =>
      store.create(
        { title: 'Bad', triggerType: 'followers', triggerValue: 1.5 },
        owner,
      ),
    ).toThrow('Check');
    expect(() =>
      store.create(
        {
          title: 'Bad',
          triggerType: 'category',
          triggerValue: { category_id: 'not-an-id', category_name: 'Name' },
        },
        owner,
      ),
    ).toThrow('Check');
    store.create({ title: 'First', triggerType: 'manual' }, owner);
    expect(() =>
      store.create({ title: 'Second', triggerType: 'manual' }, owner),
    ).toThrow('Lock or archive');
  });
  it('assigns unique sequential numbers when many chat callbacks arrive together', async () => {
    const { store } = fixture();
    const first = store.create(
      { title: 'First', triggerType: 'manual' },
      owner,
    );
    const receipts = await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        Promise.resolve().then(() => store.acceptSeal(seal('viewer-' + index))),
      ),
    );
    expect(receipts.map((receipt) => receipt?.number)).toEqual(
      Array.from({ length: 60 }, (_, index) => index + 1),
    );
    expect(new Set(receipts.map((receipt) => receipt?.number)).size).toBe(60);
    expect(store.get(first.id)?.sealedCount).toBe(60);
    store.changeStatus(first.id, 'lock');
    const next = store.create(
      { title: 'Second', triggerType: 'manual' },
      owner,
    );
    expect(store.acceptSeal(seal())?.number).toBe(1);
    expect(store.get(next.id)?.sealedCount).toBe(1);
  });
  it('enforces active capsule, channel, blocked words, cooldown, and per-user limit without storing rejects', () => {
    const { db, store, advance } = fixture();
    expect(() => store.acceptSeal(seal())).toThrow('No capsule');
    const capsule = store.create(
      {
        title: 'Limits',
        triggerType: 'manual',
        settings: { max_seals_per_user: 2 },
      },
      owner,
    );
    expect(() => store.acceptSeal({ ...seal(), broadcasterId: '2' })).toThrow(
      'No capsule',
    );
    expect(() => store.acceptSeal(seal('viewer', 'bad'), () => true)).toThrow(
      'blocked word',
    );
    store.acceptSeal(seal('viewer'));
    expect(() => store.acceptSeal(seal('viewer'))).toThrow('10 seconds');
    advance(10_000);
    store.acceptSeal(seal('viewer'));
    advance(10_000);
    expect(() => store.acceptSeal(seal('viewer'))).toThrow('per-user');
    expect(store.get(capsule.id)?.sealedCount).toBe(2);
    expect(db.prepare('SELECT count(*) AS count FROM seals').get()).toEqual({
      count: 2,
    });
  });
  it('is idempotent on redelivery across process restarts, even after locking', () => {
    const { db, store } = fixture();
    const capsule = store.create(
      { title: 'Duplicate', triggerType: 'manual' },
      owner,
    );
    const input = seal();
    store.acceptSeal(input);
    store.changeStatus(capsule.id, 'lock');
    const restored = new CapsuleStore(db);
    expect(restored.acceptSeal(input)).toBeNull();
    expect(restored.get(capsule.id)?.sealedCount).toBe(1);
  });
  it('preserves seals when locking or archiving and never includes their content in public metadata', () => {
    const { store } = fixture();
    const capsule = store.create(
      { title: 'Private predictions', triggerType: 'manual' },
      owner,
    );
    const receipt = store.acceptSeal(
      seal('private-viewer', 'TOP_SECRET_SEALED_CONTENT'),
    );
    expect(receipt).not.toBeNull();
    store.setHidden(receipt?.id ?? 0, true);
    expect(store.get(capsule.id)?.visibleCount).toBe(0);
    const text = JSON.stringify(store.publicView(capsule.slug));
    expect(text).not.toContain('TOP_SECRET_SEALED_CONTENT');
    expect(text).not.toContain('private-viewer');
    expect(text).not.toContain('broadcasterId');
    store.changeStatus(capsule.id, 'archive');
    expect(store.get(capsule.id)?.sealedCount).toBe(1);
    expect(() => store.acceptSeal(seal())).toThrow('No capsule');
  });
});

it('keeps deleted capsule and seal IDs retired across restarts', () => {
  const f = fixture();
  const first = f.store.create(
    { title: 'First', triggerType: 'manual' },
    owner,
  );
  const original = f.store.acceptSeal(seal())!;
  expect(f.store.deleteCapsules()).toBe(1);
  const restored = new CapsuleStore(f.db);
  const next = restored.create({ title: 'Next', triggerType: 'manual' }, owner);
  const receipt = restored.acceptSeal(seal())!;
  expect(next.id).toBeGreaterThan(first.id);
  expect(receipt.id).toBeGreaterThan(original.id);
  expect(receipt.number).toBe(1);
  expect(() => restored.deleteCapsules(first.id)).toThrow('not found');
  expect(restored.get(next.id)).not.toBeNull();
});
it('rolls back capsule deletion if a dependent record cannot be removed', () => {
  const f = fixture();
  const capsule = f.store.create(
    { title: 'Keep', triggerType: 'manual' },
    owner,
  );
  const receipt = f.store.acceptSeal(seal())!;
  f.db
    .prepare(
      'INSERT INTO prophets (capsule_id,seal_id,user_id,user_login) SELECT capsule_id,id,user_id,user_login FROM seals WHERE id=?',
    )
    .run(receipt.id);
  f.db.exec(
    "CREATE TRIGGER fail_delete BEFORE DELETE ON seals BEGIN SELECT RAISE(ABORT, 'test failure'); END",
  );
  expect(() => f.store.deleteCapsules(capsule.id)).toThrow('test failure');
  expect(f.store.get(capsule.id)?.sealedCount).toBe(1);
  expect(f.db.prepare('SELECT id FROM prophets').all()).toHaveLength(1);
});
