/*
 * Tool generation. Every MCP tool is derived from the ops registry (`OPS` in
 * @perfect-placement/contracts): name, description, impact flags and JSON Schema
 * (`opInputJsonSchema`). Nothing here is hand-written per op, and nothing here
 * decides anything: the outcome of a call is whatever `runOp` returns.
 */

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { OP_NAMES, OPS, type OpDef, type OpName, type OpOutcome, opInputJsonSchema } from '@perfect-placement/contracts';

/**
 * `underscore` (default) exposes `roles.list` as `roles_list`. Dots are valid per the MCP
 * spec, but the model APIs behind Claude Code, Codex and Cursor only accept
 * `[a-zA-Z0-9_-]`: Claude Code and Codex rewrite dots to `_` and Cursor warns that dotted
 * names will be filtered. Underscore names are what every client shows the model anyway,
 * so they are the default. `dotted` keeps the raw op name (spec-valid, opt-in). Op names
 * stay dotted everywhere else (registry, runOp, `title`, `_meta`).
 */
export type ToolNameStyle = 'dotted' | 'underscore';
export const DEFAULT_TOOL_NAME_STYLE: ToolNameStyle = 'underscore';

/** Optional argument on every writing tool: the agent's confidence, mapped to `ctx.confidence` (wave1-decisions #17). */
export const CONFIDENCE_ARG = 'confidence';
const CONFIDENCE_SCHEMA = {
  type: 'number',
  minimum: 0,
  maximum: 1,
  description:
    'Your confidence (0 to 1) that this call is right. Medium-impact calls go through the policy grid with it; omit it and the call waits for a human.',
} as const;

export const META_KEY = 'perfect-placement/op';

export interface OpToolMeta {
  op: OpName;
  impact: OpDef['impact'];
  dynamicImpact: boolean;
  humanOnly: boolean;
  unimplemented: boolean;
  readOnly: boolean;
  emits: readonly string[];
  owner: OpDef['owner'];
}

export function toolNameFor(op: OpName, style: ToolNameStyle = DEFAULT_TOOL_NAME_STYLE): string {
  return style === 'dotted' ? op : op.replaceAll('.', '_');
}

/** Tool name -> op name, built from the registry. Throws if a style would collide. */
export function toolNameMap(style: ToolNameStyle = DEFAULT_TOOL_NAME_STYLE): Map<string, OpName> {
  const map = new Map<string, OpName>();
  for (const op of OP_NAMES) {
    const name = toolNameFor(op, style);
    if (map.has(name)) throw new Error(`tool name collision: ${name} (${map.get(name)} and ${op})`);
    map.set(name, op);
  }
  return map;
}

/** One-line policy notes appended to the op description, derived from its flags. */
export function policyNotes(def: OpDef): string[] {
  const notes: string[] = [];
  if (def.readOnly) notes.push('Read only.');
  notes.push(`Impact: ${def.impact}${def.dynamicImpact ? ' at most; the actual tier depends on the input' : ''}.`);
  if (def.unimplemented) notes.push('Not implemented in v2.');
  if (def.humanOnly) notes.push('Human only: an agent call queues a decision and returns requires_human with its id.');
  else if (def.impact === 'high') notes.push('High impact calls go to a human: the result is requires_human with the queued decision id.');
  return notes;
}

export function toolMeta(op: OpName): OpToolMeta {
  const def: OpDef = OPS[op];
  return {
    op,
    impact: def.impact,
    dynamicImpact: def.dynamicImpact === true,
    humanOnly: def.humanOnly === true,
    unimplemented: def.unimplemented === true,
    readOnly: def.readOnly === true,
    emits: def.emits,
    owner: def.owner,
  };
}

/**
 * The JSON Schema MCP clients see: `opInputJsonSchema` minus the `$schema` key some clients
 * reject, plus the optional `confidence` argument on ops that write.
 */
export function toolInputSchema(op: OpName): Tool['inputSchema'] {
  const { $schema: _ignored, ...schema } = opInputJsonSchema(op);
  if (schema.type !== 'object') throw new Error(`op ${op} input is not an object schema`);
  if (OPS[op].readOnly === true) return schema as Tool['inputSchema'];
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  if (CONFIDENCE_ARG in properties) throw new Error(`op ${op} already has a ${CONFIDENCE_ARG} input`);
  return { ...schema, properties: { ...properties, [CONFIDENCE_ARG]: CONFIDENCE_SCHEMA } } as unknown as Tool['inputSchema'];
}

export function buildTool(op: OpName, style: ToolNameStyle = DEFAULT_TOOL_NAME_STYLE): Tool {
  const def: OpDef = OPS[op];
  return {
    name: toolNameFor(op, style),
    title: op,
    description: [def.description, ...policyNotes(def)].join(' '),
    inputSchema: toolInputSchema(op),
    annotations: {
      title: op,
      readOnlyHint: def.readOnly === true,
      destructiveHint: def.readOnly !== true && def.impact === 'high',
      idempotentHint: def.readOnly === true,
    },
    _meta: { [META_KEY]: toolMeta(op) },
  };
}

/** One tool per op, in registry order. */
export function buildTools(style: ToolNameStyle = DEFAULT_TOOL_NAME_STYLE): Tool[] {
  return OP_NAMES.map((op) => buildTool(op, style));
}

/** Render an `OpOutcome` as an MCP tool result. All three variants are passed through unchanged in `structuredContent`. */
export function outcomeToToolResult(op: OpName, outcome: OpOutcome<unknown>): CallToolResult {
  switch (outcome.status) {
    case 'ok':
      return {
        content: [{ type: 'text', text: JSON.stringify(outcome.output) }],
        structuredContent: { status: 'ok', output: outcome.output as unknown, eventIds: outcome.eventIds },
      };
    case 'requires_human':
      return {
        content: [
          {
            type: 'text',
            text: `requires_human: ${op} was queued for a human in the Needs-you queue. Decision id: ${outcome.decisionId}. Do not retry; check decisions.queue.`,
          },
        ],
        structuredContent: { status: 'requires_human', decisionId: outcome.decisionId },
      };
    case 'error':
      return {
        isError: true,
        content: [{ type: 'text', text: `${outcome.code}: ${outcome.message}` }],
        structuredContent: {
          status: 'error',
          code: outcome.code,
          message: outcome.message,
          ...(outcome.issues === undefined ? {} : { issues: outcome.issues }),
        },
      };
  }
}
