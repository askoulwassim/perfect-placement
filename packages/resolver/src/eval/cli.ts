#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, type DecisionBackend } from '@perfect-placement/contracts';
import { backendsFromConfig } from '../config.js';
import { runEval } from './harness.js';
import { renderReport } from './report.js';
import { mockBackends, syntheticCases } from './synthetic.js';

/*
 * pp-resolver-eval (synthetic cases only)
 *   --seed N                    synthetic case seed (default 7)
 *   --backends kev,llm          which backends (default both)
 *   --live                      real transports: Kev a server at config kev.baseUrl, LLM ANTHROPIC_API_KEY
 *   --out <dir>                 where report.md + metrics.json go (default eval-reports/synthetic)
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const out = resolve(arg('out') ?? join(REPO_ROOT, 'packages/resolver/eval-reports/synthetic'));
  const live = flag('live');
  const wanted = (arg('backends') ?? 'kev,llm').split(',').map((s) => s.trim());
  const cases = syntheticCases({ seed: Number(arg('seed') ?? 7) });

  let pool: Record<string, DecisionBackend>;
  const notes: string[] = [];
  if (live) {
    // An explicit --live eval opts in to the adapter that is off by default (the Anthropic API).
    const b = DEFAULT_CONFIG.backends;
    const map = backendsFromConfig({
      ...DEFAULT_CONFIG,
      backends: { ...b, llm: { provider: 'anthropic', enabled: true } },
    });
    pool = {};
    for (const b of wanted) {
      const be = map[b as 'kev' | 'llm'];
      if (be) pool[b] = be;
      else notes.push(`${b}: not configured (missing key or server), skipped`);
    }
  } else {
    pool = Object.fromEntries(Object.entries(mockBackends(cases)).filter(([k]) => wanted.includes(k)));
    notes.push('Backends are MOCKED (synthetic noise over the label). Numbers show the harness works, not how Kev or the LLM perform.');
  }

  const result = await runEval({ cases, backends: pool, concurrency: live ? 4 : 1 });
  mkdirSync(out, { recursive: true });
  const title = `Resolver eval: synthetic (${live ? 'live' : 'mocked'} backends)`;
  writeFileSync(join(out, 'report.md'), renderReport(result, { title, label: 'synthetic truth', notes }));
  writeFileSync(
    join(out, 'metrics.json'),
    `${JSON.stringify({ metrics: result.metrics, byKind: result.byKind, agreement: result.agreement }, null, 2)}\n`,
  );
  console.log(`eval: ${result.cases} cases x ${result.backends.length} backends -> ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
