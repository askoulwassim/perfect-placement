import {
  type Answer,
  type AskRequest,
  type Backend,
  DEFAULT_CONFIG,
  type DecisionBackend,
  type PolicyConfig,
} from '@perfect-placement/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentBackend } from './backends/agent.js';
import { createRuleBackend } from './backends/rule.js';
import { backendsFromConfig } from './config.js';
import { BackendUnavailableError } from './errors.js';
import { type BackendMap, createResolver } from './resolver.js';
import type { DecisionStore } from './store.js';
import { createSqliteDecisionStore, fakeRunOp, tempDb } from './test-helpers.js';

const NOW = new Date('2026-10-08T12:00:00.000Z');

/** A stub backend answering every question with the given value and p (or failing). */
function stub(name: Backend, answer: ((id: string) => Omit<Answer, 'id'>) | 'down'): DecisionBackend & { calls: number } {
  const b = {
    name,
    calls: 0,
    async ask(req: AskRequest) {
      b.calls++;
      if (answer === 'down') throw new BackendUnavailableError(name, 'unreachable');
      return { answers: req.questions.map((q) => ({ id: q.id, ...answer(q.id) })), latencyMs: 5 };
    },
    async health() {
      return { ok: answer !== 'down' };
    },
  };
  return b;
}

const OPEN_Q: AskRequest = {
  decision: 'freshness.closed',
  impact: 'medium',
  state: 'Posting page text',
  subject: { type: 'role', id: 'datadog_staff-pm' },
  questions: [{ id: 'open', type: 'noulli', instructions: 'Is this posting still accepting applications?' }],
};
const WHO_Q: AskRequest = {
  decision: 'people.classify',
  impact: 'low',
  state: { name: 'Maya R.', headline: 'Director of Product' },
  subject: { type: 'contact', id: 'ct_0001' },
  questions: [
    { id: 'who', type: 'choice', instructions: 'Who is this person for the role?', options: ['hiring_manager', 'peer', 'other'] },
  ],
};

/** Medium-impact variant: the #24 grid's second-opinion row. */
const WHO_M: AskRequest = { ...WHO_Q, impact: 'medium' };

/**
 * Kev first with the LLM adapter as the fallback, so the routing tests exercise a full adapter chain.
 * DEFAULT_CONFIG itself is Kev with the agent fallback (wave1-decisions #7, #9).
 */
const KEV_FIRST: PolicyConfig = {
  ...DEFAULT_CONFIG,
  backends: { ...DEFAULT_CONFIG.backends, default: 'kev', fallback: 'llm' },
};

let h: ReturnType<typeof tempDb>;
let store: DecisionStore;
beforeEach(() => {
  h = tempDb();
  store = createSqliteDecisionStore(h.db);
});
afterEach(() => h.close());

let n = 0;
function resolver(backends: BackendMap, extra: { config?: PolicyConfig; runOp?: ReturnType<typeof fakeRunOp> } = {}) {
  return createResolver({
    config: extra.config ?? KEV_FIRST,
    backends,
    store,
    now: () => NOW,
    newId: () => `dc_t${++n}`,
    ...(extra.runOp ? { runOp: extra.runOp } : {}),
  });
}

