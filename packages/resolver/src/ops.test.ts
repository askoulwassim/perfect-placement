import { FIXTURE_NOW } from '@perfect-placement/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDecisionOps } from './ops.js';
import { createSqliteDecisionStore, type DecisionStore } from './store.js';
import { fakeRunOp, tempDb } from './test-helpers.js';

let h: ReturnType<typeof tempDb>;
let store: DecisionStore;
const now = () => new Date(FIXTURE_NOW);
const human = { actor: 'human' as const, now };
const agent = { actor: 'agent' as const, now };

beforeEach(() => {
  h = tempDb({ seed: true });
  store = createSqliteDecisionStore(h.db);
});
afterEach(() => h.close());

const events = (type: string) =>
  h.db.prepare('SELECT * FROM event WHERE type = ? ORDER BY ts').all(type) as { decision_id: string; actor: string }[];

describe('decisions.queue (fixtures)', () => {
  it('returns the Needs-you queue and the last 24h of auto decisions', async () => {
    const ops = createDecisionOps({ store, runOp: fakeRunOp() });
    const out = await ops['decisions.queue']({}, human);
    if (out.status !== 'ok') throw new Error(out.status);
    expect(out.output.pending.map((d) => d.id).sort()).toEqual([
      'dc_0001',
      'dc_0002',
      'dc_0003',
      'dc_0004',
      'dc_0005',
      'dc_0006',
      'dc_0007',
    ]);
    expect(out.output.recent_auto.map((d) => d.id).sort()).toEqual(['dc_0101', 'dc_0102', 'dc_0103']);
    expect(out.output.pending.every((d) => d.policy_outcome === 'human')).toBe(true);
  });

  it('honours include_auto_since', async () => {
    const ops = createDecisionOps({ store, runOp: fakeRunOp() });
    const out = await ops['decisions.queue']({ include_auto_since: '2026-10-08T05:30:00.000Z' }, human);
    if (out.status !== 'ok') throw new Error(out.status);
    expect(out.output.recent_auto.map((d) => d.id)).toEqual(['dc_0101']);
  });

  it('rejects invalid input', async () => {
    const out = await createDecisionOps({ store, runOp: fakeRunOp() })['decisions.queue']({ status: ['nope'] }, human);
    expect(out).toMatchObject({ status: 'error', code: 'invalid_input' });
  });
});

