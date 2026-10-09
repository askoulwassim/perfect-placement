import type { Answer, AskRequest, DecisionBackend, DecisionKind, Impact, Question, Thresholds } from '@perfect-placement/contracts';
import { DEFAULT_CONFIG } from '@perfect-placement/contracts';
import { decide, sameValue } from '../policy.js';

/*
 * Eval harness: replay labelled calls (synthetic criterion scores and inbox classifications) through
 * several backends and measure accuracy vs the label, agreement between backends, calibration of p,
 * latency, and what the policy would have auto-applied.
 *
 * Cases sharing a `group` (e.g. the 9 criteria of one role) go to a backend in one call, the way
 * Jev is meant to be used (many questions, one state).
 */

export interface EvalCase {
  id: string;
  source: string;
  kind: DecisionKind;
  impact: Impact;
  group?: string;
  state: AskRequest['state'];
  question: Question;
  expected: Answer['value'];
}

export interface EvalRun {
  caseId: string;
  backend: string;
  value?: Answer['value'];
  p?: number;
  correct?: boolean;
  latencyMs?: number;
  error?: string;
}

export interface BackendMetrics {
  backend: string;
  n: number;
  answered: number;
  accuracy: number | null;
  /** Score questions only: |value - expected| <= 1. */
  within1: number | null;
  /** Score questions only. */
  mae: number | null;
  meanP: number | null;
  brier: number | null;
  /** Expected calibration error, 10 equal-width bins. */
  ece: number | null;
  /** Share of answered cases the policy would auto-apply (any auto outcome before second opinion). */
  autoRate: number | null;
  /** Accuracy among those auto cases. */
  autoAccuracy: number | null;
  latencyP50: number | null;
  latencyP95: number | null;
  calibration: { lo: number; hi: number; n: number; meanP: number; accuracy: number }[];
}

export interface EvalResult {
  cases: number;
  backends: string[];
  runs: EvalRun[];
  metrics: BackendMetrics[];
  byKind: Record<string, BackendMetrics[]>;
  /** agreement[a][b] = share of cases both answered with the same value. */
  agreement: Record<string, Record<string, { n: number; rate: number | null }>>;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? null;
}

export function calibrationBins(pairs: { p: number; correct: boolean }[], bins = 10) {
  const out: BackendMetrics['calibration'] = [];
  for (let i = 0; i < bins; i++) {
    const lo = i / bins;
    const hi = (i + 1) / bins;
    const inBin = pairs.filter((x) => x.p >= lo && (i === bins - 1 ? x.p <= hi : x.p < hi));
    if (!inBin.length) continue;
    out.push({
      lo,
      hi,
      n: inBin.length,
      meanP: mean(inBin.map((x) => x.p)) as number,
      accuracy: inBin.filter((x) => x.correct).length / inBin.length,
    });
  }
  return out;
}

export function expectedCalibrationError(pairs: { p: number; correct: boolean }[], bins = 10): number | null {
  if (!pairs.length) return null;
  return calibrationBins(pairs, bins).reduce((s, b) => s + (b.n / pairs.length) * Math.abs(b.meanP - b.accuracy), 0);
}

export function computeMetrics(backend: string, cases: EvalCase[], runs: EvalRun[], thresholds: Thresholds): BackendMetrics {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const mine = runs.filter((r) => r.backend === backend && byId.has(r.caseId));
  const answered = mine.filter((r) => r.value !== undefined && r.p !== undefined);
  const pairs = answered.map((r) => ({ p: r.p as number, correct: !!r.correct }));
  const scoreRuns = answered.filter((r) => byId.get(r.caseId)?.question.type === 'score');
  const diffs = scoreRuns.map((r) => Math.abs(Number(r.value) - Number(byId.get(r.caseId)?.expected)));
  const auto = answered.filter((r) => {
    const c = byId.get(r.caseId) as EvalCase;
    return decide({ p: r.p as number }, c.impact, thresholds) !== 'human';
  });
  const lat = mine.filter((r) => r.latencyMs !== undefined).map((r) => r.latencyMs as number);
  return {
    backend,
    n: mine.length,
    answered: answered.length,
    accuracy: answered.length ? pairs.filter((x) => x.correct).length / answered.length : null,
    within1: diffs.length ? diffs.filter((d) => d <= 1).length / diffs.length : null,
    mae: mean(diffs),
    meanP: mean(pairs.map((x) => x.p)),
    brier: mean(pairs.map((x) => (x.p - (x.correct ? 1 : 0)) ** 2)),
    ece: expectedCalibrationError(pairs),
    autoRate: answered.length ? auto.length / answered.length : null,
    autoAccuracy: auto.length ? auto.filter((r) => r.correct).length / auto.length : null,
    latencyP50: quantile(lat, 0.5),
    latencyP95: quantile(lat, 0.95),
    calibration: calibrationBins(pairs),
  };
}

