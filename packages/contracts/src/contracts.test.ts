import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_REASONS,
  BACKENDS,
  COMPONENT_DATA_SCHEMAS,
  COMPONENT_DIFF_IMPACT,
  CRITERIA,
  CRITERION_OWNER,
  DEFAULT_CONFIG,
  DecisionAction,
  DREAM_AFFINITY,
  EVENT_TYPES,
  FORBIDDEN_BUTTON_LABELS,
  GENUI_PROPS,
  HARD_HUMAN,
  IMPACTS,
  isHardHuman,
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
  RESCORE_MOVABLE,
  RESCORE_REVIVABLE_ARCHIVE,
  RubricSnapshot,
  thresholdsFor,
  tokens,
} from './index.js';
import { nextFire, parseSchedule, prevFire, SCHEDULE_SKILL, scheduleForSkill, scheduleMissed } from './schedules.js';

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
  'scout.watchlist_scan': 'low',
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
  'decisions.undo_group': 'low',
  'runs.list': 'low',
  'runs.get': 'low',
  'system.doctor': 'low',
  // Wave 2 additions
  'profile.undo_diff': 'low',
  'profile.learn': 'low',
  'onboard.start': 'low',
  'onboard.state': 'low',
  'onboard.samples': 'low',
  'companies.get': 'low',
  'contacts.get': 'low',
  'outreach.get': 'low',
  'outreach.list': 'low',
  'runs.finish': 'low',
  'vault.read': 'low',
  'system.backends': 'low',
  // #38
  'onboard.extract': 'low',
  // #22
  'onboard.propose_questions': 'low',
  // #42, #54
  'profile.set_defaults': 'low',
  // #124
  'profile.set_identity': 'low',
  'apply.resolve_claim': 'low',
  // #37
  'people.find_email': 'low',
  // #78
  'people.fallback': 'low',
  'apply.skip_connect': 'low',
  // #81
  'apply.set_questions': 'low',
  // #98
  'people.set_path': 'low',
  // #99
  'people.email_checked': 'low',
};

/** Wave 2 read ops. */
const WAVE2_READ_ONLY = [
  'onboard.state',
  'onboard.samples',
  'companies.get',
  'contacts.get',
  'outreach.get',
  'outreach.list',
  'vault.read',
  'system.backends',
] as const;

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

  it('every primary action points at a registered op and no label is forbidden', () => {
    for (const actions of Object.values(PRIMARY_ACTIONS))
      for (const a of actions) {
        if (a.op) expect(OP_NAMES).toContain(a.op);
        expect(FORBIDDEN_BUTTON_LABELS as readonly string[]).not.toContain(a.label);
      }
    expect(PRIMARY_ACTIONS.people[0]?.label).toBe('Draft for <first name>');
    expect(PRIMARY_ACTIONS['needs-you'].some((a) => a.label === 'Back to Now' && a.op === null)).toBe(true);
  });

  it('wave 2 read ops are read-only; slot-freeing ops can emit role_promoted', () => {
    for (const name of WAVE2_READ_ONLY) expect(OPS[name].readOnly, name).toBe(true);
    for (const name of ['apply.tailor', 'apply.mark_submitted', 'inbox.ingest', 'roles.check_freshness'] as const)
      expect(OPS[name].emits, name).toContain('role_promoted');
    expect(OPS['runs.finish'].emits).toEqual(['run_finished']);
    expect(OPS['system.backends'].owner).toBe('I');
  });

  it('new output fields default so older handlers still parse', () => {
    expect(OPS['roles.add'].output.parse({ added: [], duplicates: [] }).possible_duplicates).toEqual([]);
    expect(OPS['roles.add'].output.parse({ added: [], duplicates: [] })).toMatchObject({ skipped: [], resolved: [], by_source: {} });
    expect(OPS['scout.watchlist_scan'].readOnly).toBe(true);
    // #28: an older config.json without the new scout fields still parses, with the defaults.
    const { target_new_roles, max_queries, ...oldScout } = DEFAULT_CONFIG.scout;
    expect(PolicyConfig.parse({ ...DEFAULT_CONFIG, scout: oldScout }).scout).toEqual({
      watchlist_share_max: 0.34,
      target_new_roles: 25,
      max_queries: 30,
    });
    expect([target_new_roles, max_queries]).toEqual([25, 30]);
    expect(OPS['roles.check_freshness'].output.parse({ results: [] }).skipped).toEqual([]);
    expect(OPS['outreach.get'].input.safeParse({ outreach_id: 'or_1' }).success).toBe(true);
    expect(OPS['runs.start'].input.parse({ skill: 'connect', contact_id: 'ct_1' }).contact_id).toBe('ct_1');
  });

  it('Gmail via agent: to_gmail records an agent-made draft id; runs.start scopes a connect run to one outreach', () => {
    expect(OPS['outreach.to_gmail'].input.parse({ outreach_id: 'or_1', gmail_draft_id: 'r-1' }).gmail_draft_id).toBe('r-1');
    expect(OPS['outreach.to_gmail'].input.safeParse({ outreach_id: 'or_1', gmail_draft_id: '' }).success).toBe(false);
    expect(OPS['outreach.to_gmail'].impact).toBe('medium');
    expect(OPS['runs.start'].input.parse({ skill: 'connect', outreach_id: 'or_1' }).outreach_id).toBe('or_1');
    expect(PRIMARY_ACTIONS['outreach-draft']).toEqual([{ label: 'Create Gmail draft', op: 'runs.start' }]);
  });

  it('run queue (#30): runs.dispatch is low impact; runs.start takes triggered_by; the pipeline is on by default', () => {
    expect(OPS['runs.dispatch']).toMatchObject({ impact: 'low', emits: [] });
    expect(OPS['runs.start'].input.parse({ skill: 'score', triggered_by: 'rn_1' }).triggered_by).toBe('rn_1');
    expect(
      OPS['runs.start'].output.safeParse({
        run: {
          id: 'rn_1',
          op: 'scout',
          started_at: '2026-10-08T00:00:00.000Z',
          finished_at: null,
          status: 'queued',
          summary_json: {},
          log_path: null,
        },
        deduped: true,
      }).success,
    ).toBe(true);
    expect(DEFAULT_CONFIG.runs.max_concurrent).toBe(2);
    expect(DEFAULT_CONFIG.pipeline).toEqual({ score_after_scout: true, research_after_score: true });
  });
});

