import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { EventLog } from '../src/db/events.js';
import { CapsuleStore } from '../src/capsule/store.js';
import { Ceremony } from '../src/capsule/ceremony.js';
import { BlockedWords } from '../src/capsule/moderation.js';
import { Prophets } from '../src/capsule/prophets.js';
import { buildServer } from '../src/server.js';
import { twitchProject, FakeTwitch } from './twitch-helper.js';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function fixture(winners = 1205) {
  const project = twitchProject();
  cleanup.push(project.cleanup);
  const db = openDatabase(project.config.databasePath);
  cleanup.push(() => {
    db.close();
  });
  let now = Date.now();
  const store = new CapsuleStore(
    db,
    () => {},
    () => now,
  );
  const capsule = store.create(
    { title: 'A thousand futures', triggerType: 'manual' },
    { id: '1', login: 'streamer', displayName: 'Streamer' },
  );
  const insert = db.prepare(
    `INSERT INTO seals (capsule_id, number, user_id, user_login, display_name, text, chat_message_id, status, came_true, revealed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (let i = 1; i <= winners + 3; i++)
      insert.run(
        capsule.id,
        i,
        'u' + i,
        'viewer' + i,
        'Viewer' + String(i).padStart(4, '0'),
        'PREDICTION_' + i,
        'm' + i,
        i <= winners + 1
          ? 'revealed'
          : i === winners + 2
            ? 'rejected'
            : 'pending',
        i <= winners ? 1 : 0,
        '2026-11-02T00:00:00Z',
      );
    db.prepare(
      `INSERT INTO prophets (capsule_id,seal_id,user_id,user_login,vip_status) SELECT capsule_id,id,user_id,user_login,'off' FROM seals WHERE came_true=1`,
    ).run();
    db.prepare(
      "UPDATE capsules SET status='opened', opened_at=? WHERE id=?",
    ).run(new Date(now).toISOString(), capsule.id);
  })();
  const blocked = new BlockedWords(project.config.dataDir);
  const make = () =>
    new Ceremony(
      db,
      store,
      blocked,
      new EventLog(db),
      () => {},
      () => now,
    );
  const ceremony = make();
  cleanup.push(() => ceremony.close());
  const twitch = {
    isVip: vi.fn(async () => false),
    changeVip: vi.fn(async () => {}),
    announce: vi.fn(async () => {}),
    currentChannel: () => '1',
  };
  const prophets = new Prophets(
    db,
    twitch,
    new EventLog(db),
    () => {},
    () => {},
    () => now,
  );
  cleanup.push(() => prophets.close());
  return {
    ...project,
    db,
    store,
    capsule,
    ceremony,
    make,
    prophets,
    twitch,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe('Large Prophet collections', () => {
  it('paginates all 1,205 public winners with only their revealed winning texts', () => {
    const { store, capsule } = fixture();
    const first = store.publicView(capsule.slug)!;
    expect(first.prophetTotal).toBe(1205);
    expect(first.prophets).toHaveLength(50);
    const names: string[] = [];
    for (let offset = 0; offset < 1205; offset += 50) {
      const page = store.publicProphets(capsule.slug, offset)!;
      expect(page.prophets.length).toBeLessThanOrEqual(50);
      names.push(...page.prophets.map((p) => p.displayName));
      for (const [index, prophet] of page.prophets.entries())
        expect(prophet.messages).toEqual([
          {
            number: offset + index + 1,
            text: 'PREDICTION_' + (offset + index + 1),
          },
        ]);
      expect(JSON.stringify(page)).not.toMatch(
        /vip_status|user_id|chat_message_id/,
      );
    }
    expect(new Set(names).size).toBe(1205);
    expect(names.at(-1)).toBe('Viewer1205');
    expect(
      store.publicProphets(capsule.slug, 0, 50, 'Viewer1205'),
    ).toMatchObject({
      total: 1,
      prophets: [{ displayName: 'Viewer1205', predictions: 1 }],
    });
    expect(
      store.publicProphets(capsule.slug, 0, 50, "%' OR 1=1 --")?.total,
    ).toBe(0);
  });
  it('keeps public recognition hidden until the ceremony has ended', () => {
    const { store, capsule, db } = fixture();
    db.prepare(
      "UPDATE capsules SET status='opening', opened_at=NULL WHERE id=?",
    ).run(capsule.id);
    expect(store.publicProphets(capsule.slug)).toMatchObject({
      total: 0,
      prophets: [],
    });
  });
  it('groups multiple wins under one viewer without publishing rejected, pending, or unmarked text', () => {
    const { store, capsule, db } = fixture(3);
    db.prepare(
      'DELETE FROM prophets WHERE capsule_id=? AND seal_id=(SELECT id FROM seals WHERE capsule_id=? AND number=2)',
    ).run(capsule.id, capsule.id);
    db.prepare(
      "UPDATE seals SET user_id='u1', display_name='Viewer0001', user_login='viewer1' WHERE capsule_id=? AND number=2",
    ).run(capsule.id);
    db.prepare(
      "INSERT INTO prophets (capsule_id,seal_id,user_id,user_login,vip_status) SELECT capsule_id,id,user_id,user_login,'off' FROM seals WHERE capsule_id=? AND number=2",
    ).run(capsule.id);
    db.prepare(
      "UPDATE seals SET came_true=1 WHERE capsule_id=? AND status IN ('pending','rejected')",
    ).run(capsule.id);
    db.prepare(
      "INSERT INTO prophets (capsule_id,seal_id,user_id,user_login,vip_status) SELECT capsule_id,id,user_id,user_login,'off' FROM seals WHERE capsule_id=? AND status IN ('pending','rejected')",
    ).run(capsule.id);
    const page = store.publicProphets(capsule.slug)!;
    expect(page.total).toBe(2);
    expect(page.prophets[0]).toEqual({
      displayName: 'Viewer0001',
      predictions: 2,
      messages: [
        { number: 1, text: 'PREDICTION_1' },
        { number: 2, text: 'PREDICTION_2' },
      ],
    });
    expect(page.prophets[1]).toEqual({
      displayName: 'Viewer0003',
      predictions: 1,
      messages: [{ number: 3, text: 'PREDICTION_3' }],
    });
    for (const privateValue of [
      'PREDICTION_4',
      'PREDICTION_5',
      'PREDICTION_6',
      'user_id',
      'user_login',
      'chat_message_id',
      'vip_status',
    ])
      expect(JSON.stringify(page)).not.toContain(privateValue);
  });
  it('filters and searches revealed predictions across all pages', () => {
    const { prophets } = fixture();
    expect(prophets.list(1200, 50)).toMatchObject({ total: 1206 });
    expect(prophets.list(1200, 50).seals).toHaveLength(6);
    expect(prophets.list(0, 50, '', 'true')).toMatchObject({ total: 1205 });
    expect(prophets.list(0, 50, '', 'unmarked')).toMatchObject({ total: 1 });
    expect(
      prophets.list(0, 50, 'Viewer1205', 'true').seals.map((s) => s.number),
    ).toEqual([1205]);
    expect(prophets.list(0, 50, "%' OR 1=1 --").total).toBe(0);
  });
  it('plays every winner in order, retains three cards, and never reissues rewards', () => {
    const { ceremony, capsule, advance, twitch, db } = fixture();
    ceremony.showcase.start(capsule.id, 3);
    for (let i = 1; i <= 1205; i++) {
      const overlay = ceremony.overlay();
      expect(overlay.cards.length).toBeLessThanOrEqual(3);
      expect(overlay.cards.at(-1)?.number).toBe(i);
      expect(overlay.cards.every((c) => c.cameTrue)).toBe(true);
      expect(ceremony.showcase.dashboard().shown).toBe(i);
      advance(3000);
      ceremony.tick();
    }
    expect(ceremony.showcase.dashboard().status).toBe('finished');
    expect(ceremony.overlay()).toMatchObject({ stage: 'idle', cards: [] });
    expect(twitch.changeVip).not.toHaveBeenCalled();
    expect(twitch.announce).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM prophets').get()).toEqual({
      n: 1205,
    });
  });
  it('pauses, steps manually, resumes, and restores progress paused after restart', () => {
    const { ceremony, capsule, advance, make } = fixture(5);
    ceremony.showcase.start(capsule.id, 3);
    ceremony.showcase.pause(true);
    advance(30000);
    ceremony.tick();
    expect(ceremony.showcase.dashboard().shown).toBe(1);
    ceremony.showcase.next();
    expect(ceremony.showcase.dashboard().shown).toBe(2);
    ceremony.showcase.pause(false);
    advance(3000);
    ceremony.tick();
    const restored = make();
    expect(restored.showcase.dashboard()).toMatchObject({
      status: 'paused',
      shown: 3,
      total: 5,
    });
    expect(restored.overlay().cards.map((c) => c.number)).toEqual([1, 2, 3]);
    restored.showcase.pause(false);
    advance(3000);
    restored.tick();
    expect(restored.showcase.dashboard().shown).toBe(4);
    restored.showcase.stop();
    expect(restored.overlay()).toMatchObject({ stage: 'idle', cards: [] });
  });
  it('protects showcase controls and bounds public/admin pagination', async () => {
    const f = fixture(1205);
    const app = buildServer(f.config, {
      fetcher: new FakeTwitch().fetch,
      eventsubEnabled: false,
    });
    cleanup.push(() => app.close());
    await app.ready();
    const headers = { 'x-admin-key': f.config.adminKey };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/showcase',
          payload: {
            action: 'start',
            capsuleId: f.capsule.id,
            intervalSeconds: 3,
          },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/showcase',
          headers: { ...headers, origin: 'https://evil.invalid' },
          payload: {
            action: 'start',
            capsuleId: f.capsule.id,
            intervalSeconds: 3,
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/showcase',
          headers,
          payload: {
            action: 'start',
            capsuleId: f.capsule.id,
            intervalSeconds: 0,
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/showcase',
          headers,
          payload: {
            action: 'start',
            capsuleId: f.capsule.id,
            intervalSeconds: 3,
          },
        })
      ).statusCode,
    ).toBe(200);
    const wall = await app.inject(
      '/api/public/capsules/' + f.capsule.slug + '/prophets?offset=1200',
    );
    expect(wall.json()).toMatchObject({ total: 1205, offset: 1200 });
    expect(wall.json().prophets).toHaveLength(5);
    expect(wall.body).toContain('PREDICTION_1205');
    for (const privateValue of [
      'PREDICTION_1206',
      'PREDICTION_1207',
      'PREDICTION_1208',
      'user_id',
      'vip_status',
    ])
      expect(wall.body).not.toContain(privateValue);
    expect(
      (
        await app.inject(
          '/api/public/capsules/' + f.capsule.slug + '/prophets?limit=10000',
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: '/api/prophets?limit=10000', headers }))
        .statusCode,
    ).toBe(400);
  });
});