export function agreementMatrix(cases: EvalCase[], runs: EvalRun[], backends: string[]): EvalResult['agreement'] {
  const q = new Map(cases.map((c) => [c.id, c.question]));
  const key = (r: EvalRun) => `${r.backend}\u0000${r.caseId}`;
  const idx = new Map(runs.filter((r) => r.value !== undefined).map((r) => [key(r), r]));
  const out: EvalResult['agreement'] = {};
  for (const a of backends) {
    out[a] = {};
    for (const b of backends) {
      let n = 0;
      let same = 0;
      for (const c of cases) {
        const ra = idx.get(`${a}\u0000${c.id}`);
        const rb = idx.get(`${b}\u0000${c.id}`);
        if (!ra || !rb) continue;
        n++;
        if (sameValue(q.get(c.id), ra.value as Answer['value'], rb.value as Answer['value'])) same++;
      }
      (out[a] as Record<string, { n: number; rate: number | null }>)[b] = { n, rate: n ? same / n : null };
    }
  }
  return out;
}

export interface RunEvalOptions {
  cases: EvalCase[];
  backends: Record<string, DecisionBackend>;
  thresholds?: Thresholds;
  /** Max groups in flight per backend. */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

export async function runEval(opts: RunEvalOptions): Promise<EvalResult> {
  const thresholds = opts.thresholds ?? DEFAULT_CONFIG.policy;
  const groups = new Map<string, EvalCase[]>();
  for (const c of opts.cases) {
    const g = c.group ?? c.id;
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  const groupList = [...groups.values()];
  const runs: EvalRun[] = [];
  const names = Object.keys(opts.backends);
  const total = groupList.length * names.length;
  let done = 0;

  async function runGroup(name: string, b: DecisionBackend, cs: EvalCase[]) {
    const first = cs[0] as EvalCase;
    const req: AskRequest = { decision: first.kind, impact: first.impact, state: first.state, questions: cs.map((c) => c.question) };
    try {
      const res = await b.ask(req);
      for (const c of cs) {
        const a = res.answers.find((x) => x.id === c.question.id);
        if (!a) runs.push({ caseId: c.id, backend: name, error: 'no answer' });
        else
          runs.push({
            caseId: c.id,
            backend: name,
            value: a.value,
            p: a.p,
            correct: sameValue(c.question, a.value, c.expected),
            latencyMs: res.latencyMs,
          });
      }
    } catch (err) {
      for (const c of cs) runs.push({ caseId: c.id, backend: name, error: err instanceof Error ? err.message : String(err) });
    }
    opts.onProgress?.(++done, total);
  }

  const concurrency = Math.max(1, opts.concurrency ?? 4);
  await Promise.all(
    names.map(async (name) => {
      const b = opts.backends[name] as DecisionBackend;
      const queue = [...groupList];
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          for (let cs = queue.shift(); cs; cs = queue.shift()) await runGroup(name, b, cs);
        }),
      );
    }),
  );

  // Question ids repeat across groups (c1..c9 per role), so case ids are the join key, not question ids.
  const kinds = [...new Set(opts.cases.map((c) => c.kind))];
  const byKind: EvalResult['byKind'] = {};
  for (const k of kinds) {
    const cs = opts.cases.filter((c) => c.kind === k);
    byKind[k] = names.map((n) => computeMetrics(n, cs, runs, thresholds));
  }
  return {
    cases: opts.cases.length,
    backends: names,
    runs,
    metrics: names.map((n) => computeMetrics(n, opts.cases, runs, thresholds)),
    byKind,
    agreement: agreementMatrix(opts.cases, runs, names),
  };
}
