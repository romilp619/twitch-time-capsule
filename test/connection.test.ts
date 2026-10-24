import { afterEach, describe, expect, it, vi } from 'vitest';
import { TwitchAuth } from '../src/twitch/auth.js';
import { TwitchConnection } from '../src/twitch/connection.js';
import { HelixClient } from '../src/twitch/helix.js';
import { FakeTwitch, twitchProject } from './twitch-helper.js';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.useRealTimers();
});
function fixture() {
  const project = twitchProject();
  cleanup.push(project.cleanup);
  const fake = new FakeTwitch();
  const auth = new TwitchAuth(project.config, fake.fetch);
  const connection = new TwitchConnection(
    auth,
    new HelixClient(auth, fake.fetch),
  );
  cleanup.push(() => connection.close());
  return { auth, fake, connection };
}
describe('Connection status', () => {
  it('supports streamer-only mode and reports current stream state', async () => {
    const { auth, fake, connection } = fixture();
    await auth.connect('streamer', 'streamer-code');
    fake.live = true;
    await connection.start();
    const state = connection.snapshot();
    expect(state.singleAccount).toBe(true);
    expect(state.effectiveBot.userId).toBe('1');
    expect(state.moderator.state).toBe('yes');
    expect(state.live).toBe(true);
    expect(state.streamer.displayName).toBe('Streamer Name');
  });
  it('checks the separate bot and shows the exact /mod instruction until granted', async () => {
    const { auth, fake, connection } = fixture();
    await auth.connect('streamer', 'streamer-code');
    await auth.connect('bot', 'bot-code');
    await connection.start();
    expect(connection.snapshot().moderator).toEqual({
      state: 'no',
      message: 'Type /mod bot in your chat',
    });
    fake.isMod = true;
    await connection.refresh();
    expect(connection.snapshot().moderator.state).toBe('yes');
    expect(connection.snapshot().bot.displayName).toBe('Capsule Bot');
  });
  it('validates on startup and hourly, and cancels the timer on shutdown', async () => {
    vi.useFakeTimers();
    const { auth, fake, connection } = fixture();
    await auth.connect('streamer', 'streamer-code');
    await connection.start();
    const calls = () =>
      fake.fetch.mock.calls.filter(([url]) =>
        String(url).endsWith('/oauth2/validate'),
      ).length;
    const startup = calls();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(calls()).toBeGreaterThan(startup);
    await connection.close();
    const closed = calls();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(calls()).toBe(closed);
  });
});
