import type { GuideState, RoleStatus, Run } from '@perfect-placement/contracts';
import type { Route } from '../router';
import { activeLabel, isActive } from './runs';

/*
 * Getting started (#24, #43; supersedes the per-screen cues of wave1-decisions #27): one ordered path
 * on Now, each step done from real state, never from clicks on the guide. Automatic and one-time: when
 * every step is done the vault keeps `config.ui.guide.done` and the card never shows again. No setting.
 * Policy is done once the policy has been seen: Settings on desktop, the card's read-only summary on the
 * phone, which has no Settings screen (#65).
 */

export const GUIDE_STEPS = ['profile', 'policy', 'scout', 'roles', 'review', 'role'] as const;
export type GuideStepId = (typeof GUIDE_STEPS)[number];

export const STEP_LABEL: Record<GuideStepId, string> = {
  profile: 'Profile',
  policy: 'Policy',
  scout: 'First scout',
  roles: 'Roles arriving',
  review: 'Review',
  role: 'First role',
};

/** The one sentence shown on arrival at a step's screen (opened from the card). */
export const STEP_CUE: Record<GuideStepId, string> = {
  profile: 'Your profile drives every score.',
  policy: 'Set how sure the system must be to act alone.',
  scout: 'Start a scout to find roles that fit.',
  roles: 'Scout, score and research run here.',
  review: 'Your roles, scored against your profile.',
  role: 'Take this role through Research, then Tailor.',
};

/** Where each step's cue lands. */
export const STEP_TARGET: Record<GuideStepId, string> = {
  profile: '.btn--primary',
  policy: '.btn--primary',
  scout: '.btn--primary',
  roles: '[data-screen-label] h1',
  review: '[data-screen-label] h1',
  role: '.btn--primary',
};

/** Statuses a role reaches once Tailor has run (Research -> Tailor done). */
const TAILORED: readonly RoleStatus[] = ['draft-ready', 'applied', 'interviews', 'offers'];

export interface GuideInput {
  /** A confirmed profile exists. */
  profile: boolean;
  flags: GuideState;
  /** Scout runs known (any order). */
  scouts: readonly Run[];
  /** pipeline.summary counts by status. */
  counts: Partial<Record<RoleStatus, number>>;
  /** Top role to open for the last step. */
  topRole: string | null;
  /** Needs you count (Review opens Needs you when there is something there). */
  needsYou: number;
  /** Phone layout: no Settings screen, so Policy opens a read-only summary in the card (#65). */
  mobile?: boolean;
}

export interface GuideStep {
  id: GuideStepId;
  label: string;
  done: boolean;
  /** Live state for the step in progress (the scout run's label, "Failed"). */
  state: string | null;
  route: Route;
  /** The screen the step's cue shows on. */
  screen: Route['screen'];
  /** Opens in the card instead of a screen (mobile Policy: the summary; opening it is the step). */
  inline?: boolean;
}

/** Roles scored = any role past the inbox. */
export const scoredCount = (counts: GuideInput['counts']) =>
  Object.entries(counts).reduce((n, [s, c]) => (s === 'inbox' ? n : n + (c ?? 0)), 0);

export function guideSteps(i: GuideInput): GuideStep[] {
  const scouts = [...i.scouts].sort((a, b) => b.started_at.localeCompare(a.started_at));
  const latest = scouts[0];
  const finished = scouts.some((r) => r.status === 'ok' || r.status === 'partial');
  const scored = scoredCount(i.counts) > 0;
  const tailored = TAILORED.some((s) => (i.counts[s] ?? 0) > 0);
  const rolesState = finished ? null : latest ? (isActive(latest.status) ? activeLabel(latest) : 'Failed') : null;
  const review: Route = i.needsYou > 0 ? { screen: 'needs-you' } : { screen: 'river' };
  const role: Route = i.topRole ? { screen: 'role', roleId: i.topRole } : { screen: 'river' };
  const runs: Route = latest ? { screen: 'runs', runId: latest.id } : { screen: 'runs' };
  const steps: Omit<GuideStep, 'label'>[] = [
    { id: 'profile', done: i.profile, state: null, route: { screen: 'you' }, screen: 'you' },
    i.mobile
      ? { id: 'policy', done: i.flags.policy, state: null, route: { screen: 'now' }, screen: 'now', inline: true }
      : { id: 'policy', done: i.flags.policy, state: null, route: { screen: 'settings' }, screen: 'settings' },
    { id: 'scout', done: scouts.length > 0, state: null, route: { screen: 'river' }, screen: 'river' },
    { id: 'roles', done: finished, state: rolesState, route: runs, screen: 'runs' },
    { id: 'review', done: scored && i.flags.review, state: null, route: review, screen: review.screen },
    { id: 'role', done: tailored, state: null, route: role, screen: role.screen },
  ];
  return steps.map((s) => ({ ...s, label: STEP_LABEL[s.id] }));
}

/** The first step not done, or null when the path is finished. */
export const currentStep = (steps: readonly GuideStep[]) => steps.find((s) => !s.done) ?? null;
