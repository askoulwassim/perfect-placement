import type { Application, Outreach, Role, Skill } from '@perfect-placement/contracts';

export const STAGES = ['Research', 'Tailor', 'Connect', 'Fill', 'Submit'] as const;
export const STAGE_SKILL: ReadonlyArray<Skill | null> = ['research', 'tailor', 'connect', 'fill', null];
const APP_STAGE_INDEX: Record<Application['stage'], number> = { research: 0, tailor: 1, connect: 2, fill: 3, submit: 4, done: 5 };

/**
 * Current stage 0..5 (5 = done, -1 = archived). The application row wins when it exists;
 * otherwise the handoff rule: inbox/on-deck -> Research, active/held -> Tailor, draft-ready -> Connect.
 */
export function stageOf(
  role: Pick<Role, 'status'>,
  application: Pick<Application, 'stage'> | null,
  bestDraft?: Pick<Outreach, 'status'> | null,
): number {
  if (role.status === 'archived') return -1;
  if (role.status === 'applied' || role.status === 'interviews' || role.status === 'offers') return 5;
  // Connect is done once the best-path draft reached Gmail (the engine keeps the application at `connect` until Fill).
  if (application?.stage === 'connect' && (bestDraft?.status === 'in_gmail' || bestDraft?.status === 'replied')) return 3;
  if (application) return APP_STAGE_INDEX[application.stage];
  if (role.status === 'active' || role.status === 'held') return 1;
  if (role.status === 'draft-ready') return 2;
  return 0;
}
