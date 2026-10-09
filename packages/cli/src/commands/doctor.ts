// Lane A owns this file. `pp doctor [--home <PP_HOME>] [--json]` -> system.doctor.
// `pp doctor` (cli.ts) runs the system.doctor op through the engine and prints it with `renderDoctor`.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db } from '@perfect-placement/engine';

export const OWNER_LANE = 'A' as const;

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
  env?: NodeJS.ProcessEnv;
}

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

const defaultIo: CliIo = { out: (s) => console.log(s), err: (s) => console.error(s) };

/** Returns the process exit code (0 green, 1 any check failed). */
export function doctorCommand(argv: string[], io: CliIo = defaultIo, cwd: string = process.cwd()): number {
  const f = parseFlags(argv, ['json', 'help']);
  if (f.help) {
    io.out('pp doctor [--home <PP_HOME>] [--json]');
    return 0;
  }
  const home = db.resolvePpHome(typeof f.home === 'string' ? f.home : undefined, io.env ?? process.env);
  return renderDoctor(db.doctor({ home, cwd }), home, io, f.json === true);
}

/** Print a doctor result (text, or JSON with `json`) and return the exit code. Shared with `pp doctor` via the engine. */
export function renderDoctor(res: db.DoctorResult, home: string, io: CliIo, json: boolean): number {
  if (json) io.out(JSON.stringify(res, null, 2));
  else {
    io.out(`pp doctor: ${home}`);
    for (const c of res.checks) io.out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
  }
  return res.ok ? 0 : 1;
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) process.exitCode = doctorCommand(process.argv.slice(2));
