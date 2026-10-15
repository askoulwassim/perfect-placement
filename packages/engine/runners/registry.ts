import { isAbsolute } from 'node:path';
import { claude } from './claude.js';
import { codex } from './codex/index.js';
import { cursorAgent } from './cursor.js';
import type { RunnerBinding, RunnerCommand, RunnerSpec, RunRequest } from './types.js';

/** Every runner `config.runner.command` can name. Adding one = its module plus one entry here. */
export const RUNNERS: Readonly<Record<RunnerCommand, RunnerBinding>> = { claude, codex, 'cursor-agent': cursorAgent };

/** Command line per runner (flags verified against each CLI's docs, 2026-10). */
export function buildRunnerSpec(opts: RunRequest): RunnerSpec {
  if (opts.filesDir !== undefined && !isAbsolute(opts.filesDir)) throw new Error(`filesDir must be absolute: ${opts.filesDir}`);
  // #50: the pp MCP server gets PP_RUN_ID too, so every op the run performs carries ctx.runId.
  const env = { ...opts.mcp.env, PP_RUN_ID: opts.runId };
  const server = { command: opts.mcp.command, args: opts.mcp.args, env };
  return RUNNERS[opts.runner.command].run({ ...opts, extra: opts.runner.args ?? [], env, server });
}
