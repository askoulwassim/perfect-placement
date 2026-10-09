import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * (d) Nothing outside ops writes the db or the vault (AGENTS.md rule 1).
 * - Raw SQL writes and transactions live only in lane A's db layer and runOp's runtime.
 * - File writes live only in lane A's vault helpers + v1 importer, runOp's staged VaultTx, the
 *   runner launcher (temp dir, never the vault) and the report CLIs (refuse to write inside the repo).
 * - Lane modules get repositories, the emitter and the vault from runOp: they never open a db.
 * - Surfaces (cli, mcp, web) and skills only call runOp.
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    if (f === 'node_modules' || f === 'dist' || f.startsWith('.')) return [];
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|js|mjs|md)$/.test(f) ? [p] : [];
  });
}

const isTestOnly = (rel: string) =>
  /\.test\.tsx?$/.test(rel) ||
  rel.startsWith('packages/engine/testing/') ||
  rel.startsWith('packages/engine/db/testing/') ||
  rel.includes('/__fixtures__/') ||
  rel.endsWith('test-helpers.ts') ||
  rel.includes('/src/testing/') ||
  rel.includes('/scripts/');

const SQL_WRITES = [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bDELETE\s+FROM\b/i, /\bdb\.exec\(/, /\bdb\.transaction\(/];
const FS_WRITES = [/\bwriteFileSync\b/, /\bappendFileSync\b/, /\brenameSync\b/, /\bunlinkSync\b/, /\brmSync\b/, /\bcopyFileSync\b/];
const OPENS_DB = [/from 'better-sqlite3'/, /\bopenDb\(/, /new Database\(/];

// fixtures/ renders the synthetic seed SQL (test data, not a vault).
const SQL_ALLOWED = ['packages/engine/db/', 'packages/engine/ops/runtime.ts', 'packages/fixtures/'];
const FS_ALLOWED = [
  'packages/engine/db/vault.ts',
  'packages/engine/ops/vault.ts',
  'packages/engine/ops/runner.ts',
  // Report CLIs: write reports to --out outside the repo, never the vault.
  'packages/engine/freshness/cli.ts',
  'packages/resolver/src/eval/cli.ts',
  'packages/fixtures/',
  'packages/contracts/scripts/',
];
const LANES = [
  'packages/engine/profile',
  'packages/engine/people',
  'packages/engine/scoring',
  'packages/engine/freshness',
  'packages/engine/status',
];
const SURFACES = ['packages/cli/src', 'packages/mcp/src', 'apps/web/src', 'skills'];

function scan(dirs: string[], patterns: RegExp[], allowed: string[]): string[] {
  const hits: string[] = [];
  for (const dir of dirs)
    for (const f of files(join(REPO, dir))) {
      const rel = relative(REPO, f);
      if (isTestOnly(rel) || allowed.some((a) => rel.startsWith(a))) continue;
      const src = readFileSync(f, 'utf8');
      for (const re of patterns) if (re.test(src)) hits.push(`${rel}: ${re}`);
    }
  return hits;
}

describe('(d) ops-only writes', () => {
  it('raw SQL writes and transactions only in the db layer and runOp', () => {
    expect(scan(['packages', 'apps', 'skills'], SQL_WRITES, SQL_ALLOWED)).toEqual([]);
  });

  it('file writes only in the vault helpers, the staged vault, the runner and the report CLIs', () => {
    expect(scan(['packages', 'apps', 'skills'], FS_WRITES, FS_ALLOWED)).toEqual([]);
  });

  it('lane modules never open a db: runOp hands them repositories', () => {
    // The freshness dry-run CLI opens a db read-only.
    expect(scan(LANES, OPENS_DB, ['packages/engine/freshness/cli.ts'])).toEqual([]);
  });

  it('surfaces and skills only call runOp (no repositories, no db, no vault writes)', () => {
    const hits = scan(
      SURFACES,
      [...SQL_WRITES, ...FS_WRITES, ...OPENS_DB, /\brepos\(/, /\.insert\(/, /VaultTx/],
      [
        // lane A's `pp doctor` command calls lane A directly.
        'packages/cli/src/commands/doctor.ts',
      ],
    );
    expect(hits).toEqual([]);
  });
});
