import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TwitchAuth } from './twitch/auth.js';
import type { HelixClient } from './twitch/helix.js';
import type { ChatSender } from './twitch/chat.js';
import type { TwitchConnection } from './twitch/connection.js';
import type { CapsuleStore } from './capsule/store.js';
import type { BlockedWords } from './capsule/moderation.js';
import type { TriggerScheduler } from './capsule/scheduler.js';
import type { Ceremony } from './capsule/ceremony.js';
import type { Prophets } from './capsule/prophets.js';
import type { EventLog } from './db/events.js';
export interface ServerServices {
  auth: TwitchAuth;
  helix: HelixClient;
  sender: ChatSender;
  connection: TwitchConnection;
  capsules: CapsuleStore;
  blockedWords: BlockedWords;
  triggers: TriggerScheduler;
  ceremony: Ceremony;
  prophets: Prophets;
  log: EventLog;
  changed: () => void;
}
export type AdminCheck = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown>;
export interface ServerExtension {
  mode: 'demo';
  register(
    app: FastifyInstance,
    services: ServerServices,
    requireAdmin: AdminCheck,
  ): void;
  initialize(): Promise<void>;
  ready(): Promise<void>;
  close(): Promise<void>;
}
