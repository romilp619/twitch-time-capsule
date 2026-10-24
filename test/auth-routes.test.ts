import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { FakeTwitch, twitchProject } from './twitch-helper.js';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function fixture() {
  const project = twitchProject();
  cleanup.push(project.cleanup);
  const fake = new FakeTwitch();
  const app = buildServer(project.config, { fetcher: fake.fetch });
  cleanup.push(() => app.close());
  const headers = { 'x-admin-key': project.config.adminKey };
  return { ...project, fake, app, headers };
}
describe('Private dashboard and OAuth routes', () => {
  it('requires the dashboard key for its document and API and rejects foreign-origin writes', async () => {
    const { app, config, headers } = fixture();
    expect((await app.inject('/dashboard')).statusCode).toBe(401);
    expect((await app.inject('/api/connection')).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/start',
          payload: { role: 'streamer' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/start',
          headers: { ...headers, origin: 'https://elsewhere.example' },
          payload: { role: 'streamer' },
        })
      ).statusCode,
    ).toBe(403);
    const page = await app.inject('/dashboard?key=' + config.adminKey);
    expect(page.statusCode).toBe(200);
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.body).toContain('Connect streamer account');
    expect(page.body).not.toContain(config.adminKey);
    expect((await app.inject('/dashboard/app.js')).statusCode).toBe(200);
  });
  it('completes a browser-bound OAuth callback, persists tokens, and exposes names without secrets', async () => {
    const { app, headers, fake } = fixture();
    const start = await app.inject({
      method: 'POST',
      url: '/api/auth/start',
      headers,
      payload: { role: 'streamer' },
    });
    expect(start.statusCode).toBe(200);
    const state = new URL(start.json<{ url: string }>().url).searchParams.get(
      'state',
    );
    const setCookie = String(start.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    const callback = await app.inject({
      url: '/auth/callback?state=' + state + '&code=streamer-code',
      headers: { cookie: setCookie.split(';')[0] ?? '' },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toContain('notice=connected');
    const status = await app.inject({ url: '/api/connection', headers });
    expect(status.json().streamer.displayName).toBe('Streamer Name');
    expect(status.body).not.toContain('streamer-access');
    expect(status.body).not.toContain('streamer-refresh');
    expect(status.body).not.toContain('private-client-secret');
    expect(
      fake.fetch.mock.calls.some(([url]) =>
        String(url).includes('/helix/users'),
      ),
    ).toBe(true);
    expect(
      (
        await app.inject({
          url: '/auth/callback?state=' + state + '&code=streamer-code',
          headers: { cookie: setCookie.split(';')[0] ?? '' },
        })
      ).statusCode,
    ).toBe(400);
  });
  it('rejects missing or mismatched state/cookie without exchanging the code', async () => {
    const { app, headers, fake } = fixture();
    expect(
      (await app.inject('/auth/callback?code=attacker-code')).statusCode,
    ).toBe(400);
    const start = await app.inject({
      method: 'POST',
      url: '/api/auth/start',
      headers,
      payload: { role: 'streamer' },
    });
    const state = new URL(start.json<{ url: string }>().url).searchParams.get(
      'state',
    );
    expect(
      (
        await app.inject(
          '/auth/callback?state=' + state + '&code=attacker-code',
        )
      ).statusCode,
    ).toBe(400);
    expect(fake.fetch).not.toHaveBeenCalled();
  });
  it('handles denied consent and invalid roles without echoing provider input', async () => {
    const { app, headers } = fixture();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/start',
          headers,
          payload: { role: 'admin' },
        })
      ).statusCode,
    ).toBe(400);
    const start = await app.inject({
      method: 'POST',
      url: '/api/auth/start',
      headers,
      payload: { role: 'bot' },
    });
    const state = new URL(start.json<{ url: string }>().url).searchParams.get(
      'state',
    );
    const result = await app.inject({
      url:
        '/auth/callback?state=' +
        state +
        '&error=access_denied&error_description=untrusted-secret-value',
      headers: {
        cookie: String(start.headers['set-cookie']).split(';')[0] ?? '',
      },
    });
    expect(result.statusCode).toBe(302);
    expect(result.headers.location).toContain('notice=denied');
    expect(result.body).not.toContain('untrusted-secret-value');
  });
  it('disconnects locally and restores streamer fallback after removing a separate bot', async () => {
    const { app, headers } = fixture();
    for (const role of ['streamer', 'bot']) {
      const start = await app.inject({
        method: 'POST',
        url: '/api/auth/start',
        headers,
        payload: { role },
      });
      const state = new URL(start.json<{ url: string }>().url).searchParams.get(
        'state',
      );
      await app.inject({
        url: '/auth/callback?state=' + state + '&code=' + role + '-code',
        headers: {
          cookie: String(start.headers['set-cookie']).split(';')[0] ?? '',
        },
      });
    }
    const disconnected = await app.inject({
      method: 'POST',
      url: '/api/auth/disconnect',
      headers,
      payload: { role: 'bot' },
    });
    expect(disconnected.json().singleAccount).toBe(true);
    expect(disconnected.json().bot.status).toBe('disconnected');
    expect(disconnected.json().effectiveBot.userId).toBe('1');
  });
});
