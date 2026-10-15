import { join } from 'node:path';
import type { AskChatEvent, Skill } from '@perfect-placement/contracts';
import { adapterBindings, adapterGrants } from './browser/bindings.js';
import { browserEnvironment } from './browser/env.js';
import { ADAPTER_TOOL, BROWSER_SERVER, type BrowserRunPolicy, browserPolicy, skillSites } from './browser/policy.js';
import { browserRuntime } from './browser/runtime.js';
import { CLAUDE_TOOL } from './claude-tools.js';
import { CODEX_TEXT, CODEX_TOOL } from './codex/text.js';
import { type Capability, SKILL_GRANTS, usesBrowser } from './grants.js';
import { isObj, type Obj, str } from './json.js';
import { MCP_SERVER_NAME, REPO_ROOT } from './mcp-server.js';
import { type PromptText, renderText } from './text.js';
import type { AskContext, AskLineParser, AskSpec, PreambleContext, RunContext, RunnerBinding, RunnerSpec } from './types.js';

/*
 * Cursor: `cursor-agent -p`, flags checked against the Cursor CLI parameters and permissions docs. Its web tool is
 * WebFetch; its browser is PP's adapter (`pp_browser`, #161) in the run's `.cursor/mcp.json`; Gmail is whatever Gmail
 * MCP server the user configured, named by capability.
 */

/** Cursor's tool (or Gmail capability label) for each capability: Claude's web names, the adapter's browser tools. */
export const CURSOR_TOOL: Readonly<Record<Capability, string>> = {
  ...CODEX_TOOL,
  'web.search': CLAUDE_TOOL['web.search'],
  'web.fetch': CLAUDE_TOOL['web.fetch'],
  ...ADAPTER_TOOL,
};

/** Cursor's text: the adapter runners' fragments (setup required, no connector retry) in Cursor's names. */
export const CURSOR_TEXT: PromptText = {
  ...CODEX_TEXT,
  ...(Object.fromEntries(
    (Object.keys(CURSOR_TOOL) as Capability[]).flatMap((c) => [
      [c, CURSOR_TOOL[c]],
      [`tool:${c}`, CURSOR_TOOL[c]],
    ]),
  ) as Record<Capability | `tool:${Capability}`, string>),
};

/** The prompt's Tools line in Cursor's names: web tools, browser tools, then Gmail capabilities. */
export function cursorToolsPhrase(caps: readonly Capability[]): string {
  const web = caps.filter((c) => c.startsWith('web.')).map((c) => CURSOR_TOOL[c]);
  const browser = [...new Set(caps.filter((c) => c.startsWith('browser.')).map((c) => CURSOR_TOOL[c]))];
  const gmail = caps.filter((c) => c.startsWith('gmail.')).map((c) => CURSOR_TOOL[c]);
  return `${web.length ? ` and ${web.join(', ')}` : ''}${browser.length ? ` and the ${BROWSER_SERVER} tools ${browser.join(', ')}` : ''}${gmail.length ? ` and connected Gmail capabilities (${gmail.join(', ')})` : ''}`;
}

/** What Cursor reads before the skill: its Gmail and browser bindings for this run. */
export function cursorPreamble(p: PreambleContext): string[] {
  return adapterBindings(p, {
    heading: '## Cursor tool bindings',
    browserTool: (c) => CURSOR_TOOL[c],
    gmailLabel: (c) => CURSOR_TOOL[c],
    setup: 'pp setup --runner cursor-agent',
    missing: renderText('{{connector.missing}}', CURSOR_TEXT, { runId: p.runId }),
  });
}

/**
 * cursor-agent project permissions (`.cursor/cli.json`): the pp MCP tools, `WebFetch(*)` for web skills, the
 * browser policy's tools on `pp_browser` (#161), no shell and no file writes (deny wins over `--force`). Cursor
 * documents no web search permission.
 */
export function cursorPermissions(skill: Skill, policy?: BrowserRunPolicy): { allow: string[]; deny: string[] } {
  return {
    allow: [
      `Mcp(${MCP_SERVER_NAME}:*)`,
      ...(SKILL_GRANTS[skill].web.length ? ['WebFetch(*)'] : []),
      ...(policy?.tools ?? []).map((tool) => `Mcp(${BROWSER_SERVER}:${tool})`),
    ],
    deny: ['Shell(*)', 'Write(**)'],
  };
}