describe('routing and fallback', () => {
  it('the default backend answers first', async () => {
    const kev = stub('kev', () => ({ value: true, p: 0.95 }));
    const llm = stub('llm', () => ({ value: true, p: 0.95 }));
    const r = resolver({ kev, llm });
    const res = await r.ask(OPEN_Q);
    expect(res.backend).toBe('kev');
    expect(llm.calls).toBe(0);
  });

  it('Kev unreachable -> LLM -> human queue', async () => {
    const kev = stub('kev', 'down');
    const llm = stub('llm', () => ({ value: false, p: 0.6 }));
    expect((await resolver({ kev, llm }).ask(OPEN_Q)).backend).toBe('llm');
    const res = await resolver({ kev: stub('kev', 'down'), llm: stub('llm', 'down') }).ask(OPEN_Q);
    expect(res.backend).toBe('human');
    expect(res.outcomes).toEqual(['human']);
    expect(store.get(res.decisionIds[0] as string)).toMatchObject({ backend: 'human', status: 'pending', p: 0 });
  });

  it('route() skips backends that are not configured (no LLM key)', () => {
    expect(resolver({ kev: stub('kev', 'down') }).route(OPEN_Q)).toEqual(['kev']);
    const r = resolver({ kev: stub('kev', 'down'), llm: stub('llm', 'down') });
    expect(r.route(OPEN_Q)).toEqual(['kev', 'llm']);
  });

  it('invalid answers count as a failure and fall back', async () => {
    const kev = stub('kev', () => ({ value: 'banana', p: 0.99 }));
    const llm = stub('llm', () => ({ value: 'peer', p: 0.95 }));
    expect((await resolver({ kev, llm }).ask(WHO_Q)).backend).toBe('llm');
  });

  it('numbers and dates go to the rule backend', async () => {
    const kev = stub('kev', () => ({ value: true, p: 0.99 }));
    const rule = createRuleBackend({ now: () => NOW });
    const req: AskRequest = {
      decision: 'other',
      impact: 'low',
      state: { comp_max: '190000', comp_floor: '200000' },
      questions: [{ id: 'meets_comp_floor', type: 'noulli', instructions: 'Meets the comp floor?' }],
    };
    const res = await resolver({ kev, rule }).ask(req);
    expect(res).toMatchObject({ backend: 'rule', answers: [{ value: false, p: 1 }], outcomes: ['auto'] });
    expect(kev.calls).toBe(0);
  });

  it('a forced backend is used alone', async () => {
    const kev = stub('kev', () => ({ value: 'peer', p: 0.95 }));
    const llm = stub('llm', () => ({ value: 'peer', p: 0.95 }));
    expect((await resolver({ kev, llm }).ask({ ...WHO_Q, backend: 'llm' })).backend).toBe('llm');
    expect(kev.calls).toBe(0);
  });
});

describe('default routing: rule -> Kev -> agent -> human (wave1-decisions #9)', () => {
  const kevOnly = () => createResolver({ config: DEFAULT_CONFIG, backends: {}, store, now: () => NOW, newId: () => `dc_a${++n}` });
  it('Kev down, agent attached with an answer: the agent answer is logged', async () => {
    const r = createResolver({
      config: DEFAULT_CONFIG,
      backends: { kev: stub('kev', 'down'), agent: createAgentBackend({ confidence: { p: 0.95 } }) },
      store,
      now: () => NOW,
      newId: () => `dc_a${++n}`,
    });
    expect(r.route(OPEN_Q)).toEqual(['kev', 'agent']);
    const res = await r.ask(OPEN_Q);
    expect(res.backend).toBe('agent');
    expect(res.answers[0]).toMatchObject({ value: true, p: 0.95 });
  });
  it('Kev down, agent attached without an answer: yields to a human', async () => {
    const r = createResolver({
      config: DEFAULT_CONFIG,
      backends: { kev: stub('kev', 'down'), agent: createAgentBackend({}) },
      store,
      now: () => NOW,
    });
    const res = await r.ask(WHO_M);
    expect(res.backend).toBe('human');
    expect(res.outcomes).toEqual(['human']);
  });
  it('no backends at all: human', async () => {
    expect((await kevOnly().ask(OPEN_Q)).backend).toBe('human');
  });
  it('the API adapter only when enabled', () => {
    const env = { ANTHROPIC_API_KEY: 'k' };
    expect(Object.keys(backendsFromConfig(DEFAULT_CONFIG, { env })).sort()).toEqual(['kev', 'rule']);
    const on = {
      ...DEFAULT_CONFIG,
      backends: {
        ...DEFAULT_CONFIG.backends,
        llm: { provider: 'anthropic' as const, enabled: true },
      },
    };
    expect(Object.keys(backendsFromConfig(on, { env, agent: {} })).sort()).toEqual(['agent', 'kev', 'llm', 'rule']);
  });
  it('second opinion comes from the attached agent', async () => {
    const r = createResolver({
      config: DEFAULT_CONFIG,
      backends: {
        kev: stub('kev', () => ({ value: 'peer', p: 0.8 })),
        agent: createAgentBackend({ answers: { who: { value: 'peer', p: 0.85 } } }),
      },
      store,
      now: () => NOW,
    });
    const res = await r.ask(WHO_M);
    expect(res.outcomes).toEqual(['auto_second']);
    expect(store.get(res.decisionIds[0] as string)?.answer_json).toMatchObject({ second: { backend: 'agent', value: 'peer' } });
  });
  it('a hard-exclusion hint forces a human', async () => {
    const r = createResolver({
      config: DEFAULT_CONFIG,
      backends: { kev: stub('kev', () => ({ value: true, p: 0.99 })) },
      store,
      now: () => NOW,
      hardHuman: () => ({ component: 'dealbreakers' }),
    });
    const res = await r.ask({ ...OPEN_Q, decision: 'profile.apply_diff', impact: 'high' });
    expect(res.outcomes).toEqual(['human']);
  });
});

