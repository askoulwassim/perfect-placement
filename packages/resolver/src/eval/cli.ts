#!/usr/bin/env node
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, type DecisionBackend } from '@perfect-placement/contracts';
import { backendsFromConfig } from '../config.js';
import { type EvalCase, runEval } from './harness.js';
import { renderReport } from './report.js';
import { mockBackends, syntheticCases } from './synthetic.js';
import { loadV1InboxCases, loadV1ScoreCases } from './v1.js';

/*
 * pp-resolver-eval
 *   --synthetic                 synthetic cases (default)
 *   --v1 <02_Pipeline dir>      replay v1 scores + inbox classifications (READ-ONLY)
 *   --rubric <rubric.md>        v1 rubric for criterion anchors (optional)
 *   --backends jev,kev,llm      which backends (default all three)
 *   --mock                      mocked transports (default when --synthetic)
 *   --live                      real transports: Jev needs JEV_API_KEY, Kev a server at config kev.baseUrl, LLM ANTHROPIC_API_KEY
 *   --out <dir>                 where report.md + runs.json go
 *
 * Safety: with --v1, --out must be outside this git repo (v1 content is personal data).
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function inside(child: string, parent: string): boolean {
  const c = resolve(child);
  let p: string;
  try {
    p = realpathSync(parent);
  } catch {
    p = resolve(parent);
  }
  return c === p || c.startsWith(`${p}/`) || c.startsWith(`${resolve(parent)}/`);
}

async function main() {
  const v1 = arg('v1');
  const out = resolve(arg('out') ?? (v1 ? '' : join(REPO_ROOT, 'packages/resolver/eval-reports/synthetic')));
  if (v1 && (!arg('out') || inside(out, REPO_ROOT))) {
    console.error('refusing: with --v1, pass --out pointing outside the repo (v1 content never enters the repo)');
    process.exit(2);
  }
  const live = flag('live');
  const wanted = (arg('backends') ?? 'jev,kev,llm').split(',').map((s) => s.trim());

  let cases: EvalCase[];
  if (v1) {
    const rubricPath = arg('rubric');
    const rubric = rubricPath ? readFileSync(rubricPath, 'utf8') : undefined;
    cases = [...loadV1ScoreCases(v1, rubric), ...loadV1InboxCases(v1)];
  } else {
    cases = syntheticCases({ seed: Number(arg('seed') ?? 7) });
  }

  let pool: Record<string, DecisionBackend>;
  const notes: string[] = [];
  if (live) {
    const map = backendsFromConfig(DEFAULT_CONFIG);
    pool = {};
    for (const b of wanted) {
      const be = map[b as 'jev' | 'kev' | 'llm'];
      if (be) pool[b] = be;
      else notes.push(`${b}: not configured (missing key or server), skipped`);
    }
  } else {
    pool = Object.fromEntries(Object.entries(mockBackends(cases)).filter(([k]) => wanted.includes(k)));
    notes.push(
      'Backends are MOCKED (synthetic noise over the label). Numbers show the harness works, not how Jev, Kev or the LLM perform.',
    );
  }
  if (v1)
    notes.push(
      'Label = v1 judgment (Claude-scored rubric criteria, inbox-monitor classes). Inbox state is the v1 note about the email, a weak proxy.',
    );

  const result = await runEval({ cases, backends: pool, concurrency: live ? 4 : 1 });
  mkdirSync(out, { recursive: true });
  const title = `Resolver eval: ${v1 ? 'v1 replay' : 'synthetic'} (${live ? 'live' : 'mocked'} backends)`;
  writeFileSync(join(out, 'report.md'), renderReport(result, { title, label: v1 ? 'v1' : 'synthetic truth', notes }));
  writeFileSync(
    join(out, 'metrics.json'),
    `${JSON.stringify({ metrics: result.metrics, byKind: result.byKind, agreement: result.agreement }, null, 2)}\n`,
  );
  if (v1) writeFileSync(join(out, 'runs.json'), `${JSON.stringify(result.runs, null, 2)}\n`);
  console.log(`eval: ${result.cases} cases x ${result.backends.length} backends -> ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
