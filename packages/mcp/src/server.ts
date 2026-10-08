/*
 * The Perfect Placement MCP server. A thin adapter: tools and resources map 1:1 onto
 * `runOp(name, input, ctx)` (lane B). Validation, policy, decisions and writes all
 * happen inside runOp. The actor is always `agent`: an MCP client is never a human.
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
import { buildTools, outcomeToToolResult, type ToolNameStyle, toolNameMap } from './tools.js';

export const SERVER_NAME = 'perfect-placement';
export const SERVER_VERSION = '0.1.0';

export interface PpMcpServerOptions {
  /** The single ops entry point. Wave 2 injects lane B's; tests inject the fixtures fake. */
  runOp: RunOp;
  /** Injected clock (deterministic tests). */
  now?: () => Date;
  toolNames?: ToolNameStyle;
}

const INSTRUCTIONS = [
  'Perfect Placement job-search system. Every tool is one op from the ops registry.',
  'A result of requires_human means the call was queued for a human in the Needs-you queue: do not retry it.',
  'This server never submits applications and never sends email.',
].join(' ');

export function createPpMcpServer(options: PpMcpServerOptions): McpServer {
  const { runOp } = options;
  const now = options.now ?? (() => new Date());
  const style = options.toolNames ?? 'dotted';
  const ctx = (): OpContext => ({ actor: 'agent', now });

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
    try {
      return outcomeToToolResult(op, await runOp(op, req.params.arguments ?? {}, ctx()));
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

  // Shim until a `companies.get` op exists (CONTRACT_CHANGES.md, Lane C requests).
  mcp.registerResource(
    'company',
    new ResourceTemplate('pp://companies/{company_id}', { list: undefined }),
    { title: 'Company', description: 'A company and its roles (roles.list by company_id).', mimeType: 'application/json' },
    async (uri, v) => {
      const company_id = decodeURIComponent(one(v.company_id));
      const out = await read<RoleListOut>('roles.list', { company_id, limit: 500 });
      const first = out.items[0];
      if (!first) throw new McpError(ErrorCode.InvalidParams, `no company with roles: ${company_id}`);
      return json(uri, { company: first.company, roles: out.items });
    },
  );

  return mcp;
}
