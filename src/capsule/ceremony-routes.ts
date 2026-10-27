import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ceremony } from './ceremony.js';
import { CapsuleError } from './model.js';
type AdminCheck = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown>;
export function registerCeremonyRoutes(
  app: FastifyInstance,
  ceremony: Ceremony,
  requireAdmin: AdminCheck,
  overlayUrl: string,
) {
  app.get('/api/ceremony', { preHandler: requireAdmin }, () => ({
    ceremony: ceremony.dashboard(),
    overlayUrl,
  }));
  app.get('/api/ceremony/queue', { preHandler: requireAdmin }, (request) => {
    const parsed = z
      .object({
        status: z
          .enum(['pending', 'approved', 'rejected', 'revealed', 'all'])
          .default('pending'),
        offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict()
      .safeParse(request.query);
    if (!parsed.success)
      throw new CapsuleError(400, 'Choose a valid queue filter and page.');
    return ceremony.queue(
      parsed.data.status,
      parsed.data.offset,
      parsed.data.limit,
    );
  });
  app.post(
    '/api/ceremony/seals/:id',
    { preHandler: requireAdmin },
    (request) => {
      const params = z
        .object({
          id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        })
        .safeParse(request.params);
      const body = z
        .object({ status: z.enum(['approved', 'rejected']) })
        .strict()
        .safeParse(request.body);
      if (!params.success || !body.success)
        throw new CapsuleError(
          400,
          'Choose a message and approve or reject it.',
        );
      ceremony.moderate(params.data.id, body.data.status);
      return { ceremony: ceremony.dashboard() };
    },
  );
  app.post('/api/ceremony/reveal', { preHandler: requireAdmin }, () => {
    ceremony.revealNext();
    return { ceremony: ceremony.dashboard() };
  });
  app.post('/api/ceremony/end', { preHandler: requireAdmin }, () => {
    ceremony.end();
    return { ceremony: ceremony.dashboard() };
  });
  app.post('/api/ceremony/auto', { preHandler: requireAdmin }, (request) => {
    const parsed = z
      .object({ enabled: z.boolean() })
      .strict()
      .safeParse(request.body);
    if (!parsed.success)
      throw new CapsuleError(400, 'Choose whether auto-reveal is enabled.');
    ceremony.setAuto(parsed.data.enabled);
    return { ceremony: ceremony.dashboard() };
  });
  app.post(
    '/api/ceremony/settings',
    { preHandler: requireAdmin },
    (request) => {
      ceremony.configure(request.body);
      return { ceremony: ceremony.dashboard() };
    },
  );
  app.post('/api/ceremony/preview', { preHandler: requireAdmin }, () => {
    ceremony.preview();
    return { ceremony: ceremony.dashboard() };
  });
}
