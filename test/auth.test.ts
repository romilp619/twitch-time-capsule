import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TokenStore, TwitchAuth, scopes } from '../src/twitch/auth.js';
import { FakeTwitch, twitchProject } from './twitch-helper.js';
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
});
function fixture() {
  const project = twitchProject();
  cleanup.push(project.cleanup);
  const fake = new FakeTwitch();
  let now = Date.now();
  const auth = new TwitchAuth(project.config, fake.fetch, () => now);
  cleanup.push(() => auth.close());
  return {
    ...project,
    fake,
    auth,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}
describe('Twitch authorization', () => {
  it('builds separate role scopes and single-use, expiring, browser-bound states', () => {
    const { auth, advance } = fixture();
    const streamer = auth.begin('streamer');
    const bot = auth.begin('bot');
    expect(new URL(streamer.url).searchParams.get('scope')?.split(' ')).toEqual(
      scopes.streamer,
    );
    expect(new URL(bot.url).searchParams.get('force_verify')).toBe('true');
    expect(streamer.state).not.toBe(bot.state);
    expect(() => auth.consumeState(streamer.state, 'wrong-browser')).toThrow(
      'another browser',
    );
    expect(auth.consumeState(bot.state, bot.binding)).toBe('bot');
    expect(() => auth.consumeState(bot.state, bot.binding)).toThrow('expired');
    const expired = auth.begin('streamer');
    advance(600_001);
    expect(() => auth.consumeState(expired.state, expired.binding)).toThrow(
      'expired',
    );
  });
  it('stores validated user tokens privately and restores them without exposing tokens in status', async () => {
    const { auth, config } = fixture();
    await auth.connect('streamer', 'streamer-code');
    expect(auth.publicAccount('streamer').status).toBe('connected');
    const status = JSON.stringify(auth.publicAccount('streamer'));
    expect(status).not.toContain('streamer-access');
    expect(status).not.toContain('streamer-refresh');
    const store = new TokenStore(config.dataDir);
    expect(store.get('streamer')?.refreshToken).toBe('streamer-refresh+/%');
    expect(statSync(resolve(config.dataDir, 'tokens.json')).mode & 0o777).toBe(
      0o600,
    );
  });
  it.each(['client', 'scope'])(
    'rejects a mismatched %s before persisting tokens',
    async (failure) => {
      const { auth, fake } = fixture();
      if (failure === 'client') fake.validationClient = 'other-app';
      else fake.missingScope = true;
      await expect(auth.connect('streamer', 'streamer-code')).rejects.toThrow(
        'permissions',
      );
      expect(auth.store.get('streamer')).toBeUndefined();
    },
  );
  it('refreshes once for concurrent requests and persists rotated refresh tokens', async () => {
    const { auth, fake, config } = fixture();
    await auth.connect('streamer', 'streamer-code');
    const [first, second] = await Promise.all([
      auth.refresh('streamer', 'streamer-access'),
      auth.refresh('streamer', 'streamer-access'),
    ]);
    expect(fake.refreshes).toBe(1);
    expect(first.accessToken).toBe('streamer-renewed');
    expect(second.accessToken).toBe(first.accessToken);
    const stored = readFileSync(resolve(config.dataDir, 'tokens.json'), 'utf8');
    expect(stored).toContain('streamer-renewed');
    expect(stored).toContain('streamer-rotated-refresh+/%');
    const call = fake.fetch.mock.calls.find(
      ([, init]) =>
        new URLSearchParams(String(init?.body)).get('grant_type') ===
        'refresh_token',
    );
    expect(
      new URLSearchParams(String(call?.[1]?.body)).get('refresh_token'),
    ).toBe('streamer-refresh+/%');
    expect(
      new URLSearchParams(String(call?.[1]?.body)).get('client_secret'),
    ).toBe('private-client-secret');
  });
  it('refreshes before expiry when requesting a token', async () => {
    const { auth, fake, advance } = fixture();
    await auth.connect('streamer', 'streamer-code');
    advance(3_550_000);
    expect((await auth.accessToken('bot')).token).toBe('streamer-renewed');
    expect(fake.refreshes).toBe(1);
  });
  it('validates restored tokens before allowing requests and refreshes a 401', async () => {
    const { auth, fake, config } = fixture();
    await auth.connect('streamer', 'streamer-code');
    const restored = new TwitchAuth(config, fake.fetch);
    cleanup.push(() => restored.close());
    await expect(restored.accessToken('streamer')).rejects.toThrow('Validate');
    fake.invalidAccess.add('streamer-access');
    await restored.validateAll();
    expect(restored.publicAccount('streamer').status).toBe('connected');
    expect((await restored.accessToken('streamer')).token).toBe(
      'streamer-renewed',
    );
  });
  it('clears revoked credentials but preserves them on temporary network failures', async () => {
    const { auth, fake } = fixture();
    await auth.connect('streamer', 'streamer-code');
    fake.validationStatus = 503;
    await auth.validateAll();
    expect(auth.store.get('streamer')).toBeDefined();
    expect(auth.publicAccount('streamer').status).toBe('error');
    fake.validationStatus = 200;
    fake.invalidAccess.add('streamer-access');
    fake.refreshStatus = 400;
    await auth.validateAll();
    expect(auth.store.get('streamer')).toBeUndefined();
    expect(auth.publicAccount('streamer').error).toContain('Reconnect');
  });
  it('fails safely on corrupt token files without echoing their contents', () => {
    const { config } = fixture();
    writeFileSync(
      resolve(config.dataDir, 'tokens.json'),
      'secret-invalid-json',
    );
    expect(() => new TokenStore(config.dataDir)).toThrow(
      'Cannot read data/tokens.json',
    );
  });
});
