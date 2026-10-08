import type { OpContext } from '@perfect-placement/contracts';
import { FIXTURE_SEED_SQL } from '@perfect-placement/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDbEmitter, type ProfileLlm } from './deps.js';
import { learnFromEvent } from './learn.js';
import { getComponent, getCurrentVersion, getDiff } from './store.js';
import { createFakeResolver, createTempDb, testDeps } from './testing.js';

let tick = 0;
const ctx: OpContext = { actor: 'agent', now: () => new Date(Date.UTC(2026, 9, 8, 13, 0, ++tick)) };

/** Fake LLM: drafts a deterministic diff per component from the event. */
const llm: ProfileLlm = {
  async draftDiff({ component, data, event }) {
    if (component === 'dealbreakers') {
      const hard = (data.hard_nos as string[]) ?? [];
      return {
        before: { hard_nos: hard },
        after: { hard_nos: [...hard, 'pure delivery roles'] },
        evidence: [`rejected at ${String(event.payload.stage)}: delivery-heavy role`],
      };
    }
    if (component === 'craft') {
      return {
        before: { level: 'wrong-recollection' },
        after: { level: 'staff' },
        evidence: ['rejected for principal; feedback said staff scope'],
      };
    }
    if (component === 'domain') return null;
    return { before: {}, after: { note: 'x' }, evidence: [] };
  },
};

describe('learn loop: synthetic rejection', () => {
  let env: ReturnType<typeof createTempDb>;
  let eventId: string;

  beforeEach(() => {
    env = createTempDb(FIXTURE_SEED_SQL);
    eventId = createDbEmitter(env.db)(
      {
        type: 'rejection',
        subject_type: 'role',
        subject_id: 'figma_staff-pm-data-platform',
        payload: { stage: 'onsite', reason: 'looking for more delivery focus' },
        actor: 'agent',
      },
      new Date('2026-10-08T12:30:00.000Z'),
    );
  });
  afterEach(() => env.cleanup());

  it('proposes diffs and routes each by policy: filters to a human, confident weights auto + undo', async () => {
    const ask = createFakeResolver(env.db, (q, req) => {
      if (req.decision === 'profile.learn') {
        if (q.id === 'dealbreakers') return { value: true, p: 0.97 };
        if (q.id === 'craft') return { value: true, p: 0.96 };
        if (q.id === 'domain') return { value: true, p: 0.93 };
        if (q.id === 'story') return { value: true, p: 0.6 }; // unsure -> human
        return { value: false, p: 0.95 };
      }
      return { value: true, p: 0.95 }; // apply? yes, confident
    });
    const deps = testDeps(env.db, { ask, llm });
    const base = getCurrentVersion(env.db)?.id;
    const res = await learnFromEvent(deps, eventId, ctx);

    expect(res.asked).toHaveLength(11);
    expect(ask.calls[0]?.questions.every((q) => q.type === 'noulli')).toBe(true);
    expect(res.changed.sort()).toEqual(['craft', 'dealbreakers', 'domain']);
    expect(res.learn_questions_for_human).toHaveLength(1);

    // Dealbreakers: high impact, proposed, queued for a human, never applied.
    const dq = res.queued.find((q) => getDiff(env.db, q.diff_id)?.component_key === 'dealbreakers');
    expect(dq?.impact).toBe('high');
    const ddiff = getDiff(env.db, dq?.diff_id ?? '');
    expect(ddiff?.status).toBe('pending');
    expect(ddiff?.event_id).toBe(eventId);
    expect(ddiff?.evidence_json[0]).toContain('onsite');
    const dec = env.db.prepare('SELECT * FROM decision WHERE id = ?').get(dq?.decision_id) as Record<string, string>;
    expect(dec.policy_outcome).toBe('human');
    expect(dec.status).toBe('pending');
    expect(JSON.parse(dec.action_json)).toEqual({ op: 'profile.apply_diff', input: { diff_id: ddiff?.id } });

    // Craft: medium, confident -> auto + undo, profile v+1, 'before' taken from data not the model.
    expect(res.applied).toHaveLength(1);
    const ap = res.applied[0];
    expect(ap?.impact).toBe('medium');
    const cdiff = getDiff(env.db, ap?.diff_id ?? '');
    expect((cdiff?.diff_json as { before: { level: string } } | undefined)?.before.level).toBe('principal');
    const v = getCurrentVersion(env.db);
    expect(v?.id).toBe(ap?.version_id);
    expect(v?.parent_id).toBe(base);
    expect(v?.event_id).toBe(eventId);
    expect(getComponent(env.db, v?.id ?? '', 'craft')?.data_json.level).toBe('staff');
    expect(getComponent(env.db, v?.id ?? '', 'dealbreakers')?.data_json).toEqual(
      getComponent(env.db, base ?? '', 'dealbreakers')?.data_json,
    );
    expect(ap?.rescored_role_ids.length).toBeGreaterThan(0);
    const undo = env.db.prepare('SELECT policy_outcome, undo_until FROM decision WHERE subject_id = ?').get(ap?.diff_id) as Record<
      string,
      string
    >;
    expect(undo.policy_outcome).toBe('auto_undo');

    // Domain: the LLM judged no change after all -> nothing proposed.
    expect(res.proposed.map((d) => d.component_key).sort()).toEqual(['craft', 'dealbreakers']);
  });

  it('even a resolver that says auto cannot apply a dealbreaker change', async () => {
    const ask = createFakeResolver(env.db, (q, req) =>
      req.decision === 'profile.learn' ? { value: q.id === 'dealbreakers', p: 0.99 } : { value: true, p: 0.99 },
    );
    const res = await learnFromEvent(testDeps(env.db, { ask, llm }), eventId, ctx);
    expect(res.applied).toHaveLength(0);
    expect(res.queued).toHaveLength(1);
    expect(getCurrentVersion(env.db)?.id).toBe('pv_0002');
  });

  it('ignores non-learning events', async () => {
    const other = createDbEmitter(env.db)(
      { type: 'role_added', subject_type: 'role', subject_id: 'x', payload: {}, actor: 'agent' },
      new Date(),
    );
    const ask = createFakeResolver(env.db, () => ({ value: true, p: 0.99 }));
    const res = await learnFromEvent(testDeps(env.db, { ask, llm }), other, ctx);
    expect(res.asked).toHaveLength(0);
    expect(ask.calls).toHaveLength(0);
  });
});