describe('policy outcomes written to the decisions log', () => {
  it('low + confident -> auto, applied', async () => {
    const res = await resolver({ kev: stub('kev', () => ({ value: 'peer', p: 0.93 })) }).ask(WHO_Q);
    expect(res.outcomes).toEqual(['auto']);
    expect(store.get(res.decisionIds[0] as string)).toMatchObject({
      kind: 'people.classify',
      subject_type: 'contact',
      subject_id: 'ct_0001',
      backend: 'kev',
      status: 'applied',
      resolved_at: NOW.toISOString(),
      undo_until: null,
    });
  });

  it('low + middle -> auto (#24 grid)', async () => {
    const res = await resolver({ kev: stub('kev', () => ({ value: 'peer', p: 0.8 })) }).ask(WHO_Q);
    expect(res.outcomes).toEqual(['auto']);
  });

  it('low + low -> auto_undo with a 24h window (#24 grid)', async () => {
    const res = await resolver({ kev: stub('kev', () => ({ value: 'peer', p: 0.5 })) }).ask(WHO_Q);
    expect(res.outcomes).toEqual(['auto_undo']);
    expect(store.get(res.decisionIds[0] as string)).toMatchObject({ undo_until: '2026-10-09T12:00:00.000Z', status: 'applied' });
  });

  it('medium + middle -> auto_second when the second backend agrees (p >= 0.70)', async () => {
    const llm = stub('llm', () => ({ value: 'peer', p: 0.72 }));
    const res = await resolver({ kev: stub('kev', () => ({ value: 'peer', p: 0.8 })), llm }).ask(WHO_M);
    expect(res.outcomes).toEqual(['auto_second']);
    expect(store.get(res.decisionIds[0] as string)?.answer_json).toMatchObject({
      value: 'peer',
      second: { backend: 'llm', value: 'peer', p: 0.72 },
    });
  });

  it('medium + middle -> human when the second backend disagrees, is unsure, or is missing', async () => {
    const kev = () => stub('kev', () => ({ value: 'peer', p: 0.8 }));
    expect((await resolver({ kev: kev(), llm: stub('llm', () => ({ value: 'hiring_manager', p: 0.9 })) }).ask(WHO_M)).outcomes).toEqual([
      'human',
    ]);
    expect((await resolver({ kev: kev(), llm: stub('llm', () => ({ value: 'peer', p: 0.69 })) }).ask(WHO_M)).outcomes).toEqual(['human']);
    expect((await resolver({ kev: kev() }).ask(WHO_M)).outcomes).toEqual(['human']);
  });

  it('second opinion falls through agent down -> LLM', async () => {
    const llm = stub('llm', () => ({ value: 'peer', p: 0.75 }));
    const res = await resolver({ kev: stub('kev', () => ({ value: 'peer', p: 0.8 })), agent: stub('agent', 'down'), llm }).ask(WHO_M);
    expect(res.outcomes).toEqual(['auto_second']);
    expect(llm.calls).toBe(1);
  });

  it('medium + confident -> auto, no undo window (#24 grid)', async () => {
    const res = await resolver({ kev: stub('kev', () => ({ value: false, p: 0.97 })) }).ask(OPEN_Q);
    expect(res.outcomes).toEqual(['auto']);
    expect(store.get(res.decisionIds[0] as string)).toMatchObject({ undo_until: null, status: 'applied' });
  });

  it('per-kind override: freshness.closed needs 0.92', async () => {
    const res = await resolver({ kev: stub('kev', () => ({ value: false, p: 0.91 })) }).ask(OPEN_Q);
    expect(res.outcomes).toEqual(['human']);
  });

  it('high impact is never auto, even at p = 1 and even if the caller says low', async () => {
    const kev = stub('kev', () => ({ value: true, p: 1 }));
    const res = await resolver({ kev }).ask({
      decision: 'apply.submit',
      impact: 'low',
      state: 'package ready',
      subject: { type: 'role', id: 'vercel_pm' },
      questions: [{ id: 'submit', type: 'noulli', instructions: 'Ready to submit?' }],
    });
    expect(res.outcomes).toEqual(['human']);
    expect(store.get(res.decisionIds[0] as string)).toMatchObject({ impact: 'high', status: 'pending', policy_outcome: 'human' });
  });

  it('one row per question, same order, mixed outcomes', async () => {
    const kev = stub('kev', (id) => (id === 'a' ? { value: true, p: 0.95 } : { value: true, p: 0.5 }));
    const res = await resolver({ kev }).ask({
      ...OPEN_Q,
      decision: 'roles.dedupe',
      impact: 'medium',
      questions: [
        { id: 'a', type: 'noulli', instructions: '' },
        { id: 'b', type: 'noulli', instructions: '' },
      ],
    });
    expect(res.outcomes).toEqual(['auto', 'human']);
    expect(res.decisionIds).toHaveLength(2);
    expect(store.list({ statuses: ['pending'] }).map((d) => d.id)).toEqual([res.decisionIds[1]]);
  });

  it('writes a decision_made event for applied decisions only', async () => {
    const kev = stub('kev', (id) => (id === 'a' ? { value: true, p: 0.95 } : { value: true, p: 0.5 }));
    await resolver({ kev }).ask({
      ...OPEN_Q,
      decision: 'roles.dedupe',
      impact: 'medium',
      questions: [
        { id: 'a', type: 'noulli', instructions: '' },
        { id: 'b', type: 'noulli', instructions: '' },
      ],
    });
    const events = h.db.prepare("SELECT * FROM event WHERE type = 'decision_made'").all();
    expect(events).toHaveLength(1);
  });
});

