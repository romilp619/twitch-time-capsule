import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { EventLog } from '../src/db/events.js';
import { CapsuleStore } from '../src/capsule/store.js';
import { TriggerScheduler } from '../src/capsule/scheduler.js';
import { TwitchAuth } from '../src/twitch/auth.js';
import { HelixClient } from '../src/twitch/helix.js';
import { FakeTwitch, twitchProject } from './twitch-helper.js';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.useRealTimers();
});
const owner = { id: '1', login: 'streamer', displayName: 'Streamer' };
async function fixture() {
  const project = twitchProject();
  cleanup.push(project.cleanup);
  const fake = new FakeTwitch();
  const auth = new TwitchAuth(project.config, fake.fetch);
  cleanup.push(() => auth.close());
  await auth.connect('streamer', 'streamer-code');
  const db = openDatabase(project.config.databasePath);
  cleanup.push(() => {
    db.close();
  });
  const store = new CapsuleStore(
    db,
    () => {},
    () => Date.now(),
  );
  const helix = new HelixClient(auth, fake.fetch);
  const log = new EventLog(db);
  const make = () => {
    const scheduler = new TriggerScheduler(
      store,
      auth,
      helix,
      log,
      () => {},
      60_000,
      () => Date.now(),
    );
    cleanup.push(() => scheduler.close());
    return scheduler;
  };
  const scheduler = make();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-25T10:00:00Z'));
  return { project, fake, auth, db, store, helix, log, scheduler, make };
}
describe('Trigger scheduler and durable state', () => {
  it('loads category and follower facts at startup, polls totals, and checks dates every thirty seconds', async () => {
    const { fake, store, scheduler } = await fixture();
    fake.followers = 4;
    const c = store.create(
      {
        title: 'Date',
        triggerType: 'date',
        triggerValue: new Date(Date.now() + 1000).toISOString(),
      },
      owner,
    );
    await scheduler.sync(false);
    scheduler.start();
    expect(scheduler.snapshot()).toMatchObject({
      followers: 4,
      categoryId: '32982',
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(store.get(c.id)?.status).toBe('sealing');
    await vi.advanceTimersByTimeAsync(1);
    expect(store.get(c.id)?.status).toBe('ready');
    fake.followers = 8;
    await vi.advanceTimersByTimeAsync(270_000);
    expect(scheduler.snapshot().followers).toBe(8);
  });
  it('reads total on follows instead of incrementing an assumed count', async () => {
    const { fake, store, scheduler } = await fixture();
    const c = store.create(
      { title: 'Followers', triggerType: 'followers', triggerValue: 20 },
      owner,
    );
    await scheduler.sync(false);
    fake.followers = 25;
    await scheduler.follow('other-channel');
    expect(store.get(c.id)?.status).toBe('sealing');
    await scheduler.follow('1');
    expect(store.get(c.id)?.status).toBe('ready');
    expect(scheduler.snapshot().followers).toBe(25);
  });
  it('fetches category on stream online, opens after five seconds, and logs one transition', async () => {
    const { fake, store, scheduler, log } = await fixture();
    const c = store.create(
      {
        title: 'First stream',
        triggerType: 'category',
        triggerValue: { category_id: '32982', category_name: 'Old name' },
      },
      owner,
    );
    await scheduler.sync(false);
    expect(store.get(c.id)?.status).toBe('sealing');
    fake.live = true;
    await scheduler.stream('1', true);
    expect(store.get(c.id)?.status).toBe('ready');
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.get(c.id)?.status).toBe('opening');
    scheduler.tick(true);
    expect(
      log.latest().filter((e) => e.type === 'capsule.opening'),
    ).toHaveLength(1);
  });
  it('opens at the original deadline despite repeated Open now requests', async () => {
    const { fake, store, scheduler, log } = await fixture();
    fake.live = true;
    const c = store.create(
      { title: 'Click once', triggerType: 'manual' },
      owner,
    );
    await scheduler.sync(true);
    const first = scheduler.action(c.id, 'open');
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      expect(scheduler.action(c.id, 'open').openingDueAt).toBe(
        first.openingDueAt,
      );
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.get(c.id)?.status).toBe('opening');
    expect(
      log.latest().filter((e) => e.type === 'capsule.opening'),
    ).toHaveLength(1);
  });
  it('verifies live status again at the deadline even when an offline event is missing', async () => {
    const { fake, store, scheduler } = await fixture();
    fake.live = true;
    const c = store.create({ title: 'Manual', triggerType: 'manual' }, owner);
    await scheduler.sync(true);
    scheduler.action(c.id, 'open');
    fake.live = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.get(c.id)).toMatchObject({
      status: 'ready',
      openingDueAt: null,
    });
    fake.live = true;
    await scheduler.stream('1', true);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(store.get(c.id)?.status).toBe('ready');
    await vi.advanceTimersByTimeAsync(1);
    expect(store.get(c.id)?.status).toBe('opening');
  });
  it('persists postponement and seals through a scheduler/database restart', async () => {
    const { fake, store, scheduler, make, project } = await fixture();
    fake.live = true;
    const c = store.create({ title: 'Keep me', triggerType: 'manual' }, owner);
    store.acceptSeal({
      broadcasterId: '1',
      userId: 'v',
      userLogin: 'viewer',
      displayName: 'Viewer',
      text: 'private future text',
      chatMessageId: 'kept',
    });
    await scheduler.sync(true);
    scheduler.action(c.id, 'open');
    const postponed = scheduler.action(c.id, 'postpone');
    await scheduler.close();
    const reopened = openDatabase(project.config.databasePath);
    expect(new CapsuleStore(reopened).get(c.id)).toMatchObject({
      status: 'ready',
      postponedUntil: postponed.postponedUntil,
      sealedCount: 1,
    });
    reopened.close();
    const next = make();
    await next.sync(true);
    await vi.advanceTimersByTimeAsync(599_999);
    expect(store.get(c.id)?.status).toBe('ready');
    await vi.advanceTimersByTimeAsync(1);
    expect(store.get(c.id)?.status).toBe('opening');
  });
  it('keeps other ready capsules waiting while one opening is active', async () => {
    const { fake, store, scheduler } = await fixture();
    fake.live = true;
    const first = store.create({ title: 'One', triggerType: 'manual' }, owner);
    store.changeStatus(first.id, 'lock');
    const second = store.create({ title: 'Two', triggerType: 'manual' }, owner);
    await scheduler.sync(true);
    scheduler.action(first.id, 'open');
    scheduler.action(second.id, 'open');
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.get(first.id)?.status).toBe('opening');
    expect(store.get(second.id)?.status).toBe('ready');
    expect(() => scheduler.action(first.id, 'postpone')).toThrow('waiting');
  });
  it('shows API errors and never opens on unknown live state', async () => {
    const { fake, store, scheduler } = await fixture();
    fake.live = true;
    const c = store.create({ title: 'Manual', triggerType: 'manual' }, owner);
    await scheduler.sync(true);
    scheduler.action(c.id, 'open');
    const original = fake.fetch.getMockImplementation()!;
    fake.fetch.mockImplementation(async (input, init) =>
      new URL(String(input)).pathname === '/helix/streams'
        ? new Response('{}', { status: 503 })
        : original(input, init),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.get(c.id)?.status).toBe('ready');
    expect(scheduler.snapshot().warnings.join(' ')).toContain('live');
    expect(store.get(c.id)?.openingDueAt).toBeNull();
  });
  it('rejects disconnected or mismatched channel control and ignores another channel’s events', async () => {
    const { auth, store, scheduler } = await fixture();
    const c = store.create({ title: 'Manual', triggerType: 'manual' }, owner);
    await scheduler.sync(false);
    const other = store.create.bind(store);
    store.changeStatus(c.id, 'lock');
    const foreign = other(
      { title: 'Foreign', triggerType: 'manual' },
      { ...owner, id: '9' },
    );
    expect(() => scheduler.action(foreign.id, 'open')).toThrow(
      'streamer account',
    );
    auth.disconnect('streamer');
    expect(() => scheduler.action(c.id, 'open')).toThrow('streamer account');
    await scheduler.stream('1', true);
    expect(store.get(c.id)?.status).toBe('locked');
  });
});

