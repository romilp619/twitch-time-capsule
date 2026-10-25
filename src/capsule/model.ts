import { z } from 'zod';

export const settingsSchema = z
  .object({
    max_seals_per_user: z.number().int().min(1).max(100).default(3),
    max_length: z.number().int().min(3).max(280).default(280),
    vip_reward: z.boolean().default(false),
    vip_days: z.number().int().min(1).max(365).default(30),
  })
  .strict();
const common = {
  title: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((value) =>
      Array.from(value).every(
        (character) =>
          character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127,
      ),
    ),
  settings: settingsSchema.prefault({}),
};
export const createCapsuleSchema = z.discriminatedUnion('triggerType', [
  z
    .object({
      ...common,
      triggerType: z.literal('manual'),
      triggerValue: z.null().default(null),
    })
    .strict(),
  z
    .object({
      ...common,
      triggerType: z.literal('date'),
      triggerValue: z.iso.datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      ...common,
      triggerType: z.literal('followers'),
      triggerValue: z.number().int().min(1).max(1_000_000_000),
    })
    .strict(),
  z
    .object({
      ...common,
      triggerType: z.literal('category'),
      triggerValue: z
        .object({
          category_id: z.string().regex(/^\d{1,30}$/),
          category_name: z.string().trim().min(1).max(200),
        })
        .strict(),
    })
    .strict(),
]);
export type CapsuleInput = z.infer<typeof createCapsuleSchema>;
export type CapsuleSettings = z.infer<typeof settingsSchema>;
export type CapsuleStatus =
  'sealing' | 'locked' | 'ready' | 'opening' | 'opened' | 'archived';
export interface ChannelIdentity {
  id: string;
  login: string;
  displayName: string;
}
export type Capsule = CapsuleInput & {
  id: number;
  slug: string;
  status: CapsuleStatus;
  createdAt: string;
  lockedAt: string | null;
  openedAt: string | null;
  readyAt: string | null;
  openingDueAt: string | null;
  postponedUntil: string | null;
  channel: ChannelIdentity;
  sealedCount: number;
  visibleCount: number;
};
export class CapsuleError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CapsuleError';
  }
}
export function conditionText(capsule: Capsule, now = Date.now()): string {
  switch (capsule.triggerType) {
    case 'manual':
      return 'when the streamer opens it';
    case 'followers':
      return (
        'at ' + capsule.triggerValue.toLocaleString('en-US') + ' followers'
      );
    case 'category':
      return (
        'the first time @' +
        capsule.channel.login +
        ' streams ' +
        capsule.triggerValue.category_name
      );
    case 'date': {
      const minutes = Math.max(
        0,
        Math.ceil((Date.parse(capsule.triggerValue) - now) / 60_000),
      );
      const countdown =
        minutes === 0
          ? 'date reached'
          : Math.floor(minutes / 1440) +
            'd ' +
            Math.floor((minutes % 1440) / 60) +
            'h ' +
            (minutes % 60) +
            'm remaining';
      return (
        'on ' +
        new Date(capsule.triggerValue).toISOString() +
        ' (' +
        countdown +
        ')'
      );
    }
  }
}
