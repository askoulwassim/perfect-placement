/*
 * Tool generation. Every MCP tool is derived from the ops registry (`OPS` in
 * @perfect-placement/contracts): name, description, impact flags and JSON Schema
 * (`opInputJsonSchema`). Nothing here is hand-written per op, and nothing here
 * decides anything: the outcome of a call is whatever `runOp` returns.
 */

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { OP_NAMES, OPS, type OpDef, type OpName, type OpOutcome, opInputJsonSchema } from '@perfect-placement/contracts';

/**
 * `dotted` keeps the op name as the tool name (`roles.list`), which is valid per the
 * MCP spec and what the lane brief asks for. `underscore` (`roles_list`) is for clients
 * whose model API rejects dots in tool names and that do not normalize them.
 */
export type ToolNameStyle = 'dotted' | 'underscore';

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

export function toolNameFor(op: OpName, style: ToolNameStyle = 'dotted'): string {
  return style === 'dotted' ? op : op.replaceAll('.', '_');
}

/** Tool name -> op name, built from the registry. Throws if a style would collide. */
export function toolNameMap(style: ToolNameStyle = 'dotted'): Map<string, OpName> {
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

/** The JSON Schema MCP clients see: `opInputJsonSchema` minus the `$schema` key some clients reject. */
export function toolInputSchema(op: OpName): Tool['inputSchema'] {
  const { $schema: _ignored, ...schema } = opInputJsonSchema(op);
  if (schema.type !== 'object') throw new Error(`op ${op} input is not an object schema`);
  return schema as Tool['inputSchema'];
}

export function buildTool(op: OpName, style: ToolNameStyle = 'dotted'): Tool {
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
export function buildTools(style: ToolNameStyle = 'dotted'): Tool[] {
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
