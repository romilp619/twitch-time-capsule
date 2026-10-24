import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { projectRoot, type AppConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { constantEqual, TwitchAuth, roles } from './twitch/auth.js';
import { TwitchConnection } from './twitch/connection.js';
import { HelixClient } from './twitch/helix.js';
import { safeMessage, TwitchError, type TwitchFetch } from './twitch/http.js';

function cookie(request: FastifyRequest, name: string): string {
  return (
    (request.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(name + '='))
      ?.slice(name.length + 1) ?? ''
  );
}
export function buildServer(
  config: AppConfig,
  dependencies: { fetcher?: TwitchFetch; now?: () => number } = {},
) {
  const auth = new TwitchAuth(config, dependencies.fetcher, dependencies.now);
  const connection = new TwitchConnection(
    auth,
    new HelixClient(auth, dependencies.fetcher),
  );
  const db = openDatabase(config.databasePath);
  const app = Fastify({
    bodyLimit: 32 * 1024,
    logger:
      config.logLevel === 'silent'
        ? false
        : {
            level: config.logLevel,
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-admin-key"]',
              'res.headers.set-cookie',
            ],
            serializers: {
              req: (request: { method: string; url: string }) => ({
                method: request.method,
                path: request.url.split('?')[0],
              }),
            },
          },
  });
  app.addHook('onReady', () => connection.start());
  app.addHook('onClose', async () => {
    await connection.close();
    db.close();
  });
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  });
  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({ error: 'Not found.' });
  });
  app.setErrorHandler((error, _request, reply) => {
    const status =
      error instanceof TwitchError
        ? error.status >= 400
          ? error.status
          : 502
        : error instanceof Error &&
            'statusCode' in error &&
            (error.statusCode === 400 || error.statusCode === 413)
          ? error.statusCode
          : 500;
    void reply.code(status).send({
      error:
        error instanceof TwitchError
          ? safeMessage(error)
          : status === 400 || status === 413
            ? 'Invalid request.'
            : 'The operation failed. Check local storage permissions and try again.',
    });
  });
  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    const key = request.headers['x-admin-key'];
    if (typeof key !== 'string' || !constantEqual(key, config.adminKey))
      return reply
        .code(401)
        .send({ error: 'A valid dashboard key is required.' });
    const origin = request.headers.origin;
    if (
      request.method !== 'GET' &&
      origin &&
      origin !== new URL(config.baseUrl).origin
    )
      return reply
        .code(403)
        .send({ error: 'Open the dashboard using the configured BASE_URL.' });
  };
  const roleBody = z.object({ role: z.enum(roles) }).strict();
  app.get('/health', () => {
    db.prepare('SELECT 1').get();
    return { status: 'ok', app: 'time-capsule', phase: 2, database: 'ok' };
  });
  app.get('/', async (_request, reply) => reply.redirect('/health'));
  app.get('/dashboard', async (request, reply) => {
    const query = z
      .object({
        key: z.string().max(1024),
        notice: z.string().max(40).optional(),
      })
      .safeParse(request.query);
    if (!query.success || !constantEqual(query.data.key, config.adminKey))
      return reply
        .code(401)
        .type('text/plain')
        .send('Open the private dashboard URL printed in the server console.');
    return reply
      .type('text/html; charset=utf-8')
      .send(
        readFileSync(
          resolve(projectRoot, 'public/dashboard/index.html'),
          'utf8',
        ),
      );
  });
  // These two static assets contain no account data or private keys.
  app.get('/dashboard/app.js', async (_request, reply) =>
    reply
      .type('text/javascript; charset=utf-8')
      .send(
        readFileSync(resolve(projectRoot, 'public/dashboard/app.js'), 'utf8'),
      ),
  );
  app.get('/dashboard/style.css', async (_request, reply) =>
    reply
      .type('text/css; charset=utf-8')
      .send(
        readFileSync(
          resolve(projectRoot, 'public/dashboard/style.css'),
          'utf8',
        ),
      ),
  );
  app.get('/api/connection', { preHandler: requireAdmin }, () =>
    connection.snapshot(),
  );
  app.post(
    '/api/connection/refresh',
    { preHandler: requireAdmin },
    async () => {
      await connection.refresh();
      return connection.snapshot();
    },
  );
  app.post(
    '/api/auth/start',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const body = roleBody.safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ error: 'Choose streamer or bot.' });
      const pending = auth.begin(body.data.role);
      const secure =
        new URL(config.baseUrl).protocol === 'https:' ? '; Secure' : '';
      reply.header(
        'Set-Cookie',
        pending.cookieName +
          '=' +
          pending.binding +
          '; Path=/auth/callback; Max-Age=600; HttpOnly; SameSite=Lax' +
          secure,
      );
      return { url: pending.url };
    },
  );
  app.post(
    '/api/auth/disconnect',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const body = roleBody.safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ error: 'Choose streamer or bot.' });
      auth.disconnect(body.data.role);
      connection.notice(null);
      await connection.refresh();
      return connection.snapshot();
    },
  );
  app.get('/auth/callback', async (request, reply) => {
    const query = z
      .object({
        state: z.string().regex(/^[a-f0-9]{64}$/),
        code: z.string().min(1).max(2048).optional(),
        error: z.string().max(100).optional(),
        error_description: z.string().max(2048).optional(),
        scope: z.string().max(4096).optional(),
      })
      .safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({
        error: 'Invalid OAuth callback. Start again from the dashboard.',
      });
    const name = auth.cookieName(query.data.state);
    const role = auth.consumeState(query.data.state, cookie(request, name));
    reply.header(
      'Set-Cookie',
      name + '=; Path=/auth/callback; Max-Age=0; HttpOnly; SameSite=Lax',
    );
    const dashboard = new URL('/dashboard', config.baseUrl);
    dashboard.searchParams.set('key', config.adminKey);
    if (query.data.error || !query.data.code) {
      dashboard.searchParams.set('notice', 'denied');
    } else {
      try {
        await auth.connect(role, query.data.code);
        connection.notice(null);
        await connection.refresh();
        dashboard.searchParams.set('notice', 'connected');
      } catch (error) {
        connection.notice(safeMessage(error));
        dashboard.searchParams.set('notice', 'failed');
      }
    }
    return reply.redirect(dashboard.toString());
  });
  return app;
}
