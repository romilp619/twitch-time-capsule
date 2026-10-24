import Fastify from 'fastify';
import type { AppConfig } from './config.js';
import { openDatabase } from './db/index.js';

export function buildServer(config: AppConfig) {
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
              'res.headers.set-cookie',
            ],
            serializers: {
              // Omit query strings so future admin/overlay keys cannot appear in request logs.
              req: (request: { method: string; url: string }) => ({
                method: request.method,
                path: request.url.split('?')[0],
              }),
            },
          },
  });
  app.addHook('onClose', () => {
    db.close();
  });
  app.get(
    '/health',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['status', 'app', 'phase', 'database'],
            properties: {
              status: { type: 'string' },
              app: { type: 'string' },
              phase: { type: 'integer' },
              database: { type: 'string' },
            },
          },
        },
      },
    },
    () => {
      db.prepare('SELECT 1').get();
      return { status: 'ok', app: 'time-capsule', phase: 1, database: 'ok' };
    },
  );
  app.get('/', async (_request, reply) => reply.redirect('/health'));
  return app;
}