function run(opts: RunContext): RunnerSpec {
  const { prompt, runId, extra, env, server } = opts;
  // #161: browser skills get PP's adapter with the run's policy, as Codex's do.
  const browser = usesBrowser(opts.skill, opts.linkedin !== false) && !opts.gmailDraft && !opts.gmailTo;
  const browserEnv = { ...process.env, ...env };
  const policy = browser
    ? browserPolicy({
        caps: adapterGrants({
          skill: opts.skill,
          linkedin: opts.linkedin !== false,
          assist: opts.assist === true,
          uploadsReady: Boolean(opts.filesDir),
        }),
        ...(opts.filesDir ? { filesDir: opts.filesDir } : {}),
        sites: opts.sites ?? skillSites(opts.skill),
      })
    : undefined;
  const servers = {
    [MCP_SERVER_NAME]: server,
    ...(policy
      ? {
          [BROWSER_SERVER]: {
            command: server.command,
            args: [
              join(REPO_ROOT, 'packages/mcp/dist/browser-bin.js'),
              '--runtime-dir',
              browserRuntime({ repoRoot: REPO_ROOT, env: browserEnv }).dir,
              '--policy',
              JSON.stringify(policy),
            ],
            // The runtime cache and Chrome profile locations, as Codex's adapter gets them.
            env: browserEnvironment(browserEnv),
          },
        }
      : {}),
  };
  return {
    runId,
    command: 'cursor-agent',
    args: ['-p', prompt, '--output-format', 'text', '--trust', '--approve-mcps', '--force', ...extra],
    // cursor-agent reads MCP servers from the project's .cursor/mcp.json and permissions from
    // .cursor/cli.json: a fresh temp dir per run.
    cwd: null,
    env,
    files: [
      { path: '.cursor/mcp.json', content: `${JSON.stringify({ mcpServers: servers }, null, 2)}\n` },
      { path: '.cursor/cli.json', content: `${JSON.stringify({ permissions: cursorPermissions(opts.skill, policy) }, null, 2)}\n` },
    ],
  };
}

function ask(opts: AskContext): AskSpec {
  const { extra, env, server } = opts;
  return {
    command: 'cursor-agent',
    args: ['-p', opts.replay, '--output-format', 'stream-json', '--trust', '--approve-mcps', '--force', ...extra],
    cwd: null,
    env,
    files: [
      { path: '.cursor/mcp.json', content: `${JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: server } }, null, 2)}\n` },
      {
        path: '.cursor/cli.json',
        content: `${JSON.stringify({ permissions: { allow: [`Mcp(${MCP_SERVER_NAME}:*)`, 'WebFetch(*)'], deny: ['Shell(*)', 'Write(**)'] } }, null, 2)}\n`,
      },
    ],
  };
}

/** Cursor `stream-json`: assistant text, tool calls started and completed, the result. */
function askParser(): AskLineParser {
  return (j: Obj, s): AskChatEvent[] => {
    const sid = str(j.session_id);
    if (sid) s.sessionId = sid;
    switch (j.type) {
      case 'assistant': {
        const content = isObj(j.message) && Array.isArray(j.message.content) ? (j.message.content as unknown[]) : [];
        return content.flatMap((b) => (isObj(b) && b.type === 'text' ? s.text(str(b.text) ?? '') : []));
      }
      case 'tool_call': {
        const id = str(j.call_id) ?? '';
        const call = isObj(j.tool_call) ? j.tool_call : {};
        const [kind, body] = Object.entries(call)[0] ?? ['tool', {}];
        const args = isObj(body) && isObj(body.args) ? body.args : {};
        const name = str(args.toolName) ?? str(args.name) ?? kind;
        if (j.subtype === 'started') return s.tool(id, name);
        if (j.subtype === 'completed') {
          const result = isObj(body) ? body.result : undefined;
          const failed = isObj(result) && ('error' in result || 'failure' in result);
          return [...s.tool(id, name), ...s.result(id, !failed, result)];
        }
        return [];
      }
      case 'result':
        s.finish(j.is_error === true || (typeof j.subtype === 'string' && j.subtype !== 'success') ? (str(j.result) ?? '') : undefined);
        return [];
      default:
        return [];
    }
  };
}

export const cursorAgent: RunnerBinding = {
  command: 'cursor-agent',
  grants: adapterGrants,
  text: CURSOR_TEXT,
  toolsPhrase: cursorToolsPhrase,
  preamble: cursorPreamble,
  run,
  ask,
  askParser,
  // A scheduled job keeps the browser's runtime cache and Chrome profile locations (#157).
  jobEnv: (env) => browserEnvironment(env),
};
