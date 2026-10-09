import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** How a launched runner ended (only while the launching process is still alive to see it). */
export interface RunnerExit {
  code: number | null;
  /** The runner's stdout + stderr (Claude Code: the `--output-format json` result). */
  output: string;
  /** Where the output was written, if anywhere. */
  logFile?: string;
}

export interface RunnerLauncher {
  /**
   * Start the runner and resolve once it is running (reject if it cannot start). Never waits for it to
   * finish; `exit` (optional) settles when it does, so `runs.start` can fail a run the runner left open.
   */
  launch(spec: RunnerSpec): Promise<{ pid?: number; exit?: Promise<RunnerExit> }>;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The repo root (the directory holding `skills/` and `pnpm-workspace.yaml`), found by walking up from
 * `from`: works from packages/engine/ops (source) and packages/engine/dist/ops (build).
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

const REPO_ROOT = resolveRepoRoot();

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

export interface PromptContext {
  runId: string;
  skill: Skill;
  roleId?: string;
  contactId?: string;
}

/** Built-in web tools a skill may be granted (Claude Code names; see `SKILL_TOOLS`). */
export type WebTool = 'WebSearch' | 'WebFetch';

/**
 * The single per-skill tool allowlist for headless runs (#20). Every run gets the pp MCP tools; web
 * tools only where the SKILL.md needs them. Nothing else (no Bash, no Write/Edit, no file reads):
 * every read and write goes through ops. `connect` keeps its own Chrome / Gmail handling.
 */
export const SKILL_TOOLS: Readonly<Record<Skill, { web: readonly WebTool[]; why: string }>> = {
  scout: { web: ['WebSearch', 'WebFetch'], why: 'runs the plan.md queries on job boards and career pages, reads each posting' },
  research: { web: ['WebSearch', 'WebFetch'], why: 'builds a sourced, dated company dossier from the web' },
  freshness: { web: ['WebSearch', 'WebFetch'], why: 'judges unsure postings from the live page when asked' },
  tailor: { web: ['WebFetch'], why: 'captures the full JD from the posting when only a title is on file' },
  score: { web: ['WebFetch'], why: 'captures the full JD from the posting when only a title is on file' },
  fill: { web: ['WebFetch'], why: 'reads the real portal questions (a headless run has no browser)' },
  inbox: { web: [], why: 'Gmail read-only plus ops' },
  learn: { web: [], why: 'ops only' },
  onboard: { web: [], why: 'ops only' },
  connect: { web: [], why: 'LinkedIn via Claude in Chrome (--chrome); Gmail draft step via the Gmail connector' },
};

/** Claude Code tool names a skill's headless run pre-approves. */
export function skillAllowedTools(skill: Skill): string[] {
  return [`mcp__${MCP_SERVER_NAME}`, ...SKILL_TOOLS[skill].web];
}

/**
 * Companion files that ship next to a skill's SKILL.md in the repo and are inlined into its prompt.
 * Skill files live in the repo, never the vault: a headless run must not look for them with vault.read.
 * (`connect/RUNBOOK.md` is a human runbook for a supervised live run; it is not inlined.)
 */
export const SKILL_ASSETS: Readonly<Partial<Record<Skill, readonly string[]>>> = {
  scout: ['plan.md'],
};

function readAsset(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : `(not found at ${file})`;
}

/**
 * The prompt: the run ids, the tools this run has, the skill's SKILL.md and its companion files
 * (read from the repo by absolute path), and the closing instruction.
 */
export function skillPrompt(skillsDir: string, c: PromptContext): string {
  const file = join(skillsDir, c.skill, 'SKILL.md');
  const skill = existsSync(file) ? readFileSync(file, 'utf8').trim() : `# ${c.skill}\n\n(SKILL.md not found at ${file})`;
  const ids = [`run_id: ${c.runId}`, ...(c.roleId ? [`role_id: ${c.roleId}`] : []), ...(c.contactId ? [`contact_id: ${c.contactId}`] : [])];
  const web = SKILL_TOOLS[c.skill].web;
  const assets = (SKILL_ASSETS[c.skill] ?? []).map((name) => {
    const abs = join(skillsDir, c.skill, name);
    return `## ${name} (skill file, ${abs})\n\n${readAsset(abs)}`;
  });
  return [
    `You are running the Perfect Placement "${c.skill}" skill headless. Every read and write goes through the ${MCP_SERVER_NAME} MCP tools; never edit files or the database directly. Never submit an application or send an email.`,
    '',
    ids.join('\n'),
    '',
    `The run already exists (runs.start was called for you). Pass run_id in your work and finish with runs.finish { run_id: "${c.runId}", status }.`,
    '',
    `Tools: the ${MCP_SERVER_NAME} MCP tools${web.length ? ` and ${web.join(', ')}` : ''}, nothing else. The skill's files (SKILL.md${assets.length ? `, ${(SKILL_ASSETS[c.skill] ?? []).join(', ')}` : ''}) are below; they live in the repo, not the vault, so never look for them with vault.read.`,
    `If a tool you need is denied or missing, do not work around it: finish with runs.finish { run_id: "${c.runId}", status: "error", summary: { error: "tool denied: <tool>", denied_tools: ["<tool>"] }, note: "<what you could not do>" }.`,
    '',
    skill,
    ...(assets.length ? ['', ...assets] : []),
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

/**
 * cursor-agent project permissions (`.cursor/cli.json`): the pp MCP tools, `WebFetch(*)` for web skills,
 * no shell and no file writes (deny wins over `--force`). Cursor documents no web search permission.
 */
export function cursorPermissions(skill: Skill): { allow: string[]; deny: string[] } {
  return {
    allow: [`Mcp(${MCP_SERVER_NAME}:*)`, ...(SKILL_TOOLS[skill].web.length ? ['WebFetch(*)'] : [])],
    deny: ['Shell(*)', 'Write(**)'],
  };
}

/** Tools Claude Code denied in a headless run, from its `--output-format json` result (`permission_denials`). */
export function deniedTools(output: string): string[] {
  const names = new Set<string>();
  for (const m of output.matchAll(/"permission_denials"\s*:\s*(\[[^\]]*\])/g)) {
    try {
      for (const d of JSON.parse(m[1] as string) as Array<{ tool_name?: unknown }>)
        if (typeof d.tool_name === 'string') names.add(d.tool_name);
    } catch {
      // not JSON after all: ignore
    }
  }
  return [...names];
}

/** The error a run gets when its runner denied tools: which ones, and how to fix it. */
export function deniedToolsError(skill: Skill, tools: readonly string[]): string {
  const granted = new Set(skillAllowedTools(skill));
  const isGranted = (t: string) => granted.has(t) || t.startsWith(`mcp__${MCP_SERVER_NAME}__`);
  const blocked = tools.filter(isGranted);
  const extra = tools.filter((t) => !isGranted(t));
  const fixes = [
    ...(blocked.length
      ? [
          `${blocked.join(', ')} ${blocked.length > 1 ? 'are' : 'is'} pre-approved for ${skill} (--allowedTools ${skillAllowedTools(skill).join(',')}) but was denied anyway: remove the deny rule from your Claude Code settings (permissions.deny in ~/.claude/settings.json or managed settings).`,
        ]
      : []),
    ...(extra.length
      ? [
          `${extra.join(', ')} ${extra.length > 1 ? 'are' : 'is'} not granted to ${skill}: if the skill truly needs it, add it to SKILL_TOOLS in packages/engine/ops/runner.ts (or to config.runner.args: ["--allowedTools", "${extra.join(',')}"]).`,
        ]
      : []),
  ];
  return `tool denied: ${tools.join(', ')} (headless ${skill} run, nobody can approve a prompt). Fix: ${fixes.join(' ')}`;
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
  // #50: the pp MCP server gets PP_RUN_ID too, so every op the run performs carries ctx.runId.
  const env = { ...mcp.env, PP_RUN_ID: runId };
  const server = { command: mcp.command, args: mcp.args, env };
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
            : opts.skill === 'connect'
              ? ['--strict-mcp-config', '--allowedTools', `mcp__${MCP_SERVER_NAME}`]
              : [
                  '--strict-mcp-config',
                  // Built-ins narrowed to the skill's web tools (no Bash, Write, Edit or Read), then pre-approved;
                  // dontAsk denies anything else instead of falling back to the user's permission mode.
                  '--tools',
                  SKILL_TOOLS[opts.skill].web.join(','),
                  '--allowedTools',
                  skillAllowedTools(opts.skill).join(','),
                  '--permission-mode',
                  'dontAsk',
                ]),
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
      const envPairs = Object.entries(env).flatMap(([k, v]) => ['-c', `mcp_servers.${MCP_SERVER_NAME}.env.${k}=${toml(v)}`]);
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
          // Web search per skill (SKILL_TOOLS): live retrieval for web skills, the tool removed otherwise.
          '-c',
          `web_search=${toml(SKILL_TOOLS[opts.skill].web.length ? 'live' : 'disabled')}`,
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
        args: ['-p', prompt, '--output-format', 'text', '--trust', '--approve-mcps', '--force', ...extra],
        // cursor-agent reads MCP servers from the project's .cursor/mcp.json and permissions from
        // .cursor/cli.json: a fresh temp dir per run.
        cwd: null,
        env,
        files: [
          { path: '.cursor/mcp.json', content: `${JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: server } }, null, 2)}\n` },
          { path: '.cursor/cli.json', content: `${JSON.stringify({ permissions: cursorPermissions(opts.skill) }, null, 2)}\n` },
        ],
      };
  }
}

