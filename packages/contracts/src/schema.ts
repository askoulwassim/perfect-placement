import { z } from 'zod';
import { OPS, type OpName } from './ops/registry.js';

/** JSON Schema for an op's input (draft 2020-12). Lane C generates MCP tools from this. */
export function opInputJsonSchema(name: OpName): Record<string, unknown> {
  return z.toJSONSchema(OPS[name].input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
}

export function opOutputJsonSchema(name: OpName): Record<string, unknown> {
  return z.toJSONSchema(OPS[name].output, { io: 'output', unrepresentable: 'any' }) as Record<string, unknown>;
}
