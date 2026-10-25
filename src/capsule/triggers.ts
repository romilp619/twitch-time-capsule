import type { Capsule, CapsuleStatus } from './model.js';

export interface TriggerFacts {
  now: number;
  live: boolean | null;
  followers: number | null;
  categoryId: string | null;
  offlineDelayMs: number;
  openingAllowed?: boolean;
}
export interface TriggerState {
  status: CapsuleStatus;
  readyAt: string | null;
  openingDueAt: string | null;
  postponedUntil: string | null;
}
export type TriggerAction = 'check' | 'open' | 'postpone';
export function conditionMet(capsule: Capsule, facts: TriggerFacts): boolean {
  switch (capsule.triggerType) {
    case 'manual':
      return false;
    case 'date':
      return facts.now >= Date.parse(capsule.triggerValue);
    case 'followers':
      return (
        facts.followers !== null && facts.followers >= capsule.triggerValue
      );
    case 'category':
      return (
        facts.live === true &&
        facts.categoryId === capsule.triggerValue.category_id
      );
  }
}
// No I/O or clocks here: all timing and Twitch facts are explicit inputs.
export function nextTriggerState(
  capsule: Capsule,
  facts: TriggerFacts,
  action: TriggerAction = 'check',
): TriggerState {
  const state: TriggerState = {
    status: capsule.status,
    readyAt: capsule.readyAt,
    openingDueAt: capsule.openingDueAt,
    postponedUntil: capsule.postponedUntil,
  };
  if (!['sealing', 'locked', 'ready'].includes(state.status)) return state;
  if (action === 'postpone') {
    state.postponedUntil = new Date(facts.now + 10 * 60_000).toISOString();
    if (state.status === 'ready')
      state.openingDueAt =
        facts.live === true
          ? new Date(
              Math.max(
                Date.parse(state.postponedUntil),
                state.openingDueAt ? Date.parse(state.openingDueAt) : 0,
              ),
            ).toISOString()
          : null;
    return state;
  }
  if (action === 'open') state.postponedUntil = null;
  const becameReady =
    state.status !== 'ready' &&
    (action === 'open' || conditionMet(capsule, facts));
  if (becameReady) {
    state.status = 'ready';
    state.readyAt = new Date(facts.now).toISOString();
    state.openingDueAt = null;
  }
  if (state.status !== 'ready') return state;
  if (facts.live !== true) {
    state.openingDueAt = null;
    return state;
  }
  if (state.openingDueAt === null || action === 'open') {
    state.openingDueAt = new Date(
      facts.now +
        (becameReady || action === 'open' ? 5000 : facts.offlineDelayMs),
    ).toISOString();
  }
  const due = Math.max(
    Date.parse(state.openingDueAt),
    state.postponedUntil ? Date.parse(state.postponedUntil) : 0,
  );
  state.openingDueAt = new Date(due).toISOString();
  if (facts.now >= due && facts.openingAllowed !== false) {
    state.status = 'opening';
    state.openingDueAt = null;
  }
  return state;
}
