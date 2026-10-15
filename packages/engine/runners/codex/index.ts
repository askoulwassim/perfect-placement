import { join } from 'node:path';
import type { AskChatEvent, Skill } from '@perfect-placement/contracts';
import { GMAIL_DRAFT_TOOL, GMAIL_GET_DRAFT_TOOL, GMAIL_UPDATE_TOOL, SKILL_TOOLS, usesChrome } from '../grants.js';
import { isObj, type Obj, str } from '../json.js';
import { MCP_SERVER_NAME, REPO_ROOT } from '../mcp-server.js';
import type { AskContext, AskLineParser, AskSpec, RunContext, RunnerBinding, RunnerSpec } from '../types.js';
import { codexBrowserEnvironment } from './browser-env.js';
import { codexBrowserRuntime } from './browser-runtime.js';
import { codexBrowserArgs, codexConnectorPrompt } from './connectors.js';

/* Codex: `codex exec`, flags checked against the Codex config reference. */

/** Translate the shared skills' Claude web tool names to Codex's built-in web actions. */
function codexWebPrompt(prompt: string, skill: Skill): string {
  const web = SKILL_TOOLS[skill].web;
  if (!web.length) return prompt;
  return [
    'Codex web tools: use the built-in web tool (web.run) for the web actions below. Its open action fetches a URL; click and find read linked pages and page content. These are actions of one tool, not separate tools to discover.',
    web.includes('WebSearch')
      ? 'Web search queries and page retrieval are allowed for this skill.'
      : 'Only page retrieval is allowed for this skill; do not run web search queries.',
    'If the built-in web tool is actually unavailable or a call is denied, follow the missing-tool rule. Do not use shell commands, file tools or another connector as a fallback.',
    '',
    prompt.replace(/\bWebSearch\b/g, 'web.run search').replace(/\bWebFetch\b/g, 'web.run open'),
  ].join('\n');
}

function run(opts: RunContext): RunnerSpec {
  const { prompt, home, runId, extra, env } = opts;
  const mcp = opts.server;
  const toml = (v: unknown) => JSON.stringify(v).replaceAll('\u007f', '\\u007f');
  const envPairs = Object.entries(env).flatMap(([k, v]) => ['-c', `mcp_servers.${MCP_SERVER_NAME}.env.${k}=${toml(v)}`]);
  const browser = usesChrome(opts.skill, opts.linkedin !== false) && !opts.gmailDraft && !opts.gmailTo;
  const browserEnv = { ...process.env, ...env };
  const assist = opts.skill === 'fill' && opts.assist === true;
  const gmail = opts.gmailTo
    ? [GMAIL_GET_DRAFT_TOOL, GMAIL_UPDATE_TOOL]
    : opts.gmailDraft
      ? [GMAIL_DRAFT_TOOL]
      : SKILL_TOOLS[opts.skill].gmail;
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
      // Match the pp MCP grant in skillAllowedTools. `never` alone rejects writes that
      // need approval. This default is scoped to pp; explicit per-tool overrides still win,
      // and runOp still applies PP's policy grid and human-only restrictions.
      '-c',
      `mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode="approve"`,
      // Headless: nobody can approve tools outside the run's grants.
      '-c',
      'approval_policy="never"',
      // Web search per skill (SKILL_TOOLS): live retrieval for web skills, the tool removed otherwise.
      '-c',
      `web_search=${toml(SKILL_TOOLS[opts.skill].web.length ? 'live' : 'disabled')}`,
      ...(browser
        ? codexBrowserArgs({
            nodePath: mcp.command,
            adapterBin: join(REPO_ROOT, 'packages/mcp/dist/browser-bin.js'),
            runtimeDir: codexBrowserRuntime({ repoRoot: REPO_ROOT, env: browserEnv }).dir,
            env: browserEnv,
            assist,
            filesDir: opts.filesDir,
          })
        : []),
      ...extra,
      codexWebPrompt(
        codexConnectorPrompt(prompt, {
          runId,
          browser,
          assist,
          uploads: assist && Boolean(opts.filesDir),
          gmail,
          web: SKILL_TOOLS[opts.skill].web,
        }),
        opts.skill,
      ),
    ],
    cwd: home,
    env,
    files: [],
  };
}

function ask(opts: AskContext): AskSpec {
  const { extra, env, home } = opts;
  const mcp = opts.server;
  const toml = (v: unknown) => JSON.stringify(v);
  return {
    command: 'codex',
    args: [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-c',
      `mcp_servers.${MCP_SERVER_NAME}.command=${toml(mcp.command)}`,
      '-c',
      `mcp_servers.${MCP_SERVER_NAME}.args=${toml(mcp.args)}`,
      ...Object.entries(env).flatMap(([k, v]) => ['-c', `mcp_servers.${MCP_SERVER_NAME}.env.${k}=${toml(v)}`]),
      '-c',
      'approval_policy="never"',
      // No file writes and no network from shell commands; MCP tools and web search still work.
      '-c',
      'sandbox_mode="read-only"',
      '-c',
      'web_search="live"',
      ...extra,
      opts.replay,
    ],
    cwd: home,
    env,
    files: [],
  };
}

/** Codex `exec --json`: thread, item and turn events. */
function askParser(): AskLineParser {
  return (j: Obj, s): AskChatEvent[] => {
    switch (j.type) {
      case 'thread.started':
        s.sessionId = str(j.thread_id) ?? s.sessionId;
        return [];
      case 'item.started':
      case 'item.completed': {
        const item = isObj(j.item) ? j.item : {};
        const id = str(item.id) ?? '';
        if (item.type === 'agent_message' && j.type === 'item.completed') {
          const text = str(item.text) ?? '';
          return s.text(s.reply ? `\n${text}` : text);
        }
        if (item.type === 'mcp_tool_call') {
          const name = item.server === MCP_SERVER_NAME ? `${MCP_SERVER_NAME}-${str(item.tool) ?? ''}` : (str(item.tool) ?? 'tool');
          const start = s.tool(id, name);
          if (j.type === 'item.started') return start;
          const res = isObj(item.result) ? item.result : {};
          return [...start, ...s.result(id, item.status !== 'failed' && !item.error && res.is_error !== true, item.result)];
        }
        if (item.type === 'web_search' && j.type === 'item.completed')
          return [...s.tool(id, 'web_search'), { type: 'tool_result', id, ok: true }];
        return [];
      }
      case 'turn.completed':
        s.finish();
        return [];
      case 'turn.failed':
        s.finish((isObj(j.error) ? str(j.error.message) : undefined) ?? 'turn failed');
        return [];
      case 'error':
        s.fail(str(j.message) ?? 'error');
        return [];
      default:
        return [];
    }
  };
}

export const codex: RunnerBinding = {
  command: 'codex',
  run,
  ask,
  askParser,
  // A scheduled job keeps the browser's runtime cache and Chrome profile locations (#157).
  jobEnv: (env) => codexBrowserEnvironment(env),
};
