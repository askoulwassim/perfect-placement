import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServerSpec } from './types.js';

/*
 * Headless agent runner for `runs.start` (wave1-decisions #9). UI buttons and schedules start a run;
 * the run row is committed first, then the configured runner (`config.runner`) is launched with the
 * skill's SKILL.md as the prompt and an MCP config pointing at the `pp` MCP server over stdio.
 * The runner finishes with `runs.finish`. The launch is injected (`EngineServices.launcher`):
 * tests use a fake and nothing ever spawns in CI. Flags per runner: see runners/README.md.
 */

/** Name of the MCP server in every runner's config; tools appear as `mcp__pp__<tool>` in Claude Code. */
export const MCP_SERVER_NAME = 'pp';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The repo root (the directory holding `skills/` and `pnpm-workspace.yaml`), found by walking up from
 * `from`: works from packages/engine/runners (source) and packages/engine/dist/runners (build).
 */
export function resolveRepoRoot(from: string = HERE): string {
  for (let dir = from; ; ) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) && existsSync(join(dir, 'skills'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return join(from, /[/\\]dist([/\\]|$)/.test(from) ? '../../../..' : '../../..');
}

export const REPO_ROOT = resolveRepoRoot();

/** `skills/` at the repo root. */
export const DEFAULT_SKILLS_DIR = join(REPO_ROOT, 'skills');

/** A node inside a versioned Homebrew keg (`.../Cellar/<formula>/<version>/bin/node`): gone after `brew upgrade`. */
export const CELLAR_NODE = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/;

/**
 * The node to write into any config (runner `--mcp-config`, agent MCP registrations): PP_NODE (set by
 * the install.sh launcher), else `execPath` with a Homebrew Cellar path mapped to its stable `opt/`
 * link, so a `brew upgrade` does not break it (#33).
 */
export function stableNodePath(
  env: Record<string, string | undefined> = process.env,
  execPath: string = process.execPath,
  exists: (p: string) => boolean = existsSync,
): string {
  if (env.PP_NODE && exists(env.PP_NODE)) return env.PP_NODE;
  const m = CELLAR_NODE.exec(execPath);
  if (m) {
    const opt = `${m[1]}/opt/${m[2]}/bin/node`;
    if (exists(opt)) return opt;
  }
  return execPath;
}

/** The pp MCP server over stdio (packages/mcp, built), pointed at this vault, on a stable node path. */
export function defaultMcpServer(home: string, nodePath: string = stableNodePath()): McpServerSpec {
  return { command: nodePath, args: [join(REPO_ROOT, 'packages/mcp/dist/bin.js')], env: { PP_HOME: home } };
}
