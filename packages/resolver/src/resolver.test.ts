import {
  type Answer,
  type AskRequest,
  type Backend,
  DEFAULT_CONFIG,
  type DecisionBackend,
  type PolicyConfig,
} from '@perfect-placement/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuleBackend } from './backends/rule.js';
import { BackendUnavailableError } from './errors.js';
import { type BackendMap, createResolver } from './resolver.js';
import { createSqliteDecisionStore, type DecisionStore } from './store.js';
import { fakeRunOp, tempDb } from './test-helpers.js';

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
    config: extra.config ?? DEFAULT_CONFIG,
    backends,
    store,
    now: () => NOW,
    newId: () => `dc_t${++n}`,
    ...(extra.runOp ? { runOp: extra.runOp } : {}),
  });
}

describe('routing and fallback', () => {
  it('Jev first when configured', async () => {
    const jev = stub('jev', () => ({ value: true, p: 0.95 }));
    const kev = stub('kev', () => ({ value: true, p: 0.95 }));
    const r = resolver({ jev, kev });
    const res = await r.ask(OPEN_Q);
    expect(res.backend).toBe('jev');
    expect(kev.calls).toBe(0);
  });

  it('Jev unreachable -> Kev -> LLM -> human queue', async () => {
    const jev = stub('jev', 'down');
    const kev = stub('kev', 'down');
    const llm = stub('llm', () => ({ value: false, p: 0.6 }));
    expect((await resolver({ jev, kev, llm }).ask(OPEN_Q)).backend).toBe('llm');
    const res = await resolver({ jev, kev: stub('kev', 'down'), llm: stub('llm', 'down') }).ask(OPEN_Q);
    expect(res.backend).toBe('human');
    expect(res.outcomes).toEqual(['human']);
    expect(store.get(res.decisionIds[0] as string)).toMatchObject({ backend: 'human', status: 'pending', p: 0 });
  });

  it('route() skips backends that are not configured (no Jev key)', () => {
    const r = resolver({ kev: stub('kev', 'down'), llm: stub('llm', 'down') });
    expect(r.route(OPEN_Q)).toEqual(['kev', 'llm']);
  });

  it('invalid answers count as a failure and fall back', async () => {
    const jev = stub('jev', () => ({ value: 'banana', p: 0.99 }));
    const kev = stub('kev', () => ({ value: 'peer', p: 0.95 }));
    expect((await resolver({ jev, kev }).ask(WHO_Q)).backend).toBe('kev');
  });

  it('numbers and dates go to the rule backend', async () => {
    const jev = stub('jev', () => ({ value: true, p: 0.99 }));
    const rule = createRuleBackend({ now: () => NOW });
    const req: AskRequest = {
      decision: 'other',
      impact: 'low',
      state: { comp_max: '190000', comp_floor: '200000' },
      questions: [{ id: 'meets_comp_floor', type: 'noulli', instructions: 'Meets the comp floor?' }],
    };
    const res = await resolver({ jev, rule }).ask(req);
    expect(res).toMatchObject({ backend: 'rule', answers: [{ value: false, p: 1 }], outcomes: ['auto'] });
    expect(jev.calls).toBe(0);
  });

  it('a forced backend is used alone', async () => {
    const jev = stub('jev', () => ({ value: 'peer', p: 0.95 }));
    const llm = stub('llm', () => ({ value: 'peer', p: 0.95 }));
    expect((await resolver({ jev, llm }).ask({ ...WHO_Q, backend: 'llm' })).backend).toBe('llm');
    expect(jev.calls).toBe(0);
  });
});

