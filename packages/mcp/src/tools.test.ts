import { OP_NAMES, OPS, opInputJsonSchema } from '@perfect-placement/contracts';
import { describe, expect, it } from 'vitest';
import { buildTools, META_KEY, outcomeToToolResult, toolNameMap } from './tools.js';

describe('generated tools', () => {
  it('has exactly one tool per op, in registry order', () => {
    const tools = buildTools();
    expect(tools.map((t) => t.name)).toEqual(OP_NAMES);
  });

  it('uses opInputJsonSchema for every input schema (minus $schema)', () => {
    for (const tool of buildTools()) {
      const { $schema: _s, ...expected } = opInputJsonSchema(tool.name as (typeof OP_NAMES)[number]);
      expect(tool.inputSchema).toEqual(expected);
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('derives descriptions and annotations from op flags', () => {
    for (const tool of buildTools()) {
      const def = OPS[tool.name as keyof typeof OPS];
      expect(tool.description?.startsWith(def.description)).toBe(true);
      expect(tool.annotations?.readOnlyHint).toBe('readOnly' in def && def.readOnly === true);
      expect((tool._meta?.[META_KEY] as { impact: string } | undefined)?.impact).toBe(def.impact);
    }
    const submit = buildTools().find((t) => t.name === 'apply.mark_submitted');
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