/** Where the spawn launcher keeps runner output and pid files (OS temp dir, never the vault). */
export const runnerDir = (base: string = tmpdir()) => join(base, 'pp-runs');

/** `process.kill(pid, 0)`: true if the process exists (EPERM = exists, owned by someone else). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Is the runner for `runId` still alive? Reads the pid file the spawn launcher wrote; no file (never
 * launched here, temp dir cleared by a reboot) = gone. The runner is detached, so it can outlive `pp up`.
 */
export function runnerAlive(runId: string, base: string = tmpdir()): boolean {
  try {
    const pid = Number.parseInt(readFileSync(join(runnerDir(base), `${runId}.pid`), 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 && pidAlive(pid);
  } catch {
    return false;
  }
}

/**
 * Spawns the runner detached; output goes to a log file in the OS temp dir (never the vault), next to
 * a `<runId>.pid` file (removed on exit) so a restarted `pp up` can tell a live runner from a dead one.
 * `exit` settles with the log when the runner ends, as long as this process is still alive.
 */
export function createSpawnLauncher(): RunnerLauncher {
  return {
    launch(spec) {
      const cwd = spec.cwd ?? mkdtempSync(join(tmpdir(), `pp-run-${spec.runId}-`));
      for (const f of spec.files) {
        const abs = join(cwd, f.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, f.content);
      }
      const logDir = runnerDir();
      const pidFile = join(logDir, `${spec.runId}.pid`);
      mkdirSync(logDir, { recursive: true });
      const logFile = join(logDir, `${spec.runId}.log`);
      const log = openSync(logFile, 'a');
      return new Promise((ok, fail) => {
        const child = spawn(spec.command, spec.args, {
          cwd,
          env: { ...process.env, ...spec.env },
          detached: true,
          stdio: ['ignore', log, log],
        });
        const exit = new Promise<RunnerExit>((done) => {
          child.once('exit', (code) => {
            rmSync(pidFile, { force: true });
            let output = '';
            try {
              output = readFileSync(logFile, 'utf8');
            } catch {
              // log gone: report the exit code only
            }
            done({ code, output, logFile });
          });
        });
        child.once('error', (e) => {
          closeSync(log);
          fail(e);
        });
        child.once('spawn', () => {
          closeSync(log);
          if (child.pid !== undefined) writeFileSync(pidFile, String(child.pid));
          child.unref();
          ok(child.pid === undefined ? { exit } : { pid: child.pid, exit });
        });
      });
    },
  };
}