describe('policy', () => {
  it('grid is the wave1-decisions #24 grid', () => {
    for (const impact of IMPACTS) expect(Object.keys(POLICY_GRID[impact])).toHaveLength(3);
    expect(POLICY_GRID).toEqual({
      low: { confident: 'auto', middle: 'auto', low: 'auto_undo' },
      medium: { confident: 'auto', middle: 'auto_second', low: 'human' },
      high: { confident: 'auto_undo', middle: 'human', low: 'human' },
    });
  });

  it.each([
    [{ kind: 'apply.submit' }, true],
    [{ op: 'outreach.send' }, true],
    [{ op: 'roles.delete' }, true],
    [{ op: 'vault.remove' }, true],
    [{ op: 'profile.apply_diff', component: 'dealbreakers' }, true],
    [{ kind: 'profile.apply_diff', component: 'terms', changedKeys: ['comp_floor'] }, true],
    [{ kind: 'profile.apply_diff', component: 'terms', changedKeys: ['equity'] }, false],
    [{ kind: 'profile.apply_diff', component: 'domain', changedKeys: ['ranked'] }, false],
    [{ kind: 'freshness.closed', op: 'roles.archive' }, false],
    [{ kind: 'outreach.to_gmail', op: 'outreach.to_gmail' }, false],
  ] as const)('hard exclusions: %o -> %s', (subject, expected) => {
    expect(isHardHuman(subject)).toBe(expected);
  });

  it('hard exclusions cover the five locked actions', () => {
    expect(HARD_HUMAN.kinds).toContain('apply.submit');
    expect(HARD_HUMAN.ops).toContain('outreach.send');
    expect(HARD_HUMAN.components).toContain('dealbreakers');
    expect(HARD_HUMAN.termsKeys).toContain('comp_floor');
  });

  it('default config parses and overrides merge', () => {
    expect(PolicyConfig.parse(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
    expect(thresholdsFor(DEFAULT_CONFIG, 'freshness.closed').auto).toBe(0.92);
    expect(thresholdsFor(DEFAULT_CONFIG, 'inbox.classify').auto).toBe(0.9);
  });

  it('a config.json with a backend block from an older build still loads (unknown blocks are dropped)', () => {
    const older = {
      ...DEFAULT_CONFIG,
      backends: { ...DEFAULT_CONFIG.backends, hosted: { baseUrl: '', keyEnv: 'HOSTED_KEY', enabled: false } },
    };
    expect(PolicyConfig.parse(older)).toEqual(DEFAULT_CONFIG);
  });

  it('defaults: Kev only, agent fallback, claude runner, LinkedIn live via Claude in Chrome', () => {
    expect(DEFAULT_CONFIG.backends.default).toBe('kev');
    expect(DEFAULT_CONFIG.backends.fallback).toBe('agent');
    expect(DEFAULT_CONFIG.backends.llm).toBeUndefined();
    expect(BACKENDS).toContain('agent');
    expect(DEFAULT_CONFIG.runner.command).toBe('claude');
    expect(DEFAULT_CONFIG.linkedin).toMatchObject({
      mode: 'live',
      driver: 'claude-in-chrome',
      max_pages_per_run: 6,
      max_mutual_expansions: 3,
    });
    const off = PolicyConfig.parse({ ...DEFAULT_CONFIG, schedules: { ...DEFAULT_CONFIG.schedules, inbox: 'off' } });
    expect(off.schedules.inbox).toBe('off');
    expect(() => PolicyConfig.parse({ ...DEFAULT_CONFIG, runner: { command: 'bash' } })).toThrow();
  });
});

describe('decision actions', () => {
  it('parse when + undo', () => {
    const a = DecisionAction.parse({
      op: 'roles.archive',
      input: { role_id: 'r', reason: 'closed' },
      when: false,
      undo: { op: 'roles.move', input: { role_id: 'r', to: 'active' } },
    });
    expect(a.when).toBe(false);
    expect(a.undo?.op).toBe('roles.move');
    expect(() => DecisionAction.parse({ input: {} })).toThrow();
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

  it('11 profile components, each with a kind and a data schema', () => {
    expect(PROFILE_COMPONENT_KEYS).toHaveLength(11);
    for (const k of PROFILE_COMPONENT_KEYS) {
      expect(PROFILE_COMPONENT_KIND[k]).toBeDefined();
      expect(COMPONENT_DATA_SCHEMAS[k].safeParse({ extra: 1 }).success, k).toBe(true);
    }
    expect(COMPONENT_DATA_SCHEMAS.terms.safeParse({ comp_floor: 'high' }).success).toBe(false);
  });

  it('criterion owners: c2, c3, c9 craft; every owner is a weighted component or terms', () => {
    expect(CRITERION_OWNER.c2).toBe('craft');
    expect(CRITERION_OWNER.c3).toBe('craft');
    expect(CRITERION_OWNER.c9).toBe('craft');
    for (const c of CRITERIA) {
      const owner = CRITERION_OWNER[c];
      expect(PROFILE_COMPONENT_KIND[owner] === 'weighted' || owner === 'terms', c).toBe(true);
    }
  });

  it('diff impact by kind, dream affinity, rescore sets', () => {
    expect(COMPONENT_DIFF_IMPACT).toEqual({ filter: 'high', weighted: 'medium', asset: 'medium' });
    expect(DREAM_AFFINITY).toBe(3);
    expect(DREAM_AFFINITY).toBeLessThanOrEqual(DEFAULT_CONFIG.scoring.affinity_cap);
    expect(RESCORE_MOVABLE).not.toContain('on-deck');
    expect(RESCORE_REVIVABLE_ARCHIVE).toEqual(['below_threshold', 'dealbreaker']);
    expect(ARCHIVE_REASONS).toContain('duplicate');
  });

  it('rubric snapshot defaults to the v1 scale and requires weights summing to 100', () => {
    const base = {
      version: 'x',
      weights: { c1: 15, c2: 15, c3: 12, c4: 12, c5: 10, c6: 12, c7: 8, c8: 8, c9: 8 },
      bands: { green_min: 75, yellow_min: 55 },
      affinity_cap: 5,
      company_active_cap: 3,
      profile_version_id: null,
      weights_source: 'default',
    };
    expect(RubricSnapshot.parse(base).scale).toBe('v1');
    expect(RubricSnapshot.safeParse({ ...base, weights: { ...base.weights, c1: 30 } }).success).toBe(false);
  });

  it('genui card props are id-only', () => {
    expect(Object.keys(GENUI_PROPS)).toEqual(['RoleCard', 'ScoreRadar', 'ContactCard', 'ProfileDiff']);
    expect(Object.keys(GENUI_PROPS.ContactCard.shape)).toEqual(['contactId', 'roleId']);
  });
});

describe('tokens', () => {
  it('match the design handoff palette', () => {
    expect(tokens.color.bg).toBe('#06111F');
    expect(tokens.color.emerald).toBe('#2FD39B');
    expect(tokens.color['emerald-hover']).toBe('#5BE3B3');
    expect(tokens.layout.mobileBreakpoint).toBe(720);
    expect(tokens.tint.rail).toBe('rgba(9,26,45,0.6)');
    expect(tokens.shadow.ask).toBe('0 20px 60px rgba(0,0,0,0.45)');
  });
});

describe('schedules (#29)', () => {
  it('parses daily, weekdays, one day and day lists; off and junk are null', () => {
    expect(parseSchedule('daily 07:30')).toEqual({ days: [0, 1, 2, 3, 4, 5, 6], hour: 7, minute: 30, daily: true });
    expect(parseSchedule('weekdays 8:05')).toMatchObject({ days: [1, 2, 3, 4, 5], hour: 8, minute: 5, daily: false });
    expect(parseSchedule('FRI 05:30')).toMatchObject({ days: [5], daily: false });
    expect(parseSchedule('thu,mon 09:00')).toMatchObject({ days: [1, 4] });
    for (const bad of ['off', 'daily', 'daily 25:00', 'friday 05:30', 'fri 5:3', '']) expect(parseSchedule(bad)).toBeNull();
  });

  it('next and previous local fire times; missed = fired since the last run started', () => {
    const thu = new Date(2026, 9, 8, 12, 0); // Thursday, local
    expect(nextFire('daily 07:30', thu)).toEqual(new Date(2026, 9, 9, 7, 30));
    expect(nextFire('daily 18:00', thu)).toEqual(new Date(2026, 9, 8, 18, 0));
    expect(nextFire('fri 05:30', thu)).toEqual(new Date(2026, 9, 9, 5, 30));
    expect(nextFire('thu 12:00', thu)).toEqual(new Date(2026, 9, 15, 12, 0));
    expect(nextFire('weekdays 08:00', new Date(2026, 9, 9, 9, 0))).toEqual(new Date(2026, 9, 12, 8, 0));
    expect(nextFire('off', thu)).toBeNull();
    expect(prevFire('fri 05:30', thu)).toEqual(new Date(2026, 9, 2, 5, 30));
    expect(prevFire('daily 07:30', thu)).toEqual(new Date(2026, 9, 8, 7, 30));
    const iso = (d: Date) => d.toISOString();
    expect(scheduleMissed('daily 07:30', iso(new Date(2026, 9, 7, 7, 30)), thu)).toBe(true);
    expect(scheduleMissed('daily 07:30', iso(new Date(2026, 9, 8, 7, 30, 4)), thu)).toBe(false);
    expect(scheduleMissed('fri 05:30', iso(new Date(2026, 9, 2, 5, 31)), thu)).toBe(false);
    expect(scheduleMissed('daily 07:30', null, thu)).toBe(false);
    expect(scheduleMissed('off', iso(new Date(2020, 0, 1)), thu)).toBe(false);
  });

  it('scout_score enqueues scout; runs.start takes a schedule; schedules.status is a read', () => {
    expect(SCHEDULE_SKILL).toEqual({ inbox: 'inbox', freshness: 'freshness', scout_score: 'scout' });
    expect(scheduleForSkill('scout')).toBe('scout_score');
    expect(scheduleForSkill('tailor')).toBeNull();
    expect(OPS['runs.start'].input.parse({ skill: 'scout', schedule: 'scout_score' }).schedule).toBe('scout_score');
    expect(OPS['runs.start'].input.safeParse({ skill: 'scout', schedule: 'weekly' }).success).toBe(false);
    expect(OPS['schedules.status']).toMatchObject({ readOnly: true, impact: 'low', emits: [] });
  });
});
