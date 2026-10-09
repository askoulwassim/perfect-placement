import {
  type Answer,
  type ConfidenceBand,
  type Decision,
  type DecisionKind,
  type HardHumanSubject,
  IMPACTS,
  type Impact,
  isHardHuman,
  type KindThresholds,
  POLICY_GRID,
  type PolicyConfig,
  type PolicyOutcome,
  type Question,
  SECOND_OPINION_MIN_P,
  type Thresholds,
  thresholdsFor,
} from '@perfect-placement/contracts';

/*
 * The confidence x impact policy (decisions.md #4). The grid itself is POLICY_GRID in contracts;
 * this module is the only place that reads it.
 */

/** p >= auto: confident. second_opinion <= p < auto: middle. Else low. */
export function confidenceBand(p: number, t: Thresholds): ConfidenceBand {
  if (p >= t.auto) return 'confident';
  if (p >= t.second_opinion) return 'middle';
  return 'low';
}

/**
 * Pure grid lookup (wave1-decisions #24). `auto_second` means "auto only if a second backend agrees";
 * the resolver turns it into `human` when the second opinion fails (see `finalOutcome`).
 * Hard exclusions are not part of the grid: use `policyOutcome` for a full decision.
 */
export function decide(answer: Pick<Answer, 'p'>, impact: Impact, thresholds: Thresholds): PolicyOutcome {
  return POLICY_GRID[impact][confidenceBand(answer.p, thresholds)];
}

/**
 * The full policy for one answer: hard exclusions (`isHardHuman`, never tunable) win, then the grid,
 * then the per-kind `confident_outcome` override (plain `auto` on a confident answer becomes `auto_undo`).
 */
export function policyOutcome(
  answer: Pick<Answer, 'p'>,
  impact: Impact,
  thresholds: KindThresholds,
  hard: HardHumanSubject = {},
): PolicyOutcome {
  if (isHardHuman(hard)) return 'human';
  const outcome = decide(answer, impact, thresholds);
  if (outcome === 'auto' && thresholds.confident_outcome && confidenceBand(answer.p, thresholds) === 'confident')
    return thresholds.confident_outcome;
  return outcome;
}

/** Effective thresholds: base config, then the per-kind override, then a per-call override. */
export function effectiveThresholds(config: PolicyConfig, kind: DecisionKind, perCall?: Partial<Thresholds>): KindThresholds {
  return { ...thresholdsFor(config, kind), ...(perCall ?? {}) };
}

/**
 * Minimum impact per decision kind. A caller may ask with a higher impact, never a lower one.
 * Defense in depth: `apply.submit` can never be auto-applied even if a caller passes `low`.
 */
export const KIND_IMPACT_FLOOR: Partial<Record<DecisionKind, Impact>> = {
  'apply.submit': 'high',
  'profile.apply_diff': 'medium',
  'outreach.to_gmail': 'medium',
  'roles.move': 'medium',
  'roles.archive': 'medium',
  'freshness.closed': 'medium',
  'inbox.classify': 'medium',
  'apply.fact_check': 'medium',
};

export function maxImpact(a: Impact, b: Impact): Impact {
  return IMPACTS.indexOf(a) >= IMPACTS.indexOf(b) ? a : b;
}

export function effectiveImpact(kind: DecisionKind, requested: Impact): Impact {
  const floor = KIND_IMPACT_FLOOR[kind];
  return floor ? maxImpact(floor, requested) : requested;
}

/** Same answer? Choice: case-insensitive label. Score: same rounded level. Noulli: same boolean. */
export function sameValue(question: Question | undefined, a: Answer['value'], b: Answer['value']): boolean {
  if (question?.type === 'score' || (typeof a === 'number' && typeof b === 'number')) {
    return Math.round(Number(a)) === Math.round(Number(b));
  }
  if (typeof a === 'string' && typeof b === 'string') return a.trim().toLowerCase() === b.trim().toLowerCase();
  return a === b;
}

/** decisions.md: "Second backend agrees" = same option, its p >= 0.70. */
export function secondOpinionAgrees(question: Question | undefined, primary: Answer, second: Answer | undefined): boolean {
  if (!second) return false;
  return sameValue(question, primary.value, second.value) && second.p >= SECOND_OPINION_MIN_P;
}

/** Resolve the grid's `auto_second` into the stored outcome. */
export function finalOutcome(decided: PolicyOutcome, secondAgrees: boolean): PolicyOutcome {
  if (decided === 'auto_second') return secondAgrees ? 'auto_second' : 'human';
  return decided;
}

/** End of the undo window for an `auto_undo` decision made at `now`. */
export function undoUntil(now: Date, t: Thresholds): string {
  return new Date(now.getTime() + t.undo_hours * 3_600_000).toISOString();
}

/** Only `auto_undo` decisions that were applied can be undone, and only inside their window. */
export function canUndo(d: Pick<Decision, 'policy_outcome' | 'status' | 'undo_until'>, now: Date): boolean {
  if (d.policy_outcome !== 'auto_undo' || d.status !== 'applied' || !d.undo_until) return false;
  return now.getTime() <= Date.parse(d.undo_until);
}
