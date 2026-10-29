import { z } from 'zod';
import { CapsuleError } from './model.js';
export const overlaySettingsSchema = z
  .object({
    side: z.enum(['left', 'right']).default('right'),
    cardScale: z
      .union([z.literal(0.85), z.literal(1), z.literal(1.15)])
      .default(1),
    autoRevealSeconds: z.number().int().min(3).max(60).default(8),
  })
  .strict();
export type OverlaySettings = z.infer<typeof overlaySettingsSchema>;
export const ceremonyStateSchema = z
  .object({
    capsuleId: z.number().int().positive().nullable(),
    stage: z.enum(['idle', 'opening', 'queue', 'reveal', 'prophet', 'ended']),
    startedAt: z.number(),
    updatedAt: z.number(),
    recentSealIds: z.array(z.number().int().positive()).max(3),
    lastRevealAt: z.number().nullable(),
    autoReveal: z.boolean(),
    prophetSealId: z.number().int().positive().nullable().default(null),
  })
  .strict();
export type CeremonyState = z.infer<typeof ceremonyStateSchema>;
export const idleCeremony = (): CeremonyState => ({
  capsuleId: null,
  stage: 'idle',
  startedAt: 0,
  updatedAt: 0,
  recentSealIds: [],
  lastRevealAt: null,
  autoReveal: false,
  prophetSealId: null,
});
export type CeremonyEvent =
  | { type: 'begin'; capsuleId: number }
  | { type: 'tick' }
  | { type: 'reveal'; sealId: number }
  | { type: 'prophet'; sealId: number }
  | { type: 'auto'; enabled: boolean }
  | { type: 'end' };
export function isCeremonyActive(state: CeremonyState): boolean {
  return ['opening', 'queue', 'reveal', 'prophet'].includes(state.stage);
}
// The reducer only decides transitions; SQL, approval, and clocks live outside it.
export function transitionCeremony(
  state: CeremonyState,
  event: CeremonyEvent,
  now: number,
): CeremonyState {
  switch (event.type) {
    case 'begin':
      if (isCeremonyActive(state))
        throw new CapsuleError(409, 'A ceremony is already running.');
      return {
        ...idleCeremony(),
        capsuleId: event.capsuleId,
        stage: 'opening',
        startedAt: now,
        updatedAt: now,
      };
    case 'tick':
      return state.stage === 'opening' && now - state.startedAt >= 6000
        ? { ...state, stage: 'queue', updatedAt: now }
        : state;
    case 'reveal':
      if (!['queue', 'reveal', 'prophet'].includes(state.stage))
        throw new CapsuleError(
          409,
          'Wait for the opening animation before revealing messages.',
        );
      if (state.recentSealIds.includes(event.sealId))
        throw new CapsuleError(409, 'This message has already been revealed.');
      return {
        ...state,
        stage: 'reveal',
        prophetSealId: null,
        recentSealIds: [...state.recentSealIds, event.sealId].slice(-3),
        lastRevealAt: now,
        updatedAt: now,
      };
    case 'prophet':
      if (!['reveal', 'prophet'].includes(state.stage))
        throw new CapsuleError(409, 'Reveal a message before marking it true.');
      return {
        ...state,
        stage: 'prophet',
        prophetSealId: event.sealId,
        recentSealIds: state.recentSealIds.includes(event.sealId)
          ? state.recentSealIds
          : [...state.recentSealIds, event.sealId].slice(-3),
        updatedAt: now,
      };
    case 'auto':
      if (!['queue', 'reveal', 'prophet'].includes(state.stage))
        throw new CapsuleError(
          409,
          'Auto-reveal is available after the opening animation.',
        );
      return {
        ...state,
        autoReveal: event.enabled,
        lastRevealAt: event.enabled ? now : state.lastRevealAt,
        updatedAt: now,
      };
    case 'end':
      if (!isCeremonyActive(state))
        throw new CapsuleError(409, 'No ceremony is running.');
      return {
        ...state,
        stage: 'ended',
        recentSealIds: [],
        autoReveal: false,
        updatedAt: now,
      };
  }
}
