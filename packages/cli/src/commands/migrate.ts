// Lane A owns this file. `pp migrate --from <v1 repo path> [--home <dir>] [--dry-run] [--json]`.
// `pp migrate` (cli.ts) calls `migrateCommand`; the importer is the engine's `db.migrateV1`, which refuses a PP_HOME inside a git repo.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '@perfect-placement/engine';

export const OWNER_LANE = 'A' as const;

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
  env?: NodeJS.ProcessEnv;
}

const defaultIo: CliIo = { out: (s) => console.log(s), err: (s) => console.error(s) };

/** Minimal flag parser: `--key value`, `--key=value`, boolean `--flag`. */
export function parseFlags(argv: string[], booleans: readonly string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split(/=(.*)/s);
    if (v !== undefined) flags[k as string] = v;
    else if (booleans.includes(k as string)) flags[k as string] = true;
    else flags[k as string] = argv[++i] ?? '';
  }
  return flags;
}

export const MIGRATE_USAGE = 'pp migrate --from <v1 repo path> [--home <PP_HOME>] [--dry-run] [--json]';

/** Returns the process exit code. */
export function migrateCommand(argv: string[], io: CliIo = defaultIo): number {
  const f = parseFlags(argv, ['dry-run', 'json', 'help']);
  if (f.help || typeof f.from !== 'string' || !f.from) {
    (f.help ? io.out : io.err)(MIGRATE_USAGE);
    return f.help ? 0 : 1;
  }
  const home = db.resolvePpHome(typeof f.home === 'string' ? f.home : undefined, io.env ?? process.env);
  let report: db.MigrateV1Report;
  try {
    report = db.migrateV1({ from: resolve(f.from), home, dryRun: f['dry-run'] === true });
  } catch (e) {
    io.err(`pp migrate: ${(e as Error).message}`);
    return 1;
  }
  if (f.json) {
    io.out(JSON.stringify(report, null, 2));
    return report.countsMatch ? 0 : 2;
  }
  const fmt = (o: Record<string, number | undefined>) =>
    Object.entries(o)
      .filter(([, n]) => n)
      .map(([k, n]) => `${k} ${n}`)
      .join(', ') || 'none';
  io.out(`${report.dryRun ? 'dry run: ' : ''}${report.from} -> ${report.home}`);
  io.out(`roles: ${fmt(report.planned)}`);
  io.out(`v1 counts: ${fmt(report.v1Counts)} (${report.countsMatch ? 'match' : 'MISMATCH'})`);
  io.out(`archive reasons: ${fmt(report.archiveReasons)}`);
  io.out(`scores: ${report.scores.planned}/${report.scores.v1}`);
  io.out(`inserted: ${fmt(report.inserted)}`);
  io.out(`already present: ${fmt(report.skipped)}`);
  io.out(`files: ${report.filesWritten} written, ${report.filesSkipped} already present`);
  if (report.warnings.length) {
    io.out(`warnings (${report.warnings.length}):`);
    for (const w of report.warnings) io.out(`  - ${w}`);
  }
  return report.countsMatch ? 0 : 2;
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) process.exitCode = migrateCommand(process.argv.slice(2));
