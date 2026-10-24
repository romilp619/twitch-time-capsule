import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TwitchAuth } from '../src/twitch/auth.js';
import { HelixClient } from '../src/twitch/helix.js';
import { FakeTwitch, json, twitchProject } from './twitch-helper.js';
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
});
async function fixture() {
  const project = twitchProject();
  cleanup.push(project.cleanup);
  const fake = new FakeTwitch();
  const auth = new TwitchAuth(project.config, fake.fetch);
  cleanup.push(() => auth.close());
  await auth.connect('streamer', 'streamer-code');
  return { auth, fake };
}
describe('Helix client', () => {
  it('sends Bearer and Client-Id headers and queries moderator status with the broadcaster token', async () => {
    const { auth, fake } = await fixture();
    fake.isMod = true;
    const helix = new HelixClient(auth, fake.fetch);
    expect(await helix.isModerator('1', '2')).toBe(true);
    const call = fake.fetch.mock.calls.find(([url]) =>
      String(url).includes('/helix/moderation/moderators'),
    );
    const url = new URL(String(call?.[0]));
    expect(url.searchParams.get('broadcaster_id')).toBe('1');
    expect(url.searchParams.get('user_id')).toBe('2');
    const headers = new Headers(call?.[1]?.headers);
    expect(headers.get('Authorization')).toBe('Bearer streamer-access');
    expect(headers.get('Client-Id')).toBe('client-id');
  });
  it('refreshes on 401 and retries exactly once using the new token', async () => {
    const { auth, fake } = await fixture();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
      new Headers(init?.headers).get('Authorization') ===
      'Bearer streamer-access'
        ? json({}, 401)
        : json({
            data: [{ id: '1', login: 'streamer', display_name: 'Streamer' }],
          }),
    );
    const helix = new HelixClient(auth, fetcher);
    expect((await helix.currentUser('streamer')).id).toBe('1');
    expect(fake.refreshes).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('honors Ratelimit-Reset and bounds repeated rate-limit retries', async () => {
    const { auth } = await fixture();
    const now = Date.now();
    const reset = Math.ceil(now / 1000) + 2;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({}, 429, { 'Ratelimit-Reset': String(reset) }),
      )
      .mockResolvedValue(json({ data: [] }));
    const sleep = vi.fn(async () => {});
    const helix = new HelixClient(auth, fetcher, sleep, () => now);
    expect(await helix.isLive('1')).toBe(false);
    expect(sleep).toHaveBeenCalledWith(
      reset * 1000 - now + 100,
      auth.controller.signal,
    );
    fetcher.mockResolvedValue(json({}, 429));
    await expect(helix.isLive('1')).rejects.toThrow('rate limit');
    expect(sleep).toHaveBeenCalledTimes(3);
  });
  it('rejects external paths before transmitting credentials', async () => {
    const { auth, fake } = await fixture();
    const count = fake.fetch.mock.calls.length;
    await expect(
      new HelixClient(auth, fake.fetch).request(
        'streamer',
        '//evil.example',
        z.unknown(),
      ),
    ).rejects.toThrow('Invalid Twitch API path');
    expect(fake.fetch.mock.calls.length).toBe(count);
  });
  it('does not expose upstream response bodies or network error secrets', async () => {
    const { auth } = await fixture();
    const apiError = new HelixClient(
      auth,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ error: 'secret-token-value' }, 500)),
    );
    await expect(apiError.currentUser('streamer')).rejects.toThrow(
      'Twitch API request failed',
    );
    const broken = new HelixClient(
      auth,
      vi.fn<typeof fetch>().mockRejectedValue(new Error('secret-token-value')),
    );
    await expect(broken.currentUser('streamer')).rejects.toThrow(
      'Cannot reach Twitch',
    );
  });
});
