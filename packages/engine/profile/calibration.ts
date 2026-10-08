import { CRITERIA, type Criterion } from '@perfect-placement/contracts';
import { NEUTRAL_WEIGHTS, normalizeWeights } from './components.js';
import type { Db } from './deps.js';
import type { Draft } from './questions.js';

/*
 * Calibration: yes / no / maybe on 12 sample postings -> criterion weights.
 * Method (documented in profile/README.md):
 *
 *   y = 1 (yes), 0.5 (maybe), 0 (no)
 *   r_i = Pearson correlation between criterion level x_i (1..5) and y over judged samples
 *         (0 when either has no variance)
 *   s   = n / (n + N0)            evidence strength, N0 = 4  (n = 12 -> 0.75)
 *   w_i = prior_i * exp(BETA * s * r_i), BETA = 2
 *   clamp w_i to [MIN_W, MAX_W] (as a share of the prior total), renormalize to integers summing to 100
 *
 * Stated preferences are the prior; choices win: at n = 12 a perfectly predictive
 * criterion gets x4.5 and an anti-predictive one x0.22 before clamping.
 */

export const CALIBRATION_SIZE = 12;
export const BETA = 2;
export const N0 = 4;
export const MIN_W = 2;
export const MAX_W = 35;

export type CalibrationChoice = 'yes' | 'no' | 'maybe';

export interface CalibrationSample {
  id: string;
  title: string;
  company?: string;
  /** Criterion levels 1..5 for this posting (from its latest score, or judged). */
  criteria: Record<Criterion, number>;
}

const Y: Record<CalibrationChoice, number> = { yes: 1, maybe: 0.5, no: 0 };

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] ?? 0) - mx;
    const dy = (ys[i] ?? 0) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

export function deriveWeights(
  prior: Record<Criterion, number>,
  samples: readonly CalibrationSample[],
  choices: Readonly<Record<string, CalibrationChoice>>,
): { weights: Record<Criterion, number>; correlations: Record<Criterion, number> } {
  const judged = samples.filter((s) => choices[s.id]);
  const ys = judged.map((s) => Y[choices[s.id] as CalibrationChoice]);
  const p = normalizeWeights(prior);
  const strength = judged.length / (judged.length + N0);
  const correlations = {} as Record<Criterion, number>;
  const raw = {} as Record<Criterion, number>;
  for (const c of CRITERIA) {
    const r = pearson(
      judged.map((s) => s.criteria[c]),
      ys,
    );
    correlations[c] = Math.round(r * 1000) / 1000;
    raw[c] = Math.min(MAX_W, Math.max(MIN_W, p[c] * Math.exp(BETA * strength * r)));
  }
  return { weights: normalizeWeights(raw), correlations };
}

/**
 * Prior from stated preferences: the current profile's weights (or neutral), nudged by
 * interview answers that speak to a criterion. Small multipliers: choices dominate later.
 */
export function statedPrior(base: Record<Criterion, number> | null, draft: Draft): Record<Criterion, number> {
  const w = { ...(base ?? NEUTRAL_WEIGHTS) };
  const craft = draft.craft ?? {};
  const team = draft.team ?? {};
  const growth = draft.growth ?? {};
  const terms = draft.terms ?? {};
  if (craft.facing === 'external') w.c3 *= 1.25;
  if (craft.facing === 'internal') w.c3 *= 0.75;
  if (typeof team.proximity === 'string' && /founder|ceo|vp/i.test(team.proximity)) w.c1 *= 1.2;
  if (Array.isArray(draft.domain?.ranked) && draft.domain.ranked.length) w.c5 *= 1.1;
  if (growth.trajectory === 'up') w.c8 *= 1.1;
  if (terms.equity === 'high') w.c6 *= 1.1;
  return normalizeWeights(w);
}

/**
 * Default sample source (SHIM until lane F/B expose a sampler): up to 12 scored roles,
 * round-robin across bands so the set spans green, yellow and red. Levels = latest score.
 */
export function samplesFromDb(db: Db, n = CALIBRATION_SIZE): CalibrationSample[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.title, c.name AS company, s.band, s.c1, s.c2, s.c3, s.c4, s.c5, s.c6, s.c7, s.c8, s.c9
       FROM role r JOIN company c ON c.id = r.company_id
       JOIN score s ON s.role_id = r.id
       WHERE s.created_at = (SELECT MAX(created_at) FROM score s2 WHERE s2.role_id = r.id)
       ORDER BY r.id`,
    )
    .all() as Array<Record<string, unknown>>;
  const byBand: Record<string, Array<Record<string, unknown>>> = { green: [], yellow: [], red: [] };
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.id as string)) continue;
    seen.add(r.id as string);
    byBand[r.band as string]?.push(r);
  }
  const picked: Array<Record<string, unknown>> = [];
  while (picked.length < n && (byBand.green?.length || byBand.yellow?.length || byBand.red?.length)) {
    for (const b of ['green', 'yellow', 'red']) {
      const next = byBand[b]?.shift();
      if (next && picked.length < n) picked.push(next);
    }
  }
  return picked.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    company: r.company as string,
    criteria: Object.fromEntries(CRITERIA.map((c) => [c, Number(r[c])])) as Record<Criterion, number>,
  }));
}
