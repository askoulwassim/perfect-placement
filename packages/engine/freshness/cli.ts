#!/usr/bin/env node
/*
 * Freshness backfill dry run (lane G). Read-only: never writes to the source, never calls the resolver.
 *
 *   node packages/engine/dist/freshness/cli.js dry-run --db <pp.db> --out <dir> [--limit N] [--delay-ms 1500]
 *
 * Reports name real roles, so --out must be outside this repo (enforced).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../db/connection.js';
import { defaultFetch } from '../integrations/ats/index.js';
import { backfillDryRun, memoryStore, rolesFromDb } from './backfill.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), import.meta.url.includes('/dist/') ? '../../../..' : '../../..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (process.argv[2] !== 'dry-run') {
    console.error('usage: cli.js dry-run --db <pp.db> --out <dir> [--limit N] [--delay-ms N]');
    process.exit(2);
  }
  const out = arg('out');
  if (!out) throw new Error('--out <dir> is required');
  const outAbs = resolve(out);
  if (!relative(REPO_ROOT, outAbs).startsWith('..'))
    throw new Error(`--out must be outside the repo (${REPO_ROOT}): reports name real roles`);
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  const delayMs = arg('delay-ms') ? Number(arg('delay-ms')) : 1500;

  const dbPath = arg('db');
  if (!dbPath) throw new Error('--db <pp.db> is required');
  const db = openDb(dbPath, { readonly: true });
  const store = memoryStore(rolesFromDb(db));
  const source = 'pp.db (read-only)';

  const run = await backfillDryRun(store, source, { fetch: defaultFetch(), delayMs, limit });
  db.close();
  mkdirSync(outAbs, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  writeFileSync(join(outAbs, `${stamp}_freshness_dry_run.md`), run.report);
  writeFileSync(join(outAbs, `${stamp}_freshness_dry_run.json`), `${JSON.stringify({ summary: run.summary, rows: run.rows }, null, 2)}\n`);
  const s = run.summary;
  console.log(`checked ${s.checked}: open ${s.open}, closed ${s.closed}, unsure ${s.unsure}, stale ${s.stale}, errors ${s.errors}`);
  console.log(`via ats_api ${s.by_method.ats_api}, page ${s.by_method.page}, resolver ${s.by_method.resolver}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
