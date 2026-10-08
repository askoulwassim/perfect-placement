import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  EVENT_TYPES,
  IMPACTS,
  MANUAL_MOVES,
  OP_NAMES,
  OPS,
  opInputJsonSchema,
  opOutputJsonSchema,
  POLICY_GRID,
  PolicyConfig,
  PRIMARY_ACTIONS,
  PROFILE_COMPONENT_KEYS,
  PROFILE_COMPONENT_KIND,
  Question,
  thresholdsFor,
  tokens,
} from './index.js';

/** The ops table in docs/v2/contracts.md. Every one must be in the registry. */
const CONTRACT_TABLE: Record<string, 'low' | 'medium' | 'high'> = {
  'profile.get': 'low',
  'profile.history': 'low',
  'profile.propose_diff': 'low',
  'profile.apply_diff': 'high',
  'onboard.ingest_resume': 'low',
  'onboard.answer': 'low',
  'onboard.calibrate': 'low',
  'onboard.confirm': 'low',
  'roles.add': 'low',
  'roles.score': 'low',
  'roles.move': 'medium',
  'roles.archive': 'medium',
  'roles.check_freshness': 'medium',
  'roles.get': 'low',
  'roles.list': 'low',
  'pipeline.summary': 'low',
  'companies.dossier.write': 'low',
  'apply.tailor': 'low',
  'apply.fill': 'low',
  'apply.mark_submitted': 'high',
  'people.find': 'low',
  'people.link': 'low',
  'people.classify': 'low',
  'outreach.draft': 'low',
  'outreach.to_gmail': 'medium',
  'outreach.send': 'high',
  'inbox.ingest': 'medium',
  'decisions.queue': 'low',
  'decisions.resolve': 'low',
  'decisions.undo': 'low',
  'runs.list': 'low',
  'runs.get': 'low',
  'system.doctor': 'low',
};

describe('ops registry', () => {
  it('contains every op from contracts.md with its impact tier', () => {
    for (const [name, impact] of Object.entries(CONTRACT_TABLE)) {
      const op = OPS[name as keyof typeof OPS];
      expect(op, name).toBeDefined();
      expect(op.impact, name).toBe(impact);
    }
  });

  it('keys match op names and impacts are valid', () => {
    for (const name of OP_NAMES) {
      expect(OPS[name].name).toBe(name);
      expect(IMPACTS).toContain(OPS[name].impact);
    }
  });

  it('only emits known events', () => {
    for (const name of OP_NAMES) for (const e of OPS[name].emits) expect(EVENT_TYPES).toContain(e);
  });

  it('read-only ops emit nothing', () => {
    for (const name of OP_NAMES) if (OPS[name].readOnly) expect(OPS[name].emits).toHaveLength(0);
  });

  it('external or irreversible actions are human-only', () => {
    expect(OPS['apply.mark_submitted'].humanOnly).toBe(true);
    expect(OPS['outreach.send'].humanOnly).toBe(true);
    expect(OPS['outreach.send'].unimplemented).toBe(true);
  });

  it('every op input and output converts to JSON Schema (MCP)', () => {
    for (const name of OP_NAMES) {
      expect(opInputJsonSchema(name).type, name).toBe('object');
      expect(opOutputJsonSchema(name)).toBeTypeOf('object');
    }
  });

  it('every primary action points at a registered op', () => {
    for (const actions of Object.values(PRIMARY_ACTIONS)) for (const a of actions) if (a.op) expect(OP_NAMES).toContain(a.op);
  });
});

describe('policy', () => {
  it('grid covers every impact and band; high is always human', () => {
    for (const impact of IMPACTS) expect(Object.keys(POLICY_GRID[impact])).toHaveLength(3);
    expect(Object.values(POLICY_GRID.high).every((o) => o === 'human')).toBe(true);
    expect(POLICY_GRID.low.confident).toBe('auto');
    expect(POLICY_GRID.low.middle).toBe('auto_second');
    expect(POLICY_GRID.medium.confident).toBe('auto_undo');
  });

  it('default config parses and overrides merge', () => {
    expect(PolicyConfig.parse(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
    expect(thresholdsFor(DEFAULT_CONFIG, 'freshness.closed').auto).toBe(0.92);
    expect(thresholdsFor(DEFAULT_CONFIG, 'inbox.classify').auto).toBe(0.9);
  });
});

describe('resolver types', () => {
  it('choice questions must offer other', () => {
    expect(() => Question.parse({ id: 'q', type: 'choice', instructions: 'x', options: ['a', 'b'] })).toThrow();
    expect(Question.parse({ id: 'q', type: 'choice', instructions: 'x', options: ['a', 'other'] }).type).toBe('choice');
  });
});

describe('statuses + profile', () => {
  it('held is never a manual drop target', () => {
    expect(MANUAL_MOVES.some(([, to]) => to === 'held')).toBe(false);
    expect(MANUAL_MOVES.some(([f, t]) => f === 'draft-ready' && t === 'applied')).toBe(false);
  });

  it('11 profile components, each with a kind', () => {
    expect(PROFILE_COMPONENT_KEYS).toHaveLength(11);
    for (const k of PROFILE_COMPONENT_KEYS) expect(PROFILE_COMPONENT_KIND[k]).toBeDefined();
  });
});

describe('tokens', () => {
  it('match the design handoff palette', () => {
    expect(tokens.color.bg).toBe('#06111F');
    expect(tokens.color.emerald).toBe('#2FD39B');
    expect(tokens.color['emerald-hover']).toBe('#5BE3B3');
  });
});
