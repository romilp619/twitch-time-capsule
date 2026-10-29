import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { TwitchAuth } from '../src/twitch/auth.js';
import { HelixClient } from '../src/twitch/helix.js';
import { openDatabase } from '../src/db/index.js';
import { CapsuleStore } from '../src/capsule/store.js';
import { FakeTwitch, twitchProject } from './twitch-helper.js';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(vip = true) {
  const project = twitchProject();
  cleanup.push(project.cleanup);
  const fake = new FakeTwitch();
  const auth = new TwitchAuth(project.config, fake.fetch);
  await auth.connect('streamer', 'streamer-code');
  await auth.connect('bot', 'bot-code');
  auth.close();
  const db = openDatabase(project.config.databasePath);
  cleanup.push(() => {
    db.close();
  });
  const store = new CapsuleStore(db);
  const capsule = store.create(
    { title: 'Capsule', triggerType: 'manual', settings: { vip_reward: vip } },
    { id: '1', login: 'streamer', displayName: 'Streamer' },
  );
  for (let i = 1; i <= 3; i++)
    store.acceptSeal({
      broadcasterId: '1',
      userId: '70' + i,
      userLogin: 'viewer' + i,
      displayName: 'Viewer ' + i,
      text: 'PRIVATE_TEXT_' + i,
      chatMessageId: 'id' + i,
    });
  db.prepare("UPDATE capsules SET status='opening' WHERE id=?").run(capsule.id);
  db.prepare("UPDATE seals SET status='revealed',revealed_at=? WHERE id=1").run(
    new Date().toISOString(),
  );
  db.prepare("UPDATE seals SET status='rejected' WHERE id=2").run();
  const app = buildServer(project.config, {
    fetcher: fake.fetch,
    eventsubEnabled: false,
  });
  cleanup.push(() => app.close());
  await app.ready();
  const headers = { 'x-admin-key': project.config.adminKey };
  const post = (path: string, payload?: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: path,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
  return { ...project, fake, app, db, store, capsule, headers, post };
}
describe('Prophet API integration', () => {
  it('uses the broadcaster token for get/add/remove VIP even with a separate bot connected', async () => {
    const f = await fixture();
    const auth = new TwitchAuth(f.config, f.fake.fetch);
    cleanup.push(() => auth.close());
    await auth.validateAll();
    const helix = new HelixClient(auth, f.fake.fetch, async () => {});
    expect(await helix.isVip('1', '888')).toBe(false);
    await helix.changeVip('1', '888');
    expect(await helix.isVip('1', '888')).toBe(true);
    await helix.changeVip('1', '888', true);
    expect(f.fake.vipChanges).toEqual([
      { method: 'POST', channel: '1', user: '888', role: 'streamer' },
      { method: 'DELETE', channel: '1', user: '888', role: 'streamer' },
    ]);
    await expect(helix.changeVip('other', '888')).rejects.toThrow(
      'account changed',
    );
  });
  it('requires admin authentication and same-origin mutations; overlay keys cannot grant rewards', async () => {
    const f = await fixture();
    for (const path of [
      '/api/prophets',
      '/api/prophets/seals/1/came-true',
      '/api/prophets/expiry',
    ]) {
      const method = path === '/api/prophets' ? 'GET' : 'POST';
      expect((await f.app.inject({ method, url: path })).statusCode).toBe(401);
      expect(
        (
          await f.app.inject({
            method,
            url: path,
            headers: { 'x-admin-key': f.config.overlayKey },
          })
        ).statusCode,
      ).toBe(401);
    }
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/prophets/seals/1/came-true',
          headers: { ...f.headers, origin: 'https://evil.invalid' },
        })
      ).statusCode,
    ).toBe(403);
    expect(f.fake.vipChanges).toEqual([]);
    expect(f.fake.sentMessages).toEqual([]);
  });
  it('only marks revealed messages, returns private status, and leaves public messages sealed', async () => {
    const f = await fixture();
    for (const id of [2, 3, 999])
      expect(
        (await f.post('/api/prophets/seals/' + id + '/came-true')).statusCode,
      ).toBe(409);
    expect((await f.post('/api/prophets/seals/1/came-true')).statusCode).toBe(
      200,
    );
    const list = (
      await f.app.inject({ url: '/api/prophets', headers: f.headers })
    ).json();
    expect(list.seals).toHaveLength(1);
    expect(list.seals[0]).toMatchObject({
      cameTrue: true,
      vipStatus: 'granted',
      chatAnnounced: true,
    });
    expect(f.fake.sentMessages[0]).toMatchObject({
      broadcaster_id: '1',
      sender_id: '2',
    });
    await f.post('/api/prophets/seals/1/came-true');
    expect(f.fake.sentMessages).toHaveLength(1);
    expect(
      (await f.app.inject('/api/public/capsules/' + f.capsule.slug)).body,
    ).not.toContain('PRIVATE_TEXT');
    f.db
      .prepare("UPDATE capsules SET status='opened',opened_at=? WHERE id=?")
      .run(new Date().toISOString(), f.capsule.id);
    const publicPage = (
      await f.app.inject('/api/public/capsules/' + f.capsule.slug)
    ).json();
    expect(publicPage.prophets).toEqual([
      { displayName: 'Viewer 1', predictions: 1 },
    ]);
    expect(JSON.stringify(publicPage)).not.toContain('PRIVATE_TEXT');
    const log = (await f.app.inject({ url: '/api/events', headers: f.headers }))
      .body;
    expect(log).not.toContain('PRIVATE_TEXT');
    expect(log).not.toContain('streamer-access');
  });
  it('validates IDs, pagination, retries and request bodies', async () => {
    const f = await fixture(false);
    for (const query of ['limit=101', 'offset=-1', 'wrong=1'])
      expect(
        (
          await f.app.inject({
            url: '/api/prophets?' + query,
            headers: f.headers,
          })
        ).statusCode,
      ).toBe(400);
    expect((await f.post('/api/prophets/seals/no/came-true')).statusCode).toBe(
      400,
    );
    expect(
      (await f.post('/api/prophets/seals/1/came-true', { vip: true }))
        .statusCode,
    ).toBe(400);
    expect((await f.post('/api/prophets/seals/1/retry-vip')).statusCode).toBe(
      409,
    );
  });
  it('renders a useful VIP error without claiming a grant when Twitch denies available slots', async () => {
    const f = await fixture();
    f.fake.vipStatus = 409;
    await f.post('/api/prophets/seals/1/came-true');
    const result = (
      await f.app.inject({ url: '/api/prophets', headers: f.headers })
    ).json();
    expect(result.seals[0]).toMatchObject({
      vipStatus: 'error',
      cameTrue: true,
      vipError: expect.stringContaining('No free VIP slots'),
    });
    expect(f.fake.sentMessages[0]?.message).not.toContain('VIP for');
    expect(JSON.stringify(result)).not.toContain('private VIP provider detail');
    f.fake.vipStatus = 204;
    await f.post('/api/prophets/seals/1/retry-vip');
    expect(
      (await f.app.inject({ url: '/api/prophets', headers: f.headers })).json()
        .seals[0].vipStatus,
    ).toBe('granted');
  });
});
