/*
 * The Perfect Placement MCP server. A thin adapter: tools and resources map 1:1 onto
 * `runOp(name, input, ctx)` (the engine's, see `openEngine`). Validation, policy, decisions
 * and writes all happen inside runOp. The actor is always `agent`: an MCP client is never a
 * human. The optional `confidence` tool argument becomes `ctx.confidence` (backend `agent`).
 * A headless run's server is started with PP_RUN_ID (#50): every op it runs carries `ctx.runId`, so its
 * events and run logs are linked to that run. An Ask session's server (PP_ASK=1, #39) queues the skill
 * runs it starts (`runs.start` defaults to `queue: true`) and marks the answers it saves as from Ask
 * (`apply.fill` defaults to `source: "ask"`, #81).
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { OpContext, OpName, RunOp } from '@perfect-placement/contracts';
import { buildTools, CONFIDENCE_ARG, DEFAULT_TOOL_NAME_STYLE, outcomeToToolResult, type ToolNameStyle, toolNameMap } from './tools.js';

export const SERVER_NAME = 'perfect-placement';
export const SERVER_VERSION = '0.1.0';

export interface PpMcpServerOptions {
  /** The single ops entry point: `openEngine().runOp` (tests may inject a fake). */
  runOp: RunOp;
  /** Injected clock (deterministic tests). */
  now?: () => Date;
  /** Default `underscore` (`roles_list`); see `ToolNameStyle`. */
  toolNames?: ToolNameStyle;
  /** The skill run this server works for (PP_RUN_ID from the headless runner): set as `ctx.runId` on every op. */
  runId?: string;
  /**
   * An Ask session's server (PP_ASK=1, #39): the chat agent delegates skill work, so `runs.start` defaults to
   * `queue: true` (a queued headless run) instead of making the chat session the run; `apply.fill` defaults
   * to `source: "ask"` (#81: the answer shows as Saved from Ask and merges into the role's Answers).
   */
  ask?: boolean;
}

const INSTRUCTIONS = [
  'Perfect Placement job-search system. Every tool is one op from the ops registry; the tool name is the op name with dots as underscores (roles.list is roles_list).',
  'Writing tools take an optional confidence (0 to 1): medium-impact calls go through the policy grid with it, and without it they wait for a human.',
  'A result of requires_human means the call was queued for a human in the Needs-you queue: do not retry it.',
  'This server never submits applications and never sends email.',
].join(' ');

export function createPpMcpServer(options: PpMcpServerOptions): McpServer {
  const { runOp } = options;
  const now = options.now ?? (() => new Date());
  const style = options.toolNames ?? DEFAULT_TOOL_NAME_STYLE;
  const ctx = (confidence?: number): OpContext => ({
    actor: 'agent',
    now,
    ...(options.runId ? { runId: options.runId } : {}),
    ...(confidence === undefined ? {} : { confidence: { p: confidence, backend: 'agent' } }),
  });

  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: { listChanged: false }, resources: { listChanged: false } }, instructions: INSTRUCTIONS },
  );

  // ---------------------------------------------------------------- tools
  const tools = buildTools(style);
  const byName = toolNameMap(style);
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const op = byName.get(req.params.name);
    if (!op) throw new McpError(ErrorCode.InvalidParams, `unknown tool: ${req.params.name}`);
    const { [CONFIDENCE_ARG]: confidence, ...args } = (req.params.arguments ?? {}) as Record<string, unknown>;
    // Ask (#39, #81): skill runs it starts are queued; answers it saves with apply.fill are marked `source: ask`.
    const input =
      options.ask && op === 'runs.start' && args.queue === undefined
        ? { ...args, queue: true }
        : options.ask && op === 'apply.fill' && args.source === undefined
          ? { ...args, source: 'ask' }
          : args;
    if (confidence !== undefined && (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1)))
      return outcomeToToolResult(op, { status: 'error', code: 'invalid_input', message: `${CONFIDENCE_ARG} must be a number from 0 to 1` });
    try {
      return outcomeToToolResult(op, await runOp(op, input, ctx(confidence as number | undefined)));
    } catch (err) {
      return outcomeToToolResult(op, { status: 'error', code: 'internal', message: err instanceof Error ? err.message : String(err) });
    }
  });

  // ------------------------------------------------------------ resources
  /** Run a read-only op for a resource; anything but ok becomes an MCP error. */
  const read = async <T>(op: OpName, input: unknown): Promise<T> => {
    const out = await runOp(op, input, ctx());
    if (out.status === 'ok') return out.output as T;
    if (out.status === 'error' && out.code === 'not_found') throw new McpError(ErrorCode.InvalidParams, out.message);
    throw new McpError(ErrorCode.InternalError, out.status === 'error' ? `${out.code}: ${out.message}` : `${op} requires a human`);
  };
  const json = (uri: URL, data: unknown): ReadResourceResult => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data) }],
  });
  const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));

  interface RoleListOut {
    items: Array<{ role: { id: string; title: string }; company: { id: string; name: string } }>;
  }
  interface RoleGetOut {
    contacts: unknown[];
  }

  mcp.registerResource(
    'profile',
    'pp://profile',
    {
      title: 'Profile card',
      description: 'Current profile version, components and pending diffs (profile.get).',
      mimeType: 'application/json',
    },
    async (uri) => json(uri, await read('profile.get', {})),
  );

  mcp.registerResource(
    'needs-you',
    'pp://needs-you',
    { title: 'Needs you', description: 'Pending decisions queued for a human (decisions.queue).', mimeType: 'application/json' },
    async (uri) => json(uri, await read('decisions.queue', { status: ['pending'] })),
  );

  mcp.registerResource(
    'role',
    new ResourceTemplate('pp://roles/{role_id}', {
      list: async () => {
        const out = await read<RoleListOut>('roles.list', { limit: 100 });
        return {
          resources: out.items.map((it) => ({
            uri: `pp://roles/${encodeURIComponent(it.role.id)}`,
            name: it.role.id,
            title: `${it.company.name}: ${it.role.title}`,
            mimeType: 'application/json',
          })),
        };
      },
    }),
    {
      title: 'Role',
      description: 'One role with company, latest score, application and people (roles.get).',
      mimeType: 'application/json',
    },
    async (uri, v) => json(uri, await read('roles.get', { role_id: decodeURIComponent(one(v.role_id)) })),
  );

  mcp.registerResource(
    'role-contacts',
    new ResourceTemplate('pp://roles/{role_id}/contacts', { list: undefined }),
    { title: 'Contacts for a role', description: 'People linked to a role (roles.get contacts).', mimeType: 'application/json' },
    async (uri, v) => {
      const out = await read<RoleGetOut>('roles.get', { role_id: decodeURIComponent(one(v.role_id)) });
      return json(uri, { contacts: out.contacts });
    },
  );

  mcp.registerResource(
    'company',
    new ResourceTemplate('pp://companies/{company_id}', { list: undefined }),
    { title: 'Company', description: 'A company, its dossier and its roles (companies.get).', mimeType: 'application/json' },
    async (uri, v) => json(uri, await read('companies.get', { company_id: decodeURIComponent(one(v.company_id)) })),
  );

  return mcp;
}
