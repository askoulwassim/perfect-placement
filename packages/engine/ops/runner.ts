import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunnerConfig, Skill } from '@perfect-placement/contracts';

/*
 * Headless agent runner for `runs.start` (wave1-decisions #9). UI buttons and schedules start a run;
 * the run row is committed first, then the configured runner (`config.runner`) is launched with the
 * skill's SKILL.md as the prompt and an MCP config pointing at the `pp` MCP server over stdio.
 * The runner finishes with `runs.finish`. The launch is injected (`EngineServices.launcher`):
 * tests use a fake and nothing ever spawns in CI. Flags per runner: see ops/README.md.
 */

/** Name of the MCP server in every runner's config; tools appear as `mcp__pp__<tool>` in Claude Code. */
export const MCP_SERVER_NAME = 'pp';

export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** A file the launcher writes before starting (Cursor reads MCP servers from `<cwd>/.cursor/mcp.json`). */
export interface RunnerFile {
  /** Relative to the run's working directory. */
  path: string;
  content: string;
}

export interface RunnerSpec {
  runId: string;
  command: string;
  args: string[];
  /** Working directory. `null` = a fresh temp dir (needed when `files` is non-empty). */
  cwd: string | null;
  env: Record<string, string>;
  files: RunnerFile[];
}

export interface RunnerLauncher {
  /** Start the runner and resolve once it is running (reject if it cannot start). Never waits for it to finish. */
  launch(spec: RunnerSpec): Promise<{ pid?: number }>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repo root from packages/engine/ops (source) or packages/engine/dist/ops (build). */
const REPO_ROOT = join(HERE, /[/\\]dist([/\\]|$)/.test(HERE) ? '../../../..' : '../../..');

/** `skills/` at the repo root. */
export const DEFAULT_SKILLS_DIR = join(REPO_ROOT, 'skills');

/** The pp MCP server over stdio (packages/mcp, built), pointed at this vault. */
export function defaultMcpServer(home: string): McpServerSpec {
  return { command: process.execPath, args: [join(REPO_ROOT, 'packages/mcp/dist/bin.js')], env: { PP_HOME: home } };
}

export interface PromptContext {
  runId: string;
  skill: Skill;
  roleId?: string;
  contactId?: string;
}

/** The prompt: the skill's SKILL.md plus the run's ids and the closing instruction. */
export function skillPrompt(skillsDir: string, c: PromptContext): string {
  const file = join(skillsDir, c.skill, 'SKILL.md');
  const skill = existsSync(file) ? readFileSync(file, 'utf8').trim() : `# ${c.skill}\n\n(SKILL.md not found at ${file})`;
  const ids = [`run_id: ${c.runId}`, ...(c.roleId ? [`role_id: ${c.roleId}`] : []), ...(c.contactId ? [`contact_id: ${c.contactId}`] : [])];
  return [
    `You are running the Perfect Placement "${c.skill}" skill headless. Every read and write goes through the ${MCP_SERVER_NAME} MCP tools; never edit files or the database directly. Never submit an application or send an email.`,
    '',
    ids.join('\n'),
    '',
    `The run already exists (runs.start was called for you). Pass run_id in your work and finish with runs.finish { run_id: "${c.runId}", status }.`,
    '',
    skill,
  ].join('\n');
}

/** Command line per runner (flags verified against each CLI's docs, 2026-10). */
export function buildRunnerSpec(opts: {
  runner: RunnerConfig;
  prompt: string;
  runId: string;
  skill: Skill;
  home: string;
  mcp: McpServerSpec;
}): RunnerSpec {
  const { runner, prompt, mcp, home, runId } = opts;
  const extra = runner.args ?? [];
  const env = { ...mcp.env, PP_RUN_ID: runId };
  const server = { command: mcp.command, args: mcp.args, env: mcp.env };
  switch (runner.command) {
    case 'claude': {
      const mcpConfig = JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: server } });
      return {
        runId,
        command: 'claude',
        args: [
          '-p',
          prompt,
          '--mcp-config',
          mcpConfig,
          '--strict-mcp-config',
          '--allowedTools',
          `mcp__${MCP_SERVER_NAME}`,
          '--permission-prompts',
          'none',
          '--output-format',
          'json',
          // LinkedIn people reads go through Claude in Chrome (wave1-decisions #4).
          ...(opts.skill === 'connect' ? ['--chrome'] : []),
          ...extra,
        ],
        cwd: home,
        env,
        files: [],
      };
    }
    case 'codex': {
      const toml = (v: unknown) => JSON.stringify(v);
      const envPairs = Object.entries(mcp.env).flatMap(([k, v]) => ['-c', `mcp_servers.${MCP_SERVER_NAME}.env.${k}=${toml(v)}`]);
      return {
        runId,
        command: 'codex',
        args: [
          'exec',
          // PP_HOME is never a git repo (rule 5).
          '--skip-git-repo-check',
          '-c',
          `mcp_servers.${MCP_SERVER_NAME}.command=${toml(mcp.command)}`,
          '-c',
          `mcp_servers.${MCP_SERVER_NAME}.args=${toml(mcp.args)}`,
          ...envPairs,
          // Headless: nobody can approve a prompt; MCP tool calls are otherwise cancelled.
          '-c',
          'approval_policy="never"',
          ...extra,
          prompt,
        ],
        cwd: home,
        env,
        files: [],
      };
    }
    case 'cursor-agent':
      return {
        runId,
        command: 'cursor-agent',
        args: ['-p', prompt, '--output-format', 'text', '--approve-mcps', '--force', ...extra],
        // cursor-agent reads MCP servers from the project's .cursor/mcp.json: a fresh temp dir per run.
        cwd: null,
        env,
        files: [{ path: '.cursor/mcp.json', content: `${JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: server } }, null, 2)}\n` }],
      };
  }
}

/** Spawns the runner detached; output goes to a log file in the OS temp dir (never the vault). */
export function createSpawnLauncher(): RunnerLauncher {
  return {
    launch(spec) {
      const cwd = spec.cwd ?? mkdtempSync(join(tmpdir(), `pp-run-${spec.runId}-`));
      for (const f of spec.files) {
        const abs = join(cwd, f.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, f.content);
      }
      const logDir = join(tmpdir(), 'pp-runs');
      mkdirSync(logDir, { recursive: true });
      const log = openSync(join(logDir, `${spec.runId}.log`), 'a');
      return new Promise((ok, fail) => {
        const child = spawn(spec.command, spec.args, {
          cwd,
          env: { ...process.env, ...spec.env },
          detached: true,
          stdio: ['ignore', log, log],
        });
        child.once('error', (e) => {
          closeSync(log);
          fail(e);
        });
        child.once('spawn', () => {
          closeSync(log);
          child.unref();
          ok(child.pid === undefined ? {} : { pid: child.pid });
        });
      });
    },
  };
}
