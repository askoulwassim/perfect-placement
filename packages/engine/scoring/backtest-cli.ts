#!/usr/bin/env node
/*
 * Backtest CLI (read-only).
 *   node packages/engine/dist/scoring/backtest-cli.js --v1 <v1 repo> --out <dir outside this repo>
 * Reads 02_Pipeline/data/{pipeline,scores}.json and 00_System/rubric.json. Never writes to the v1 repo.
 * The report names companies and roles: it refuses to write inside this repo.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderReport, runBacktest, type V1Data } from './backtest.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), import.meta.url.includes('/dist/') ? '../../../..' : '../../..');

function main(): number {
  const v1Root = arg('v1');
  const outDir = arg('out');
  if (!v1Root || !outDir) {
    console.error('usage: backtest-cli --v1 <v1 repo root> --out <report dir outside this repo>');
    return 2;
  }
  const out = resolve(outDir);
  const root = realpathSync(repoRoot);
  const inside = (p: string) => p === root || p.startsWith(root + sep);
  if (inside(out)) {
    console.error(`refusing to write a backtest report inside the system repo (${root})`);
    return 2;
  }
  mkdirSync(out, { recursive: true });
  const realOut = realpathSync(out);
  if (inside(realOut)) {
    console.error(`refusing to write a backtest report inside the system repo (${root})`);
    return 2;
  }
  const read = (p: string) => JSON.parse(readFileSync(join(resolve(v1Root), p), 'utf8'));
  const v1: V1Data = {
    pipeline: read('02_Pipeline/data/pipeline.json'),
    scores: read('02_Pipeline/data/scores.json'),
    rubric: read('00_System/rubric.json'),
  };
  const results = runBacktest(v1);
  const generated = new Date().toISOString();
  writeFileSync(join(realOut, 'backtest.md'), renderReport(results, { includeRoles: true, generated }));
  writeFileSync(join(realOut, 'backtest.json'), `${JSON.stringify(results, null, 2)}\n`);
  for (const { summary: s } of results) {
    console.log(
      `${s.scenario}: ${s.changed}/${s.roles} change state; active ${s.before.roles} -> ${s.after.roles}; companies ${s.before.companies} -> ${s.after.companies}; top-5 share ${s.before.top5_share}% -> ${s.after.top5_share}%; max/company ${s.before.max_per_company} -> ${s.after.max_per_company}; dream share ${s.before.dream_share}% -> ${s.after.dream_share}%`,
    );
  }
  console.log(`report: ${join(realOut, 'backtest.md')}`);
  return 0;
}

process.exit(main());
