import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Actor, type OpOutcome } from '@perfect-placement/contracts';
import type { EngineServices } from '@perfect-placement/engine';
import type { Args } from './args.js';
import type { SystemDeps } from './system/deps.js';

export interface Io {
  env: NodeJS.ProcessEnv;
  out(line: string): void;
  err(line: string): void;
  /** Reads all of stdin (for `--in -`). */
  stdin(): string;
  /** Engine services override (tests: no network, no Kev, no runner spawn). Default: the real ones. */
  services?: EngineServices;
  /** Yes/no question (setup, kev install). Default: a TTY prompt; without a TTY the answer is the default. */
  ask?(question: string, defaultYes: boolean): Promise<boolean>;
  /** Machine access for `pp setup` / `pp kev` / Kev in `pp up` (tests: temp HOME, fake spawn, no network). */
  sys?: SystemDeps;
}

export const processIo: Io = {
  env: process.env,
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
  stdin: () => readFileSync(0, 'utf8'),
  ask: async (question, defaultYes) => {
    if (!process.stdin.isTTY) return defaultYes;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const a = (await rl.question(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
      return a === '' ? defaultYes : a === 'y' || a === 'yes';
    } finally {
      rl.close();
    }
  },
};

/** Ask, unless `--yes` (then yes). Without an `ask` the default stands. */
export async function confirm(io: Io, yes: boolean, question: string, defaultYes = false): Promise<boolean> {
  if (yes) return true;
  return io.ask ? io.ask(question, defaultYes) : defaultYes;
}

export class CliError extends Error {}

/** `--in <file>` or `--in -` (stdin) as JSON. */
export function readJsonInput(args: Args, io: Io): unknown {
  const src = args.get('in');
  if (!src) throw new CliError('missing --in <file|->');
  const raw = src === '-' ? io.stdin() : readFileSync(src, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new CliError(`--in is not valid JSON: ${(e as Error).message}`);
  }
}

/** Accept a bare list or `{ <key>: [...] }` (v1 compatible). */
export function listInput(data: unknown, key: string): unknown[] {
  if (Array.isArray(data)) return data;
  const v = (data as Record<string, unknown> | null)?.[key];
  if (Array.isArray(v)) return v;
  throw new CliError(`expected a JSON list or { "${key}": [...] }`);
}

export function actorOf(args: Args, fallback: Actor): Actor {
  const raw = args.get('actor');
  if (!raw) return fallback;
  const parsed = Actor.safeParse(raw);
  if (!parsed.success) throw new CliError(`--actor must be one of ${Actor.options.join(', ')}`);
  return parsed.data;
}

export const exitCodeOf = (o: OpOutcome<unknown>) => (o.status === 'error' ? 1 : 0);
export const show = (io: Io, value: unknown) => io.out(JSON.stringify(value, null, 2));
