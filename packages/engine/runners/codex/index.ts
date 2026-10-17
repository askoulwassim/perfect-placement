import { join } from 'node:path';
import type { AskChatEvent } from '@perfect-placement/contracts';
import { browserEnvironment } from '../browser/env.js';
import { browserPolicy, skillSites } from '../browser/policy.js';
import { browserRuntime } from '../browser/runtime.js';
import { SKILL_GRANTS, usesBrowser } from '../grants.js';
import { isObj, type Obj, str } from '../json.js';
import { MCP_SERVER_NAME, REPO_ROOT } from '../mcp-server.js';
import type { AskContext, AskLineParser, AskSpec, RunContext, RunnerBinding, RunnerSpec } from '../types.js';
import { codexBrowserArgs } from './connectors.js';
import { codexGmailTools } from './gmail.js';
import { codexSafeArgs } from './isolation.js';
import { CODEX_TEXT, codexGrants, codexPreamble, codexToolsPhrase } from './text.js';

/*
 * Codex: `codex exec`, flags checked against the Codex config reference. The prompt arrives in Codex's names
 * (skillPrompt with runner `codex`, #159); the command line adds the pp server and, for browser skills, pp_browser.
 */

function run(opts: RunContext): RunnerSpec {
  const { prompt, runId, extra, env } = opts;
  const mcp = opts.server;
  const toml = (v: unknown) => JSON.stringify(v).replaceAll('\u007f', '\\u007f');
  const envPairs = Object.entries(env).flatMap(([k, v]) => ['-c', `mcp_servers.${MCP_SERVER_NAME}.env.${k}=${toml(v)}`]);
  const browser = usesBrowser(opts.skill, opts.linkedin !== false) && !opts.gmailDraft && !opts.gmailTo;
  const browserEnv = { ...process.env, ...env };
  // #161: one policy for the adapter and for Codex's enabled tools, from the grants the prompt was built with.
  const policy = browserPolicy({
    caps: codexGrants({
      skill: opts.skill,
      linkedin: opts.linkedin !== false,
      assist: opts.assist === true,
      uploadsReady: Boolean(opts.filesDir),
    }),
    ...(opts.filesDir ? { filesDir: opts.filesDir } : {}),
    sites: opts.sites ?? skillSites(opts.skill),
  });
  return {
    runId,
    codexIsolation: {
      gmailTools: codexGmailTools({ skill: opts.skill, mode: opts.gmailTo ? 'gmail_to' : opts.gmailDraft ? 'gmail_draft' : 'skill' }),
      servers: ['pp', ...(browser ? ['pp_browser'] : [])],
    },
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
      // Match the pp MCP grant every run has. `never` alone rejects writes that
      // need approval. This default is scoped to pp; explicit per-tool overrides still win,
      // and runOp still applies PP's policy grid and human-only restrictions.
      '-c',
      `mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode="approve"`,
      // Headless: nobody can approve tools outside the run's grants.
      '-c',
      'approval_policy="never"',
      // Web per skill (SKILL_GRANTS): live retrieval for web skills, the tool removed otherwise.
      '-c',
      `web_search=${toml(SKILL_GRANTS[opts.skill].web.length ? 'live' : 'disabled')}`,
      ...(browser
        ? codexBrowserArgs({
            nodePath: mcp.command,
            adapterBin: join(REPO_ROOT, 'packages/mcp/dist/browser-bin.js'),
            runtimeDir: browserRuntime({ repoRoot: REPO_ROOT, env: browserEnv }).dir,
            env: browserEnv,
            policy,
          })
        : []),
      ...codexSafeArgs(extra),
      prompt,
    ],
    cwd: null,
    env,
    files: [],
  };
}

function ask(opts: AskContext): AskSpec {
  const { extra, env } = opts;
  const mcp = opts.server;
  const toml = (v: unknown) => JSON.stringify(v);
  return {
    codexIsolation: { gmailTools: [], servers: ['pp'] },
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
      ...codexSafeArgs(extra),
      opts.replay,
    ],
    cwd: null,
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
  grants: codexGrants,
  text: CODEX_TEXT,
  toolsPhrase: codexToolsPhrase,
  preamble: codexPreamble,
  run,
  ask,
  askParser,
  // A scheduled job keeps the browser's runtime cache and Chrome profile locations (#157).
  jobEnv: (env) => browserEnvironment(env),
};
