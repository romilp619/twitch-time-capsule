import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { EventLog } from '../src/db/events.js';
import { CapsuleStore } from '../src/capsule/store.js';
import { BlockedWords } from '../src/capsule/moderation.js';
import { Ceremony } from '../src/capsule/ceremony.js';
import {
  idleCeremony,
  transitionCeremony,
} from '../src/capsule/ceremony-state.js';
import { twitchProject } from './twitch-helper.js';
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
const owner = { id: '1', login: 'streamer', displayName: 'Streamer' };
function fixture(count = 5) {
  const project = twitchProject();
  cleanup.push(project.cleanup);
  const db = openDatabase(project.config.databasePath);
  cleanup.push(() => {
    if (db.open) db.close();
  });
  let now = Date.now();
  const store = new CapsuleStore(
    db,
    () => {},
    () => now,
  );
  const capsule = store.create(
    { title: 'Future messages', triggerType: 'manual' },
    owner,
  );
  for (let i = 1; i <= count; i++)
    store.acceptSeal({
      broadcasterId: '1',
      userId: 'v' + i,
      userLogin: 'viewer' + i,
      displayName: 'Viewer ' + i,
      text: 'PRIVATE_MESSAGE_' + i,
      chatMessageId: 'msg' + i,
    });
  const blocked = new BlockedWords(project.config.dataDir);
  const ceremony = new Ceremony(
    db,
    store,
    blocked,
    new EventLog(db),
    () => {},
    () => now,
  );
  cleanup.push(() => ceremony.close());
  function opening() {
    const facts = {
      now,
      live: true,
      followers: 0,
      categoryId: null,
      offlineDelayMs: 60_000,
    };
    store.trigger(capsule.id, facts, 'open');
    now += 5000;
    store.trigger(capsule.id, { ...facts, now });
    ceremony.begin(capsule.id);
  }
  function queue() {
    opening();
    now += 6000;
    ceremony.tick();
  }
  return {
    ...project,
    db,
    store,
    capsule,
    blocked,
    ceremony,
    opening,
    queue,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}
describe('Pure ceremony transitions', () => {
  it('opens for six seconds, then queues, and rejects invalid transitions', () => {
    const idle = idleCeremony();
    expect(() =>
      transitionCeremony(idle, { type: 'reveal', sealId: 1 }, 0),
    ).toThrow();
    expect(() => transitionCeremony(idle, { type: 'end' }, 0)).toThrow();
    const opening = transitionCeremony(
      idle,
      { type: 'begin', capsuleId: 1 },
      1000,
    );
    expect(() =>
      transitionCeremony(opening, { type: 'begin', capsuleId: 2 }, 1001),
    ).toThrow('already running');
    expect(() =>
      transitionCeremony(opening, { type: 'auto', enabled: true }, 1001),
    ).toThrow();
    expect(transitionCeremony(opening, { type: 'tick' }, 6999).stage).toBe(
      'opening',
    );
    const queued = transitionCeremony(opening, { type: 'tick' }, 7000);
    expect(queued.stage).toBe('queue');
    expect(idle.stage).toBe('idle');
    expect(opening.stage).toBe('opening');
  });
  it('retains three newest cards, rejects duplicates, and clears everything at end', () => {
    let state = transitionCeremony(
      idleCeremony(),
      { type: 'begin', capsuleId: 1 },
      0,
    );
    state = transitionCeremony(state, { type: 'tick' }, 6000);
    for (const sealId of [1, 2, 3, 4])
      state = transitionCeremony(
        state,
        { type: 'reveal', sealId },
        6000 + sealId,
      );
    expect(state.recentSealIds).toEqual([2, 3, 4]);
    expect(() =>
      transitionCeremony(state, { type: 'reveal', sealId: 4 }, 7000),
    ).toThrow('already been revealed');
    state = transitionCeremony(state, { type: 'auto', enabled: true }, 7000);
    expect(state.autoReveal).toBe(true);
    state = transitionCeremony(state, { type: 'end' }, 8000);
    expect(state).toMatchObject({
      stage: 'ended',
      recentSealIds: [],
      autoReveal: false,
    });
    expect(() =>
      transitionCeremony(state, { type: 'reveal', sealId: 5 }, 9000),
    ).toThrow();
    expect(
      transitionCeremony(state, { type: 'begin', capsuleId: 2 }, 9000).stage,
    ).toBe('opening');
  });
});
describe('Persistent ceremony, approval, and preview', () => {
  it('keeps the overlay empty outside a ceremony and only reveals explicitly approved messages', () => {
    const { ceremony, queue } = fixture();
    expect(ceremony.overlay()).toMatchObject({ stage: 'idle', cards: [] });
    queue();
    expect(ceremony.overlay()).toMatchObject({ stage: 'queue', cards: [] });
    expect(() => ceremony.revealNext()).toThrow('Approve');
    ceremony.moderate(1, 'rejected');
    ceremony.moderate(3, 'approved');
    ceremony.moderate(2, 'approved');
    expect(JSON.stringify(ceremony.overlay())).not.toContain('PRIVATE_MESSAGE');
    ceremony.revealNext();
    expect(ceremony.overlay().cards.map((c) => c.number)).toEqual([2]);
    const overlay = JSON.stringify(ceremony.overlay());
    expect(overlay).toContain('PRIVATE_MESSAGE_2');
    for (const number of [1, 3, 4, 5])
      expect(overlay).not.toContain('PRIVATE_MESSAGE_' + number);
    expect(overlay).not.toContain('userId');
    expect(overlay).not.toContain('chatMessageId');
    expect(() => ceremony.moderate(2, 'rejected')).toThrow('revealed');
  });
  it('prevents reveals during opening and keeps the latest three in reveal order', () => {
    const { ceremony, opening, advance } = fixture();
    opening();
    for (const id of [1, 2, 3, 4]) ceremony.moderate(id, 'approved');
    expect(() => ceremony.revealNext()).toThrow('animation');
    advance(6000);
    ceremony.tick();
    for (let i = 0; i < 4; i++) ceremony.revealNext();
    expect(ceremony.overlay().cards.map((c) => c.number)).toEqual([2, 3, 4]);
    expect(ceremony.counts(1)).toMatchObject({ revealed: 4, pending: 1 });
  });
  it('flags messages against the current blocked list, paginates, and refuses another capsule’s seals', () => {
    const { ceremony, queue, blocked, store } = fixture();
    queue();
    writeFileSync(blocked.path, 'PRIVATE_MESSAGE_1\n');
    const page = ceremony.queue('pending', 0, 2);
    expect(page.total).toBe(5);
    expect(page.seals.map((s) => s.number)).toEqual([1, 2]);
    expect(page.seals[0]?.flagged).toBe(true);
    expect(page.seals[1]?.flagged).toBe(false);
    ceremony.moderate(1, 'approved');
    expect(ceremony.queue('approved').seals.map((s) => s.number)).toEqual([1]);
    const other = store.create(
      { title: 'Other', triggerType: 'manual' },
      owner,
    );
    const receipt = store.acceptSeal({
      broadcasterId: '1',
      userId: 'other',
      userLogin: 'other',
      displayName: 'Other',
      text: 'Not this ceremony',
      chatMessageId: 'other',
    });
    expect(other.id).not.toBe(1);
    expect(() => ceremony.moderate(receipt!.id, 'approved')).toThrow(
      'not found',
    );
  });
  it('runs auto-reveal at the configured interval and pauses when no approved messages remain', () => {
    const { ceremony, queue, advance } = fixture(2);
    queue();
    ceremony.configure({ side: 'left', cardScale: 1.15, autoRevealSeconds: 3 });
    ceremony.moderate(1, 'approved');
    ceremony.moderate(2, 'approved');
    ceremony.setAuto(true);
    advance(2999);
    ceremony.tick();
    expect(ceremony.counts(1).revealed).toBe(0);
    advance(1);
    ceremony.tick();
    expect(ceremony.counts(1).revealed).toBe(1);
    advance(3000);
    ceremony.tick();
    expect(ceremony.counts(1).revealed).toBe(2);
    advance(3000);
    ceremony.tick();
    expect(ceremony.state().autoReveal).toBe(false);
    expect(ceremony.settings()).toMatchObject({
      side: 'left',
      cardScale: 1.15,
      autoRevealSeconds: 3,
    });
  });
  it('persists revealed cards and settings across reopening the database', () => {
    const { ceremony, queue, db, config, blocked, now } = fixture();
    queue();
    ceremony.moderate(1, 'approved');
    ceremony.revealNext();
    ceremony.configure({
      side: 'left',
      cardScale: 0.85,
      autoRevealSeconds: 12,
    });
    db.close();
    const reopened = openDatabase(config.databasePath);
    cleanup.push(() => reopened.close());
    const restored = new Ceremony(
      reopened,
      new CapsuleStore(reopened),
      blocked,
      new EventLog(reopened),
      () => {},
      now,
    );
    cleanup.push(() => restored.close());
    expect(restored.overlay().cards.map((c) => c.number)).toEqual([1]);
    expect(restored.state().stage).toBe('reveal');
    expect(restored.settings()).toMatchObject({
      side: 'left',
      cardScale: 0.85,
      autoRevealSeconds: 12,
    });
  });
  it('ends atomically, preserves all seals, and keeps the public page metadata-only', () => {
    const { ceremony, queue, store, capsule, db } = fixture();
    queue();
    ceremony.moderate(1, 'approved');
    ceremony.revealNext();
    ceremony.end();
    expect(store.get(capsule.id)).toMatchObject({
      status: 'opened',
      sealedCount: 5,
    });
    expect(store.get(capsule.id)?.openedAt).toBeTruthy();
    expect(ceremony.overlay()).toMatchObject({ stage: 'idle', cards: [] });
    expect(JSON.stringify(store.publicView(capsule.slug))).not.toContain(
      'PRIVATE_MESSAGE',
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM seals').get()).toEqual({
      count: 5,
    });
    expect(() => ceremony.moderate(3, 'approved')).toThrow('No ceremony');
    expect(() => ceremony.end()).toThrow('No ceremony');
  });
  it('plays an isolated ten-second preview without changing approvals or capsule state', () => {
    const { ceremony, advance, store, capsule, db } = fixture();
    const before = db
      .prepare('SELECT id, status, revealed_at FROM seals ORDER BY id')
      .all();
    ceremony.preview();
    expect(ceremony.overlay()).toMatchObject({
      preview: true,
      stage: 'opening',
    });
    expect(() => ceremony.preview()).toThrow('already playing');
    advance(3000);
    ceremony.tick();
    expect(ceremony.overlay()).toMatchObject({
      preview: true,
      stage: 'reveal',
    });
    expect(JSON.stringify(ceremony.overlay())).not.toContain('PRIVATE_MESSAGE');
    advance(7000);
    ceremony.tick();
    expect(ceremony.overlay()).toMatchObject({
      preview: false,
      stage: 'idle',
      cards: [],
    });
    expect(
      db.prepare('SELECT id, status, revealed_at FROM seals ORDER BY id').all(),
    ).toEqual(before);
    expect(store.get(capsule.id)?.status).toBe('sealing');
  });
  it('adopts a Phase 5 opening after startup and refuses preview until it is ended', () => {
    const { ceremony, store, capsule, db, advance } = fixture(0);
    db.prepare("UPDATE capsules SET status='opening' WHERE id=?").run(
      capsule.id,
    );
    ceremony.tick();
    expect(ceremony.state().stage).toBe('opening');
    expect(() => ceremony.preview()).toThrow('End the current');
    advance(6000);
    ceremony.tick();
    expect(ceremony.state().stage).toBe('queue');
    ceremony.end();
    expect(store.get(capsule.id)?.status).toBe('opened');
  });
  it('validates overlay settings and requires approval for auto-reveal', () => {
    const { ceremony, queue } = fixture();
    queue();
    expect(() => ceremony.setAuto(true)).toThrow('Approve');
    for (const raw of [
      { side: 'top' },
      { side: 'left', cardScale: 2, autoRevealSeconds: 8 },
      { side: 'right', cardScale: 1, autoRevealSeconds: 1 },
    ])
      expect(() => ceremony.configure(raw)).toThrow('Choose');
  });
});
