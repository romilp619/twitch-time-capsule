import { mkdtempSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { loadConfig, projectRoot } from '../config.js';
import { buildServer } from '../server.js';
import { DemoClock, DemoController } from './controller.js';
import { FakeTwitch } from './fake-twitch.js';
export function createDemoServer(
  options: { root?: string; port?: number } = {},
) {
  const port = z
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(options.port ?? 3000);
  const parent = resolve(options.root ?? projectRoot, 'data/demo');
  mkdirSync(parent, { recursive: true });
  const run = mkdtempSync(resolve(parent, 'run-'));
  // Never load .env or inherit Twitch credentials, DATA_DIR, or private keys.
  const config = loadConfig(
    {
      PORT: String(port),
      BASE_URL: 'http://localhost:' + port,
      HOST: '127.0.0.1',
      DATA_DIR: '.',
      LOG_LEVEL: 'silent',
      TWITCH_CLIENT_ID: 'demo-only-client',
      TWITCH_CLIENT_SECRET: 'demo-only-secret',
      TWITCH_REDIRECT_URI: 'http://localhost:' + port + '/auth/callback',
      OFFLINE_OPEN_DELAY_SECONDS: '5',
    },
    run,
    { readEnvFile: false },
  );
  const clock = new DemoClock();
  const twitch = new FakeTwitch(clock.now);
  const controller = new DemoController(config, twitch, clock);
  const app = buildServer(config, {
    fetcher: twitch.fetch,
    now: clock.now,
    eventsubEnabled: false,
    extension: controller,
  });
  return { app, config, twitch, clock, controller };
}