describe('auto actions', () => {
  const archiveIfClosed = {
    open: {
      op: 'roles.archive',
      input: { role_id: 'datadog_staff-pm', reason: 'closed' },
      when: false,
      undo: { op: 'roles.move', input: { role_id: 'datadog_staff-pm', to: 'active' } },
    },
  };

  it('runs the action through RunOp with the decision id', async () => {
    const runOp = fakeRunOp();
    const res = await resolver({ kev: stub('kev', () => ({ value: false, p: 0.97 })) }, { runOp }).ask(OPEN_Q, {
      actions: archiveIfClosed,
    });
    expect(runOp.calls).toEqual([
      { name: 'roles.archive', input: { role_id: 'datadog_staff-pm', reason: 'closed' }, actor: 'agent', decisionId: res.decisionIds[0] },
    ]);
    expect(store.get(res.decisionIds[0] as string)?.action_json).toMatchObject({ op: 'roles.archive', when: false });
  });

  it('skips the action when `when` does not match', async () => {
    const runOp = fakeRunOp();
    await resolver({ kev: stub('kev', () => ({ value: true, p: 0.97 })) }, { runOp }).ask(OPEN_Q, { actions: archiveIfClosed });
    expect(runOp.calls).toEqual([]);
  });

  it('never runs the action for a human outcome', async () => {
    const runOp = fakeRunOp();
    await resolver({ kev: stub('kev', () => ({ value: false, p: 0.6 })) }, { runOp }).ask(OPEN_Q, { actions: archiveIfClosed });
    expect(runOp.calls).toEqual([]);
  });

  it('substitutes $value', async () => {
    const runOp = fakeRunOp();
    await resolver({ kev: stub('kev', () => ({ value: 'peer', p: 0.97 })) }, { runOp }).ask(WHO_Q, {
      actions: { who: { op: 'people.link', input: { contact_id: 'ct_0001', role: '$value' } } },
    });
    expect(runOp.calls[0]?.input).toEqual({ contact_id: 'ct_0001', role: 'peer' });
  });

  it('a failed action hands the decision to a human with the pick attached', async () => {
    const runOp = fakeRunOp(() => ({ status: 'error', code: 'forbidden_transition', message: 'no-downgrade' }));
    const res = await resolver({ kev: stub('kev', () => ({ value: false, p: 0.97 })) }, { runOp }).ask(OPEN_Q, {
      actions: archiveIfClosed,
    });
    expect(res.outcomes).toEqual(['human']);
    expect(store.get(res.decisionIds[0] as string)).toMatchObject({
      status: 'pending',
      policy_outcome: 'human',
      undo_until: null,
      answer_json: { value: false, p: 0.97, action_error: 'no-downgrade' },
    });
  });
});