describe('policy outcomes written to the decisions log', () => {
  it('low + confident -> auto, applied', async () => {
    const res = await resolver({ jev: stub('jev', () => ({ value: 'peer', p: 0.93 })) }).ask(WHO_Q);
    expect(res.outcomes).toEqual(['auto']);
    expect(store.get(res.decisionIds[0] as string)).toMatchObject({
      kind: 'people.classify',
      subject_type: 'contact',
      subject_id: 'ct_0001',
      backend: 'jev',
      status: 'applied',
      resolved_at: NOW.toISOString(),
      undo_until: null,
    });
  });

  it('low + middle -> auto_second when Kev agrees (p >= 0.70)', async () => {
    const kev = stub('kev', () => ({ value: 'peer', p: 0.72 }));
    const res = await resolver({ jev: stub('jev', () => ({ value: 'peer', p: 0.8 })), kev }).ask(WHO_Q);
    expect(res.outcomes).toEqual(['auto_second']);
    expect(store.get(res.decisionIds[0] as string)?.answer_json).toMatchObject({
      value: 'peer',
      second: { backend: 'kev', value: 'peer', p: 0.72 },
    });
  });

  it('low + middle -> human when the second backend disagrees, is unsure, or is missing', async () => {
    const jev = () => stub('jev', () => ({ value: 'peer', p: 0.8 }));
    expect((await resolver({ jev: jev(), kev: stub('kev', () => ({ value: 'hiring_manager', p: 0.9 })) }).ask(WHO_Q)).outcomes).toEqual([
      'human',
    ]);
    expect((await resolver({ jev: jev(), kev: stub('kev', () => ({ value: 'peer', p: 0.69 })) }).ask(WHO_Q)).outcomes).toEqual(['human']);
    expect((await resolver({ jev: jev() }).ask(WHO_Q)).outcomes).toEqual(['human']);
  });

  it('second opinion falls through Kev down -> LLM', async () => {
    const llm = stub('llm', () => ({ value: 'peer', p: 0.75 }));
    const res = await resolver({ jev: stub('jev', () => ({ value: 'peer', p: 0.8 })), kev: stub('kev', 'down'), llm }).ask(WHO_Q);
    expect(res.outcomes).toEqual(['auto_second']);
    expect(llm.calls).toBe(1);
  });

  it('medium + confident -> auto_undo with a 24h window', async () => {
    const res = await resolver({ jev: stub('jev', () => ({ value: false, p: 0.97 })) }).ask(OPEN_Q);
    expect(res.outcomes).toEqual(['auto_undo']);
    expect(store.get(res.decisionIds[0] as string)).toMatchObject({ undo_until: '2026-10-09T12:00:00.000Z', status: 'applied' });
  });

  it('per-kind override: freshness.closed needs 0.92', async () => {
    const res = await resolver({ jev: stub('jev', () => ({ value: false, p: 0.91 })) }).ask(OPEN_Q);
    expect(res.outcomes).toEqual(['human']);
  });

  it('high impact is never auto, even at p = 1 and even if the caller says low', async () => {
    const jev = stub('jev', () => ({ value: true, p: 1 }));
    const res = await resolver({ jev }).ask({
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
    const jev = stub('jev', (id) => (id === 'a' ? { value: true, p: 0.95 } : { value: true, p: 0.5 }));
    const res = await resolver({ jev }).ask({
      ...OPEN_Q,
      decision: 'roles.dedupe',
      impact: 'low',
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
    const jev = stub('jev', (id) => (id === 'a' ? { value: true, p: 0.95 } : { value: true, p: 0.5 }));
    await resolver({ jev }).ask({
      ...OPEN_Q,
      decision: 'roles.dedupe',
      impact: 'low',
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
    const res = await resolver({ jev: stub('jev', () => ({ value: false, p: 0.97 })) }, { runOp }).ask(OPEN_Q, {
      actions: archiveIfClosed,
    });
    expect(runOp.calls).toEqual([
      { name: 'roles.archive', input: { role_id: 'datadog_staff-pm', reason: 'closed' }, actor: 'agent', decisionId: res.decisionIds[0] },
    ]);
    expect(store.get(res.decisionIds[0] as string)?.action_json).toMatchObject({ op: 'roles.archive', when: false });
  });

  it('skips the action when `when` does not match', async () => {
    const runOp = fakeRunOp();
    await resolver({ jev: stub('jev', () => ({ value: true, p: 0.97 })) }, { runOp }).ask(OPEN_Q, { actions: archiveIfClosed });
    expect(runOp.calls).toEqual([]);
  });

  it('never runs the action for a human outcome', async () => {
    const runOp = fakeRunOp();
    await resolver({ jev: stub('jev', () => ({ value: false, p: 0.6 })) }, { runOp }).ask(OPEN_Q, { actions: archiveIfClosed });
    expect(runOp.calls).toEqual([]);
  });

  it('substitutes $value', async () => {
    const runOp = fakeRunOp();
    await resolver({ jev: stub('jev', () => ({ value: 'peer', p: 0.97 })) }, { runOp }).ask(WHO_Q, {
      actions: { who: { op: 'people.link', input: { contact_id: 'ct_0001', role: '$value' } } },
    });
    expect(runOp.calls[0]?.input).toEqual({ contact_id: 'ct_0001', role: 'peer' });
  });

  it('a failed action hands the decision to a human with the pick attached', async () => {
    const runOp = fakeRunOp(() => ({ status: 'error', code: 'forbidden_transition', message: 'no-downgrade' }));
    const res = await resolver({ jev: stub('jev', () => ({ value: false, p: 0.97 })) }, { runOp }).ask(OPEN_Q, {
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
