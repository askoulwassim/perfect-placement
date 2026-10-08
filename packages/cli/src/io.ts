import { readFileSync } from 'node:fs';
import { Actor, type OpOutcome } from '@perfect-placement/contracts';
import type { Args } from './args.js';

export interface Io {
  env: NodeJS.ProcessEnv;
  out(line: string): void;
  err(line: string): void;
  /** Reads all of stdin (for `--in -`). */
  stdin(): string;
}

export const processIo: Io = {
  env: process.env,
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
  stdin: () => readFileSync(0, 'utf8'),
};

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