describe('record (externally judged answers)', () => {
  const base = {
    decision: 'inbox.classify' as const,
    impact: 'medium' as const,
    subject: { type: 'role', id: 'notion_staff-pm' },
    question: { id: 'class', type: 'choice', options: ['confirmation', 'other'] },
    backend: 'agent' as const,
  };

  it('applies policy without calling a backend and runs the action when auto', async () => {
    const runOp = fakeRunOp();
    const kev = stub('kev', () => ({ value: 'other', p: 0.99 }));
    const r = resolver({ kev }, { runOp });
    const res = await r.record({
      ...base,
      answer: { id: 'class', value: 'confirmation', p: 0.95 },
      action: { op: 'roles.move', input: { role_id: 'notion_staff-pm', to: 'applied' } },
    });
    // inbox.classify carries confident_outcome auto_undo in DEFAULT_CONFIG (wave1-decisions #16).
    expect(res.outcome).toBe('auto_undo');
    expect(kev.calls).toBe(0);
    expect(runOp.calls).toHaveLength(1);
    expect(store.get(res.decisionId)).toMatchObject({ backend: 'agent', status: 'applied', kind: 'inbox.classify' });
  });

  it('forceHuman queues whatever the p; hard exclusions too', async () => {
    const a = await resolver({}).record({ ...base, answer: { id: 'class', value: 'confirmation', p: 0.99 } }, { forceHuman: true });
    expect(a.outcome).toBe('human');
    const b = await resolver({}).record({
      ...base,
      decision: 'other',
      answer: { id: 'class', value: true, p: 0.99 },
      action: { op: 'outreach.send', input: {} },
    });
    expect(b.outcome).toBe('human');
  });

  it('middle confidence on medium impact has no second opinion: human', async () => {
    const res = await resolver({}).record({ ...base, answer: { id: 'class', value: 'confirmation', p: 0.8 } });
    expect(res.outcome).toBe('human');
    expect(store.get(res.decisionId)).toMatchObject({ status: 'pending', policy_outcome: 'human' });
  });
});

describe('consult and record second opinions (#40)', () => {
  const SCORE_Q: AskRequest = {
    decision: 'roles.criterion',
    impact: 'low',
    state: { title: 'PM' },
    subject: { type: 'role', id: 'notion_staff-pm' },
    questions: [{ id: 'c1', type: 'score', instructions: 'Decisions', min: 1, max: 5 }],
  };

  it('consult asks one backend and logs nothing; undefined when it fails or answers out of range', async () => {
    const kev = stub('kev', () => ({ value: 4, p: 0.8 }));
    const r = resolver({ kev, agent: stub('agent', () => ({ value: 2, p: 0.9 })) });
    expect(await r.consult('kev', SCORE_Q)).toMatchObject({ backend: 'kev', answers: [{ id: 'c1', value: 4, p: 0.8 }] });
    expect(await resolver({ kev: stub('kev', 'down') }).consult('kev', SCORE_Q)).toBeUndefined();
    expect(await resolver({ kev: stub('kev', () => ({ value: 9, p: 0.8 })) }).consult('kev', SCORE_Q)).toBeUndefined();
    expect(await resolver({}).consult('kev', SCORE_Q)).toBeUndefined();
    expect(h.db.prepare('SELECT count(*) n FROM decision').get()).toMatchObject({ n: 0 });
  });

  it('record keeps a second answer and extra fields in answer_json', async () => {
    const res = await resolver({}).record(
      { ...SCORE_Q, question: SCORE_Q.questions[0] as Record<string, unknown>, answer: { id: 'c1', value: 5, p: 0.75 }, backend: 'agent' },
      { second: { backend: 'kev', value: 2, p: 0.8 }, extra: { disagree: true } },
    );
    expect(store.get(res.decisionId)?.answer_json).toEqual({
      id: 'c1',
      value: 5,
      p: 0.75,
      second: { backend: 'kev', value: 2, p: 0.8 },
      disagree: true,
    });
  });
});
