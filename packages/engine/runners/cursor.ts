import type { AskChatEvent, Skill } from '@perfect-placement/contracts';
import { claudeGrants, claudeToolsPhrase } from './claude.js';
import { CLAUDE_TEXT } from './claude-tools.js';
import { SKILL_GRANTS } from './grants.js';
import { isObj, type Obj, str } from './json.js';
import { MCP_SERVER_NAME } from './mcp-server.js';
import type { AskContext, AskLineParser, AskSpec, RunContext, RunnerBinding, RunnerSpec } from './types.js';

/* Cursor: `cursor-agent -p`, flags checked against the Cursor CLI parameters and permissions docs. */

/**
 * cursor-agent project permissions (`.cursor/cli.json`): the pp MCP tools, `WebFetch(*)` for web skills,
 * no shell and no file writes (deny wins over `--force`). Cursor documents no web search permission.
 */
export function cursorPermissions(skill: Skill): { allow: string[]; deny: string[] } {
  return {
    allow: [`Mcp(${MCP_SERVER_NAME}:*)`, ...(SKILL_GRANTS[skill].web.length ? ['WebFetch(*)'] : [])],
    deny: ['Shell(*)', 'Write(**)'],
  };
}

function run(opts: RunContext): RunnerSpec {
  const { prompt, runId, extra, env, server } = opts;
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

/**
 * Cursor reads the same names as Claude today: its run has the pp tools and WebFetch, and no Gmail or browser of its
 * own (#161 brings it the PP browser adapter).
 */
export const cursorAgent: RunnerBinding = {
  command: 'cursor-agent',
  grants: claudeGrants,
  text: CLAUDE_TEXT,
  toolsPhrase: claudeToolsPhrase,
  run,
  ask,
  askParser,
};
