import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * Done-when (lane B): no lane B file edits the db or the vault outside ops.
 * Writes are allowed only in packages/engine/ops (handlers, runtime, shims).
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SCANNED = [
  'packages/cli/src',
  'packages/engine/status',
  'skills/scout',
  'skills/research',
  'skills/tailor',
  'skills/fill',
  'skills/inbox',
];
const WRITES = [
  /\bINSERT\s+INTO\b/i,
  /\bUPDATE\s+\w+\s+SET\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bdb\.(exec|prepare)\(/,
  /\bwriteFileSync\b/,
  /\bappendFileSync\b/,
  /\brenameSync\b/,
  /\bunlinkSync\b/,
  /\brmSync\b/,
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe('ops-only writes', () => {
  it('lane B code outside packages/engine/ops never writes the db or vault directly', () => {
    const hits: string[] = [];
    for (const dir of SCANNED)
      for (const f of files(join(REPO, dir))) {
        if (/\.test\.ts$/.test(f)) continue;
        const src = readFileSync(f, 'utf8');
        for (const re of WRITES) if (re.test(src)) hits.push(`${relative(REPO, f)}: ${re}`);
      }
    expect(hits).toEqual([]);
  });
});
