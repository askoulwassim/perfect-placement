import type { Application, Outreach, Role, Skill } from '@perfect-placement/contracts';

export const STAGES = ['Research', 'Tailor', 'Connect', 'Fill', 'Submit'] as const;
export const STAGE_SKILL: ReadonlyArray<Skill | null> = ['research', 'tailor', 'connect', 'fill', null];
const APP_STAGE_INDEX: Record<Application['stage'], number> = { research: 0, tailor: 1, connect: 2, fill: 3, submit: 4, done: 5 };

/**
 * Current stage 0..5 (5 = done, -1 = archived). The application row wins when it exists;
 * otherwise the handoff rule: inbox/on-deck -> Research, active/held -> Tailor, draft-ready -> Connect.
 * On-deck ("In progress", #105) is a role whose apply stage started; it shows the next stage from what is
 * done (dossier -> Tailor, application stage when one exists).
 * Research is done once the role's company has a dossier (#61), even one written for another role.
 */
export function stageOf(
  role: Pick<Role, 'status'>,
  application: Pick<Application, 'stage'> | null,
  bestDraft?: Pick<Outreach, 'status'> | null,
  hasDossier = false,
): number {
  const stage = baseStage(role, application, bestDraft);
  return stage === 0 && hasDossier ? 1 : stage;
}

function baseStage(
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
