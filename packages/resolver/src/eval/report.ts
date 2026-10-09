import type { BackendMetrics, EvalResult } from './harness.js';

const pct = (x: number | null): string => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const num = (x: number | null, d = 3): string => (x === null ? 'n/a' : x.toFixed(d));
const ms = (x: number | null): string => (x === null ? 'n/a' : `${Math.round(x)} ms`);

function metricsTable(rows: BackendMetrics[]): string {
  const head =
    '| Backend | Answered | Acc vs label | Within 1 (score) | MAE (score) | Mean p | Brier | ECE | Auto rate | Auto acc | Call p50 | Call p95 |\n' +
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';
  const body = rows.map(
    (m) =>
      `| ${m.backend} | ${m.answered}/${m.n} | ${pct(m.accuracy)} | ${pct(m.within1)} | ${num(m.mae, 2)} | ${num(m.meanP, 2)} | ${num(m.brier)} | ${num(m.ece)} | ${pct(m.autoRate)} | ${pct(m.autoAccuracy)} | ${ms(m.latencyP50)} | ${ms(m.latencyP95)} |`,
  );
  return [head, ...body].join('\n');
}

export function renderReport(result: EvalResult, meta: { title: string; label: string; notes?: string[] }): string {
  const out: string[] = [];
  out.push(`# ${meta.title}`, '');
  out.push(`Cases: ${result.cases}. Backends: ${result.backends.join(', ')}. Label: ${meta.label}.`, '');
  for (const n of meta.notes ?? []) out.push(`- ${n}`);
  if (meta.notes?.length) out.push('');
  out.push('## Overall', '', metricsTable(result.metrics), '');
  for (const [kind, rows] of Object.entries(result.byKind)) {
    out.push(`## ${kind}`, '', metricsTable(rows), '');
  }
  out.push('## Agreement between backends', '');
  out.push(`| | ${result.backends.join(' | ')} |`);
  out.push(`| --- | ${result.backends.map(() => '---').join(' | ')} |`);
  for (const a of result.backends) {
    out.push(`| ${a} | ${result.backends.map((b) => pct(result.agreement[a]?.[b]?.rate ?? null)).join(' | ')} |`);
  }
  out.push('', '## Calibration (p bin -> observed accuracy)', '');
  for (const m of result.metrics) {
    out.push(`**${m.backend}**`, '', '| p bin | n | mean p | accuracy |', '| --- | --- | --- | --- |');
    for (const b of m.calibration)
      out.push(`| ${b.lo.toFixed(1)} to ${b.hi.toFixed(1)} | ${b.n} | ${b.meanP.toFixed(2)} | ${pct(b.accuracy)} |`);
    out.push('');
  }
  const errors = result.runs.filter((r) => r.error);
  if (errors.length) {
    const byBackend = new Map<string, number>();
    for (const e of errors) byBackend.set(e.backend, (byBackend.get(e.backend) ?? 0) + 1);
    out.push(
      '## Errors',
      '',
      ...[...byBackend].map(([b, n]) => `- ${b}: ${n} unanswered (first: ${errors.find((e) => e.backend === b)?.error})`),
      '',
    );
  }
  out.push(
    '## How to read this',
    '',
    '- Acc vs label: share of answers equal to the label (true score or class). Within 1 / MAE apply to 1..5 criterion scores.',
    '- Call p50 / p95: latency of the backend call that carried the question (one call holds every question for a state).',
    '- Brier and ECE measure calibration: lower is better. A calibrated backend at p = 0.9 is right about 90% of the time.',
    '- Auto rate / Auto acc: what the policy would auto-apply at default thresholds for each case impact, and how often those picks were right. High impact cases are never auto.',
    '',
  );
  return out.join('\n');
}
