import { OP_NAMES, OPS, opInputJsonSchema } from '@perfect-placement/contracts';
import { describe, expect, it } from 'vitest';
import { buildTools, CONFIDENCE_ARG, META_KEY, outcomeToToolResult, toolNameFor, toolNameMap } from './tools.js';

const opOf = (tool: { title?: string }) => tool.title as (typeof OP_NAMES)[number];

describe('generated tools', () => {
  it('has exactly one tool per op, in registry order', () => {
    const tools = buildTools();
    expect(tools.map(opOf)).toEqual(OP_NAMES);
    expect(tools.map((t) => t.name)).toEqual(OP_NAMES.map((op) => toolNameFor(op)));
  });

  it('defaults to underscore names that every client accepts (Claude Code, Codex, Cursor: [a-zA-Z0-9_-])', () => {
    const tools = buildTools();
    expect(tools.find((t) => t.title === 'roles.list')?.name).toBe('roles_list');
    expect(tools.find((t) => t.title === 'companies.dossier.write')?.name).toBe('companies_dossier_write');
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      // Cursor caps server + tool name at 60 characters; the documented server key is `pp`.
      expect(`pp${t.name}`.length).toBeLessThanOrEqual(60);
      expect((t._meta as Record<string, { op: string }>)[META_KEY]?.op).toBe(t.title);
    }
    expect(buildTools('dotted').map((t) => t.name)).toEqual(OP_NAMES);
  });

  it('uses opInputJsonSchema for every input schema (minus $schema), plus confidence on writing ops', () => {
    for (const tool of buildTools()) {
      const op = opOf(tool);
      const { $schema: _s, ...expected } = opInputJsonSchema(op);
      const { [CONFIDENCE_ARG]: confidence, ...props } = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
      expect({ ...tool.inputSchema, properties: props }).toEqual({ ...expected, properties: expected.properties ?? {} });
      expect(tool.inputSchema.type).toBe('object');
      if (OPS[op].readOnly === true) expect(confidence).toBeUndefined();
      else expect(confidence).toMatchObject({ type: 'number', minimum: 0, maximum: 1 });
    }
  });

  it('derives descriptions and annotations from op flags', () => {
    for (const tool of buildTools()) {
      const def = OPS[opOf(tool)];
      expect(tool.description?.startsWith(def.description)).toBe(true);
      expect(tool.annotations?.readOnlyHint).toBe('readOnly' in def && def.readOnly === true);
      expect((tool._meta?.[META_KEY] as { impact: string } | undefined)?.impact).toBe(def.impact);
    }
    const submit = buildTools().find((t) => t.name === 'apply_mark_submitted');
    expect(submit?.description).toMatch(/requires_human/);
    expect(submit?.annotations?.destructiveHint).toBe(true);
  });

  it('underscore style maps back to ops without collisions', () => {
    const map = toolNameMap('underscore');
    expect(map.size).toBe(OP_NAMES.length);
    expect(map.get('companies_dossier_write')).toBe('companies.dossier.write');
    for (const name of map.keys()) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it('renders all three outcomes', () => {
    expect(outcomeToToolResult('roles.list', { status: 'ok', output: { a: 1 }, eventIds: [] }).isError).toBeUndefined();
    const human = outcomeToToolResult('apply.mark_submitted', { status: 'requires_human', decisionId: 'dc_1' });
    expect(human.structuredContent).toEqual({ status: 'requires_human', decisionId: 'dc_1' });
    expect(human.isError).toBeUndefined();
    const bad = outcomeToToolResult('roles.get', { status: 'error', code: 'not_found', message: 'nope' });
    expect(bad.isError).toBe(true);
  });
});
