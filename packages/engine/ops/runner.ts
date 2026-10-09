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

/**
 * Claude Code's Gmail connector (claude.ai) tool names. The Gmail draft run may call `create_draft`
 * only; sending tools are denied outright (AGENTS.md rule 4).
 */
export const GMAIL_DRAFT_TOOL = 'mcp__claude_ai_Gmail__create_draft';
export const GMAIL_DENIED_TOOLS = [
  'mcp__claude_ai_Gmail__send_message',
  'mcp__claude_ai_Gmail__reply',
  'mcp__claude_ai_Gmail__forward',
  'mcp__claude_ai_Gmail__delete_draft',
] as const;

/** The `## Gmail draft step` section of a SKILL.md (up to the next `## ` heading), or null. */
export function gmailStepSection(skillMd: string): string | null {
  const m = /^## Gmail draft step\b[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(skillMd);
  return m ? `## Gmail draft step\n${m[1]}`.trim() : null;
}

/**
 * The prompt for a `connect` run scoped to one outreach (Gmail via agent): read the draft, create a
 * Gmail DRAFT with the agent's own Gmail tool (never send), record it with outreach.to_gmail.
 */
export function gmailDraftPrompt(skillsDir: string, c: { runId: string; outreachId: string; roleId: string; contactId: string }): string {
  const file = join(skillsDir, 'connect', 'SKILL.md');
  const section = existsSync(file) ? gmailStepSection(readFileSync(file, 'utf8')) : null;
  return [
    `You are running the Perfect Placement "connect" skill headless, Gmail draft step only. Every Perfect Placement read and write goes through the ${MCP_SERVER_NAME} MCP tools; never edit files or the database directly. Never send an email: create a Gmail DRAFT only. Never submit an application.`,
    '',
    [`run_id: ${c.runId}`, `outreach_id: ${c.outreachId}`, `role_id: ${c.roleId}`, `contact_id: ${c.contactId}`].join('\n'),
    '',
    '1. Read the draft: outreach_get { outreach_id }. Subject = its subject (if null: the role title from roles_get, then " at " and the company name). Body = its `body` field, exactly as returned (greeting, Hook, Proof, Ask, sign-off; plain text).',
    '2. Recipient: the contact\'s email (contacts_get { contact_id }). For a bridge draft (tier "bridge") it is the mutual: the link for this role names via_contact_id; use that contact\'s email. No email on file = leave To empty.',
    "3. Create a Gmail DRAFT with your Gmail draft tool (Claude Code: the Gmail connector's create_draft). Never call send, reply or forward. If you have no Gmail draft tool, finish the run as error with a note saying so.",
    `4. Record it: outreach_to_gmail { outreach_id: "${c.outreachId}", gmail_draft_id: "<the id your tool returned>", confidence: <0 to 1, how sure you are the draft matches> }.`,
    `5. Finish: runs_finish { run_id: "${c.runId}", status: "ok", summary: { outreach_id: "${c.outreachId}", gmail_draft_id } } (status "error" with a note if any step failed).`,
    ...(section ? ['', section] : []),
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
  /**
   * The Gmail draft step (`runs.start` with `outreach_id`). Claude: no `--strict-mcp-config` (the claude.ai
   * Gmail connector must load), only its create_draft tool allowed next to pp, sending tools denied, no Chrome.
   * Codex and Cursor use whatever Gmail MCP server the user configured for them.
   */
  gmailDraft?: boolean;
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
          ...(opts.gmailDraft
            ? ['--allowedTools', `mcp__${MCP_SERVER_NAME},${GMAIL_DRAFT_TOOL}`, '--disallowedTools', GMAIL_DENIED_TOOLS.join(',')]
            : ['--strict-mcp-config', '--allowedTools', `mcp__${MCP_SERVER_NAME}`]),
          '--permission-prompts',
          'none',
          '--output-format',
          'json',
          // LinkedIn people reads go through Claude in Chrome (wave1-decisions #4); the Gmail step reads no LinkedIn.
          ...(opts.skill === 'connect' && !opts.gmailDraft ? ['--chrome'] : []),
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
