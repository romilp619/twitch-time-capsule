import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { temporaryProject } from './helpers.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function server() {
  const project = temporaryProject();
  cleanup.push(project.cleanup);
  const app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }, project.root));
  cleanup.push(() => app.close());
  return app;
}
describe('HTTP server', () => {
  it('serves database-backed health without exposing secrets', async () => {
    const app = server();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      app: 'time-capsule',
      phase: 5,
      database: 'ok',
    });
  });
  it('redirects the root to health and rejects undefined routes', async () => {
    const app = server();
    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(302);
    expect(root.headers.location).toBe('/health');
    expect(
      (await app.inject({ method: 'GET', url: '/dashboard' })).statusCode,
    ).toBe(401);
  });
});
