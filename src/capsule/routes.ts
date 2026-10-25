import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { projectRoot } from '../config.js';
import type { EventLog } from '../db/events.js';
import type { TwitchAuth } from '../twitch/auth.js';
import type { HelixClient } from '../twitch/helix.js';
import { CapsuleError } from './model.js';
import type { TriggerScheduler } from './scheduler.js';
import type { CapsuleStore } from './store.js';

export function registerCapsuleRoutes(
  app: FastifyInstance,
  dependencies: {
    store: CapsuleStore;
    triggers: TriggerScheduler;
    auth: TwitchAuth;
    helix: HelixClient;
    log: EventLog;
    requireAdmin: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<unknown>;
  },
) {
  const { store, triggers, auth, helix, log, requireAdmin } = dependencies;
  app.get('/api/capsules', { preHandler: requireAdmin }, () => ({
    capsules: store.list(),
  }));
  app.post(
    '/api/capsules',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const streamer = auth.publicAccount('streamer');
      if (
        streamer.status !== 'connected' ||
        !streamer.userId ||
        !streamer.login ||
        !streamer.displayName
      )
        throw new CapsuleError(
          409,
          'Connect the streamer account before creating a capsule.',
        );
      const capsule = store.create(request.body, {
        id: streamer.userId,
        login: streamer.login,
        displayName: streamer.displayName,
      });
      log.write('capsule.created', {
        capsuleId: capsule.id,
        title: capsule.title,
        triggerType: capsule.triggerType,
      });
      triggers.tick();
      return reply.code(201).send({ capsule: store.get(capsule.id) });
    },
  );
  app.post(
    '/api/capsules/:id/:action',
    { preHandler: requireAdmin },
    async (request) => {
      const parsed = z
        .object({
          id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          action: z.enum(['lock', 'archive', 'open', 'postpone']),
        })
        .safeParse(request.params);
      if (!parsed.success)
        throw new CapsuleError(400, 'Choose a valid capsule and action.');
      if (parsed.data.action === 'open' || parsed.data.action === 'postpone')
        return { capsule: triggers.action(parsed.data.id, parsed.data.action) };
      const capsule = store.changeStatus(parsed.data.id, parsed.data.action);
      triggers.tick();
      log.write(
        parsed.data.action === 'lock' ? 'capsule.locked' : 'capsule.archived',
        { capsuleId: capsule.id },
      );
      return { capsule };
    },
  );
  app.get('/api/categories', { preHandler: requireAdmin }, async (request) => {
    const parsed = z
      .object({ query: z.string().trim().min(2).max(100) })
      .safeParse(request.query);
    if (!parsed.success)
      throw new CapsuleError(
        400,
        'Type 2 to 100 characters to search Twitch categories.',
      );
    return { categories: await helix.searchCategories(parsed.data.query) };
  });
  const slug = (params: unknown): string => {
    const parsed = z
      .object({
        slug: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
      })
      .safeParse(params);
    if (!parsed.success) throw new CapsuleError(404, 'Capsule not found.');
    return parsed.data.slug;
  };
  app.get('/api/public/capsules/:slug', (request) => {
    const capsule = store.publicView(slug(request.params));
    if (!capsule) throw new CapsuleError(404, 'Capsule not found.');
    const facts = triggers.snapshot();
    const source = store.bySlug(capsule.slug);
    return {
      ...capsule,
      followers:
        source?.channel.id === facts.channelId ? facts.followers : null,
    };
  });
  app.get('/c/:slug', (request, reply) => {
    if (!store.publicView(slug(request.params)))
      throw new CapsuleError(404, 'Capsule not found.');
    return reply
      .type('text/html; charset=utf-8')
      .send(
        readFileSync(resolve(projectRoot, 'public/capsule/index.html'), 'utf8'),
      );
  });
  app.get('/capsule/app.js', (_request, reply) =>
    reply
      .type('text/javascript; charset=utf-8')
      .send(
        readFileSync(resolve(projectRoot, 'public/capsule/app.js'), 'utf8'),
      ),
  );
  app.get('/capsule/style.css', (_request, reply) =>
    reply
      .type('text/css; charset=utf-8')
      .send(
        readFileSync(resolve(projectRoot, 'public/capsule/style.css'), 'utf8'),
      ),
  );
}
