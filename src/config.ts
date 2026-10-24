import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotEnv } from 'dotenv';
import { z } from 'zod';

export const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);
const optionalText = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);
const optionalKey = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(32).optional(),
);
const keySchema = z
  .object({
    adminKey: z.string().min(32),
    overlayKey: z.string().min(32),
  })
  .refine((keys) => keys.adminKey !== keys.overlayKey, {
    message: 'Admin and overlay keys must differ',
  });
const envSchema = z
  .object({
    HOST: z.string().trim().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    BASE_URL: z
      .url()
      .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol))
      .optional(),
    DATA_DIR: z.string().trim().min(1).default('data'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    ADMIN_KEY: optionalKey,
    OVERLAY_KEY: optionalKey,
    TWITCH_CLIENT_ID: optionalText,
    TWITCH_CLIENT_SECRET: optionalText,
    TWITCH_REDIRECT_URI: z.url().default('http://localhost:3000/auth/callback'),
    OFFLINE_OPEN_DELAY_SECONDS: z.coerce
      .number()
      .int()
      .min(0)
      .max(86400)
      .default(60),
  })
  .superRefine((env, context) => {
    if (Boolean(env.TWITCH_CLIENT_ID) !== Boolean(env.TWITCH_CLIENT_SECRET)) {
      context.addIssue({
        code: 'custom',
        path: ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET'],
        message: 'Set both Twitch credentials, or leave both empty for Phase 1',
      });
    }
  });

export function parseEnvironment(env: NodeJS.ProcessEnv) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Never include raw input values, which may contain OAuth secrets.
    const details = parsed.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Invalid configuration:\n${details.join('\n')}`);
  }
  return parsed.data;
}

function readKeys(path: string): z.infer<typeof keySchema> {
  try {
    return keySchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  } catch {
    throw new Error(
      'Cannot read data/keys.json: expected two different keys of at least 32 characters. Restore the file or remove it to generate new keys.',
    );
  }
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  root = projectRoot,
) {
  loadDotEnv({ path: resolve(root, '.env'), processEnv: env, quiet: true });
  const values = parseEnvironment(env);
  const dataDir = resolve(root, values.DATA_DIR);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const keysPath = resolve(dataDir, 'keys.json');
  const generated = {
    adminKey: randomBytes(32).toString('hex'),
    overlayKey: randomBytes(32).toString('hex'),
  };
  try {
    // Exclusive creation preserves keys across restarts and concurrent starts.
    writeFileSync(keysPath, JSON.stringify(generated, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
      throw error;
  }
  const stored = readKeys(keysPath);
  const keys = keySchema.safeParse({
    adminKey: values.ADMIN_KEY ?? stored.adminKey,
    overlayKey: values.OVERLAY_KEY ?? stored.overlayKey,
  });
  if (!keys.success)
    throw new Error(
      'Invalid configuration: ADMIN_KEY and OVERLAY_KEY must differ.',
    );
  return {
    host: values.HOST,
    port: values.PORT,
    baseUrl: values.BASE_URL ?? `http://localhost:${values.PORT}`,
    dataDir,
    databasePath: resolve(dataDir, 'time-capsule.db'),
    logLevel: values.LOG_LEVEL,
    adminKey: keys.data.adminKey,
    overlayKey: keys.data.overlayKey,
    twitchClientId: values.TWITCH_CLIENT_ID,
    twitchClientSecret: values.TWITCH_CLIENT_SECRET,
    twitchRedirectUri: values.TWITCH_REDIRECT_URI,
    offlineOpenDelaySeconds: values.OFFLINE_OPEN_DELAY_SECONDS,
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
