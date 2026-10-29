import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { EventLog } from '../src/db/events.js';
import { CapsuleStore } from '../src/capsule/store.js';
import { BlockedWords } from '../src/capsule/moderation.js';
import { Ceremony } from '../src/capsule/ceremony.js';
import {
  Prophets,
  expiredVipAwards,
  vipErrorMessage,
} from '../src/capsule/prophets.js';
import { TwitchError } from '../src/twitch/http.js';
import { twitchProject } from './twitch-helper.js';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function fixture(vip = true, count = 1, sameUser = false) {
  const project = twitchProject();
  cleanup.push(project.cleanup);
  let now = Date.parse('2026-10-29T00:00:00Z');
  const db = openDatabase(project.config.databasePath);
  cleanup.push(() => {
    if (db.open) db.close();
  });
  const store = new CapsuleStore(
    db,
    () => {},
    () => now,
  );
  const capsule = store.create(
    {
      title: 'Private predictions',
      triggerType: 'manual',
      settings: { vip_reward: vip, vip_days: 30 },
    },
    { id: '1', login: 'streamer', displayName: 'Streamer' },
  );
  for (let i = 0; i < count; i++) {
    store.acceptSeal({
      broadcasterId: '1',
      userId: sameUser ? '77' : '77' + i,
      userLogin: 'viewer' + i,
      displayName: 'Viewer ' + i,
      text: 'PRIVATE_PREDICTION_' + i,
      chatMessageId: 'message' + i,
    });
    now += 10_000;
  }
  db.prepare("UPDATE capsules SET status='opening' WHERE id=?").run(capsule.id);
  const log = new EventLog(db);
  const ceremony = new Ceremony(
    db,
    store,
    new BlockedWords(project.config.dataDir),
    log,
    () => {},
    () => now,
  );
  ceremony.begin(capsule.id);
  now += 6000;
  ceremony.tick();
  for (let id = 1; id <= count; id++) {
    ceremony.moderate(id, 'approved');
    ceremony.revealNext();
  }
  const vips = new Set<string>();
  const twitch = {
    currentChannel: vi.fn((): string | undefined => '1'),
    isVip: vi.fn(async (_channel: string, user: string) => vips.has(user)),
    changeVip: vi.fn(async (_channel: string, user: string, remove = false) => {
      if (remove) vips.delete(user);
      else vips.add(user);
    }),
    announce: vi.fn<(channel: string, text: string) => Promise<void>>(
      async () => {},
    ),
  };
  const prophets = new Prophets(
    db,
    twitch,
    log,
    () => {},
    (id, cap) => ceremony.prophet(id, cap),
    () => now,
  );
  cleanup.push(() => prophets.close());
  return {
    ...project,
    db,
    store,
    capsule,
    ceremony,
    prophets,
    twitch,
    vips,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe('Prophets and VIP ownership', () => {
  it('restores a confirmed owned reward from a reopened database and expires it at startup', async () => {
    const f = fixture();
    await f.prophets.mark(1);
    await f.prophets.close();
    f.db.close();
    f.advance(30 * 86400_000);
    const db = openDatabase(f.config.databasePath);
    cleanup.push(() => {
      db.close();
    });
    const restored = new Prophets(
      db,
      f.twitch,
      new EventLog(db),
      () => {},
      () => {},
      f.now,
    );
    cleanup.push(() => restored.close());
    await restored.start();
    expect(restored.list().seals[0]).toMatchObject({
      cameTrue: true,
      vipStatus: 'expired',
      chatAnnounced: true,
    });
    expect(f.twitch.changeVip).toHaveBeenLastCalledWith('1', '770', true);
    expect(f.twitch.announce).toHaveBeenCalledTimes(1);
  });
  it.each([0, 500])(
    'pauses ambiguous expiry %i for manual role review and never renews it via grant retry',
    async (status) => {
      const f = fixture();
      await f.prophets.mark(1);
      f.advance(30 * 86400_000);
      f.twitch.changeVip.mockRejectedValueOnce(new TwitchError(status, ''));
      await f.prophets.expire();
      expect(f.prophets.list().seals[0]).toMatchObject({
        vipStatus: 'uncertain',
        vipRetryable: false,
      });
      expect(expiredVipAwards(f.db, f.now())).toEqual([]);
      await expect(f.prophets.retry(1, 'vip')).rejects.toThrow('does not need');
      await f.prophets.expire();
      expect(f.twitch.changeVip).toHaveBeenCalledTimes(2);
    },
  );

  it('persists came-true, stamps the current card, announces once, and never grants when rewards are off', async () => {
    const f = fixture(false);
    await Promise.all([f.prophets.mark(1), f.prophets.mark(1)]);
    expect(f.prophets.list().seals[0]).toMatchObject({
      cameTrue: true,
      vipStatus: 'off',
      chatAnnounced: true,
    });
    expect(f.twitch.changeVip).not.toHaveBeenCalled();
    expect(f.twitch.announce).toHaveBeenCalledExactlyOnceWith(
      '1',
      "@viewer0's prediction came true. Prophet!",
    );
    expect(f.ceremony.overlay()).toMatchObject({
      stage: 'prophet',
      prophet: '@Viewer 0 is a Prophet!',
      cards: [{ cameTrue: true }],
    });
    expect(f.store.publicView(f.capsule.slug)?.prophets).toEqual([]);
    f.ceremony.end();
    expect(f.store.publicView(f.capsule.slug)?.prophets).toEqual([
      { displayName: 'Viewer 0', predictions: 1 },
    ]);
    expect(JSON.stringify(f.store.publicView(f.capsule.slug))).not.toContain(
      'PRIVATE_PREDICTION',
    );
    expect(JSON.stringify(f.store.publicView(f.capsule.slug))).not.toContain(
      '"userId"',
    );
  });
  it('grants with broadcaster identity and records exactly when the app owns the role', async () => {
    const f = fixture();
    await f.prophets.mark(1);
    expect(f.twitch.isVip).toHaveBeenCalledWith('1', '770');
    expect(f.twitch.changeVip).toHaveBeenCalledExactlyOnceWith('1', '770');
    expect(f.prophets.list().seals[0]).toMatchObject({
      vipStatus: 'granted',
      vipExpiresAt: new Date(f.now() + 30 * 86400_000).toISOString(),
    });
    expect(f.twitch.announce.mock.calls[0]?.[1]).toContain('VIP for 30 days.');
    expect(f.ceremony.overlay().prophet).toContain('gets VIP for 30 days');
    expect(expiredVipAwards(f.db, f.now())).toEqual([]);
    f.advance(30 * 86400_000);
    await f.prophets.expire();
    expect(f.twitch.changeVip).toHaveBeenLastCalledWith('1', '770', true);
    expect(f.prophets.list().seals[0]).toMatchObject({
      cameTrue: true,
      vipStatus: 'expired',
    });
    await f.prophets.expire();
    expect(f.twitch.changeVip).toHaveBeenCalledTimes(2);
  });
  it('preserves pre-existing VIPs and never schedules their removal', async () => {
    const f = fixture();
    f.vips.add('770');
    await f.prophets.mark(1);
    expect(f.prophets.list().seals[0]).toMatchObject({
      vipStatus: 'existing',
      vipExpiresAt: null,
    });
    f.advance(365 * 86400_000);
    await f.prophets.expire();
    expect(f.twitch.changeVip).not.toHaveBeenCalled();
    expect(f.vips.has('770')).toBe(true);
    expect(f.twitch.announce.mock.calls[0]?.[1]).not.toContain('VIP for');
  });
  it('extends overlapping rewards and removes once, after the latest reward expires', async () => {
    const f = fixture(true, 2, true);
    await f.prophets.mark(1);
    f.advance(86400_000);
    await f.prophets.mark(2);
    expect(f.twitch.changeVip).toHaveBeenCalledTimes(1);
    const rows = f.prophets.list().seals;
    expect(rows[0]?.vipExpiresAt).toBe(rows[1]?.vipExpiresAt);
    f.advance(29 * 86400_000);
    await f.prophets.expire();
    expect(f.twitch.changeVip).toHaveBeenCalledTimes(1);
    f.advance(86400_000);
    await f.prophets.expire();
    expect(f.twitch.changeVip).toHaveBeenCalledTimes(2);
    expect(
      f.prophets.list().seals.every((s) => s.vipStatus === 'expired'),
    ).toBe(true);
  });
  it.each([400, 401, 403, 404, 409, 422, 425, 429, 500, 0])(
    'shows a friendly grant failure for %i and never claims or expires the role',
    async (status) => {
      const f = fixture();
      f.twitch.changeVip.mockRejectedValue(
        new TwitchError(status, 'private provider detail'),
      );
      await f.prophets.mark(1);
      const row = f.prophets.list().seals[0];
      expect(row?.cameTrue).toBe(true);
      expect(row?.vipError).toBe(vipErrorMessage(new TwitchError(status, '')));
      expect(row?.vipExpiresAt).toBeNull();
      expect(JSON.stringify(f.prophets.list())).not.toContain(
        'private provider detail',
      );
      expect(f.twitch.announce.mock.calls[0]?.[1]).not.toContain('VIP for');
      f.advance(365 * 86400_000);
      expect(expiredVipAwards(f.db, f.now())).toEqual([]);
    },
  );
  it('retries a failed VIP without duplicating Prophet records or announcements', async () => {
    const f = fixture();
    f.twitch.changeVip.mockRejectedValueOnce(new TwitchError(409, 'slots'));
    await f.prophets.mark(1);
    await f.prophets.retry(1, 'vip');
    expect(f.prophets.list().seals[0]?.vipStatus).toBe('granted');
    expect(
      f.db.prepare('SELECT COUNT(*) AS total FROM prophets').get(),
    ).toEqual({ total: 1 });
    expect(f.twitch.announce).toHaveBeenCalledTimes(1);
    await expect(f.prophets.retry(1, 'vip')).rejects.toThrow('does not need');
  });
  it('keeps uncertain grants unowned even if Twitch applied them before a lost response', async () => {
    const f = fixture();
    f.twitch.changeVip.mockImplementationOnce(async (_c, user) => {
      f.vips.add(user);
      throw new TwitchError(0, 'network');
    });
    await f.prophets.mark(1);
    await f.prophets.retry(1, 'vip');
    expect(f.prophets.list().seals[0]?.vipStatus).toBe('existing');
    f.advance(365 * 86400_000);
    await f.prophets.expire();
    expect(f.twitch.changeVip).toHaveBeenCalledTimes(1);
  });
  it('exposes a failed announcement and permits an explicit retry only until confirmed', async () => {
    const f = fixture(false);
    f.twitch.announce.mockRejectedValueOnce(new Error('secret token'));
    await f.prophets.mark(1);
    expect(f.prophets.list().seals[0]?.chatError).toContain('Check chat');
    expect(JSON.stringify(f.prophets.list())).not.toContain('secret token');
    await f.prophets.retry(1, 'chat');
    expect(f.prophets.list().seals[0]?.chatAnnounced).toBe(true);
    await expect(f.prophets.retry(1, 'chat')).rejects.toThrow(
      'already announced',
    );
  });
  it('rejects pending or rejected seals and foreign channel mutations', async () => {
    const f = fixture();
    f.db.prepare("UPDATE seals SET status='pending' WHERE id=1").run();
    await expect(f.prophets.mark(1)).rejects.toThrow('Only a revealed');
    f.db.prepare("UPDATE seals SET status='revealed' WHERE id=1").run();
    f.twitch.currentChannel.mockReturnValue('other');
    await expect(f.prophets.mark(1)).rejects.toThrow('owns this capsule');
    expect(f.twitch.announce).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 404, 409, 425, 429])(
    'keeps failed expiry %i retryable and reports it on the reward',
    async (status) => {
      const f = fixture();
      await f.prophets.mark(1);
      f.advance(30 * 86400_000);
      f.twitch.changeVip.mockRejectedValueOnce(
        new TwitchError(status, 'provider'),
      );
      await f.prophets.expire();
      expect(f.prophets.list().seals[0]?.vipError).toBe(
        vipErrorMessage(new TwitchError(status, ''), true),
      );
      expect(expiredVipAwards(f.db, f.now())).toHaveLength(1);
      await f.prophets.expire();
      expect(f.prophets.list().seals[0]?.vipStatus).toBe('expired');
    },
  );
  it('treats expiry 422 as already removed and skips another channel’s awards', async () => {
    const f = fixture();
    await f.prophets.mark(1);
    f.advance(30 * 86400_000);
    f.twitch.currentChannel.mockReturnValue('other');
    await f.prophets.expire();
    expect(f.twitch.changeVip).toHaveBeenCalledTimes(1);
    expect(f.prophets.list().warnings[0]).toContain('original streamer');
    f.twitch.currentChannel.mockReturnValue('1');
    f.twitch.changeVip.mockRejectedValueOnce(new TwitchError(422, ''));
    await f.prophets.expire();
    expect(f.prophets.list().seals[0]?.vipStatus).toBe('expired');
  });
  it('runs expiry at startup and every hour without touching unowned or future VIPs', async () => {
    const f = fixture();
    await f.prophets.mark(1);
    f.advance(30 * 86400_000 - 1);
    vi.useFakeTimers();
    await f.prophets.start();
    expect(f.twitch.changeVip).toHaveBeenCalledTimes(1);
    f.advance(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(f.twitch.changeVip).toHaveBeenLastCalledWith('1', '770', true);
  });
  it('restores a confirmed award across process restart and preserves an interrupted request', async () => {
    const f = fixture();
    await f.prophets.mark(1);
    await f.prophets.close();
    f.db.prepare("UPDATE vip_awards SET status='removing'").run();
    const restored = new Prophets(
      f.db,
      f.twitch,
      new EventLog(f.db),
      () => {},
      () => {},
      f.now,
    );
    cleanup.push(() => restored.close());
    await restored.start();
    expect(f.prophets.list().seals[0]?.vipStatus).toBe('uncertain');
    f.advance(365 * 86400_000);
    await restored.expire();
    expect(f.twitch.changeVip).toHaveBeenCalledTimes(1);
  });
  it('accepts a new reveal after the Prophet stage and empties the overlay on end', async () => {
    const f = fixture(false, 2);
    await f.prophets.mark(1);
    expect(f.ceremony.state().stage).toBe('prophet');
    f.ceremony.setAuto(false);
    f.ceremony.end();
    expect(f.ceremony.overlay()).toMatchObject({ stage: 'idle', cards: [] });
    await f.prophets.mark(2);
    expect(f.ceremony.overlay()).toMatchObject({ stage: 'idle', cards: [] });
  });
});
