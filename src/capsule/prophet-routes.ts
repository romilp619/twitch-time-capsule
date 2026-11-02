import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Prophets } from './prophets.js';
import { CapsuleError } from './model.js';
export function registerProphetRoutes(
  app: FastifyInstance,
  prophets: Prophets,
  requireAdmin: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<unknown>,
) {
  app.get('/api/prophets', { preHandler: requireAdmin }, (request) => {
    const parsed = z
      .object({
        offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        query: z.string().trim().max(100).default(''),
        filter: z.enum(['all', 'true', 'unmarked']).default('all'),
      })
      .strict()
      .safeParse(request.query);
    if (!parsed.success)
      throw new CapsuleError(400, 'Choose a valid Prophet page.');
    return prophets.list(
      parsed.data.offset,
      parsed.data.limit,
      parsed.data.query,
      parsed.data.filter,
    );
  });
  app.delete('/api/prophets', { preHandler: requireAdmin }, async () => ({
    deleted: await prophets.deletePredictions(),
  }));
  app.delete(
    '/api/prophets/seals/:id',
    { preHandler: requireAdmin },
    async (request) => {
      const parsed = z
        .object({
          id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        })
        .safeParse(request.params);
      if (!parsed.success)
        throw new CapsuleError(400, 'Choose a revealed prediction.');
      return { deleted: await prophets.deletePredictions(parsed.data.id) };
    },
  );
  for (const action of ['came-true', 'retry-vip', 'retry-chat'] as const) {
    app.post(
      '/api/prophets/seals/:id/' + action,
      { preHandler: requireAdmin },
      async (request) => {
        const parsed = z
          .object({
            id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          })
          .safeParse(request.params);
        if (
          !parsed.success ||
          (request.body !== undefined &&
            !z.object({}).strict().safeParse(request.body).success)
        )
          throw new CapsuleError(400, 'Choose a revealed message.');
        if (action === 'came-true') await prophets.mark(parsed.data.id);
        else
          await prophets.retry(
            parsed.data.id,
            action === 'retry-vip' ? 'vip' : 'chat',
          );
        return { ok: true };
      },
    );
  }
  app.post(
    '/api/prophets/expiry',
    { preHandler: requireAdmin },
    async (request) => {
      if (
        request.body !== undefined &&
        !z.object({}).strict().safeParse(request.body).success
      )
        throw new CapsuleError(400, 'No expiry parameters are needed.');
      await prophets.expire();
      return { ok: true };
    },
  );
}