describe('decisions.resolve', () => {
  it('accept runs the queued action with the pick and logs decision_made', async () => {
    const runOp = fakeRunOp();
    const out = await createDecisionOps({ store, runOp })['decisions.resolve']({ decision_id: 'dc_0004', action: 'accept' }, human);
    expect(out).toMatchObject({
      status: 'ok',
      output: { op_status: 'ok', decision: { status: 'applied', human_choice: 'true', overridden: false } },
    });
    expect(runOp.calls).toEqual([{ name: 'outreach.to_gmail', input: { outreach_id: 'or_0001' }, actor: 'human', decisionId: 'dc_0004' }]);
    expect(events('decision_made')).toHaveLength(1);
  });

  it('change records the override, coerces the value and logs decision_overridden', async () => {
    const runOp = fakeRunOp();
    const out = await createDecisionOps({ store, runOp })['decisions.resolve'](
      { decision_id: 'dc_0006', action: 'change', value: 'hiring_manager' },
      human,
    );
    expect(out).toMatchObject({
      status: 'ok',
      output: { op_status: 'skipped', decision: { status: 'applied', human_choice: 'hiring_manager', overridden: true } },
    });
    expect(events('decision_overridden')).toHaveLength(1);

    const out2 = await createDecisionOps({ store, runOp })['decisions.resolve'](
      { decision_id: 'dc_0007', action: 'change', value: 'true' },
      agent,
    );
    expect(out2).toMatchObject({ status: 'ok', output: { decision: { human_choice: 'true', overridden: true } } });
  });

  it('change with the same value is not an override', async () => {
    const out = await createDecisionOps({ store, runOp: fakeRunOp() })['decisions.resolve'](
      { decision_id: 'dc_0006', action: 'change', value: 'peer' },
      human,
    );
    expect(out).toMatchObject({ status: 'ok', output: { decision: { overridden: false } } });
  });

  it('skip rejects without running anything', async () => {
    const runOp = fakeRunOp();
    const out = await createDecisionOps({ store, runOp })['decisions.resolve']({ decision_id: 'dc_0005', action: 'skip' }, human);
    expect(out).toMatchObject({ status: 'ok', output: { op_status: 'skipped', decision: { status: 'rejected' } } });
    expect(runOp.calls).toEqual([]);
  });

  it('an agent cannot resolve medium or high impact decisions', async () => {
    const runOp = fakeRunOp();
    const ops = createDecisionOps({ store, runOp });
    for (const id of ['dc_0001', 'dc_0003', 'dc_0005']) {
      expect(await ops['decisions.resolve']({ decision_id: id, action: 'accept' }, agent)).toMatchObject({
        status: 'error',
        code: 'human_only',
      });
    }
    expect(runOp.calls).toEqual([]);
  });

  it('high impact accept is passed to the op as a human action (the op itself is humanOnly)', async () => {
    const runOp = fakeRunOp();
    await createDecisionOps({ store, runOp })['decisions.resolve']({ decision_id: 'dc_0005', action: 'accept' }, human);
    expect(runOp.calls).toEqual([
      { name: 'apply.mark_submitted', input: { role_id: expect.any(String) }, actor: 'human', decisionId: 'dc_0005' },
    ]);
  });

  it('when the action op fails, the decision stays pending', async () => {
    const runOp = fakeRunOp(() => ({ status: 'error', code: 'conflict', message: 'x' }));
    const out = await createDecisionOps({ store, runOp })['decisions.resolve']({ decision_id: 'dc_0004', action: 'accept' }, human);
    expect(out).toMatchObject({ status: 'ok', output: { op_status: 'error', decision: { status: 'pending' } } });
  });

  it('`when` gates the action: archive only if the human says closed', async () => {
    store.update('dc_0001', { action_json: { op: 'roles.archive', input: { role_id: 'r', reason: 'closed' }, when: false } });
    const runOp = fakeRunOp();
    const ops = createDecisionOps({ store, runOp });
    await ops['decisions.resolve']({ decision_id: 'dc_0001', action: 'accept' }, human); // pick was open = true
    expect(runOp.calls).toEqual([]);
  });

  it('cannot resolve twice; unknown id is not_found', async () => {
    const ops = createDecisionOps({ store, runOp: fakeRunOp() });
    await ops['decisions.resolve']({ decision_id: 'dc_0006', action: 'skip' }, human);
    expect(await ops['decisions.resolve']({ decision_id: 'dc_0006', action: 'skip' }, human)).toMatchObject({
      status: 'error',
      code: 'conflict',
    });
    expect(await ops['decisions.resolve']({ decision_id: 'dc_nope', action: 'skip' }, human)).toMatchObject({
      status: 'error',
      code: 'not_found',
    });
    expect(await ops['decisions.resolve']({ decision_id: 'dc_0007', action: 'change' }, human)).toMatchObject({
      status: 'error',
      code: 'invalid_input',
    });
  });
});

describe('decisions.undo', () => {
  it('undoes an auto + undo decision inside its window and runs the inverse op', async () => {
    store.update('dc_0101', {
      action_json: {
        op: 'roles.archive',
        input: { role_id: 'r1', reason: 'closed' },
        undo: { op: 'roles.move', input: { role_id: 'r1', to: 'active' } },
      },
    });
    const runOp = fakeRunOp();
    const out = await createDecisionOps({ store, runOp })['decisions.undo']({ decision_id: 'dc_0101' }, human);
    expect(out).toMatchObject({ status: 'ok', output: { decision: { status: 'undone' } } });
    expect(runOp.calls).toEqual([{ name: 'roles.move', input: { role_id: 'r1', to: 'active' }, actor: 'human', decisionId: 'dc_0101' }]);
    expect(events('decision_undone')).toHaveLength(1);
  });

  it('refuses after the window, for non auto_undo decisions, and twice', async () => {
    const ops = createDecisionOps({ store, runOp: fakeRunOp() });
    const late = { actor: 'human' as const, now: () => new Date('2026-10-09T06:00:01.000Z') };
    expect(await ops['decisions.undo']({ decision_id: 'dc_0101' }, late)).toMatchObject({ status: 'error', code: 'conflict' });
    expect(await ops['decisions.undo']({ decision_id: 'dc_0102' }, human)).toMatchObject({ status: 'error', code: 'conflict' });
    expect(await ops['decisions.undo']({ decision_id: 'dc_0101' }, human)).toMatchObject({ status: 'ok' });
    expect(await ops['decisions.undo']({ decision_id: 'dc_0101' }, human)).toMatchObject({ status: 'error', code: 'conflict' });
  });

  it('keeps the decision applied if the inverse op fails', async () => {
    store.update('dc_0101', { action_json: { op: 'roles.archive', input: {}, undo: { op: 'roles.move', input: {} } } });
    const runOp = fakeRunOp(() => ({ status: 'error', code: 'forbidden_transition', message: 'x' }));
    const out = await createDecisionOps({ store, runOp })['decisions.undo']({ decision_id: 'dc_0101' }, human);
    expect(out).toMatchObject({ status: 'error', code: 'forbidden_transition' });
    expect(store.get('dc_0101')?.status).toBe('applied');
  });
});