describe('Out-of-order Twitch facts', () => {
  it('does not let an older category response overwrite a newer channel.update event', async () => {
    const { fake, store, scheduler, helix } = await fixture();
    fake.live = true;
    await scheduler.sync(true);
    const c = store.create(
      {
        title: 'New game',
        triggerType: 'category',
        triggerValue: { category_id: '998', category_name: 'New game' },
      },
      owner,
    );
    let release!: (value: {
      broadcaster_id: string;
      game_id: string;
      game_name: string;
    }) => void;
    vi.spyOn(helix, 'channelCategory').mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const refreshing = scheduler.sync(true);
    scheduler.category('1', '998', 'New game');
    release({ broadcaster_id: '1', game_id: '32982', game_name: 'Old game' });
    await refreshing;
    expect(scheduler.snapshot().categoryId).toBe('998');
    expect(store.get(c.id)?.status).toBe('ready');
  });
  it('refreshes an offline category before evaluating a newly discovered live stream', async () => {
    const { fake, store, scheduler } = await fixture();
    const c = store.create(
      {
        title: 'First stream',
        triggerType: 'category',
        triggerValue: { category_id: '32982', category_name: 'Old game' },
      },
      owner,
    );
    await scheduler.sync(false);
    fake.live = true;
    fake.categoryId = '998';
    await scheduler.sync();
    expect(store.get(c.id)?.status).toBe('sealing');
    expect(scheduler.snapshot().categoryId).toBe('998');
  });
  it('reads again if a follow arrives while an older follower total is in flight', async () => {
    const { fake, store, scheduler, helix } = await fixture();
    await scheduler.sync(false);
    const c = store.create(
      { title: 'Followers', triggerType: 'followers', triggerValue: 10 },
      owner,
    );
    let release!: (value: number) => void;
    vi.spyOn(helix, 'followerTotal').mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const refreshing = scheduler.sync(false);
    fake.followers = 12;
    const follow = scheduler.follow('1');
    release(0);
    await Promise.all([refreshing, follow]);
    expect(store.get(c.id)?.status).toBe('ready');
    expect(scheduler.snapshot().followers).toBe(12);
  });
});
