import type { Decision, OpContext, Score } from '@perfect-placement/contracts';
import { createKevBackend } from '@perfect-placement/resolver';
import { afterEach, describe, expect, it } from 'vitest';
import { ctxAt, type FakeScript, type FixtureEngine, okOut, openFixtureEngine } from '../testing/index.js';
import { leaksBrand } from './blind.js';

/*
 * #40: roles.score through the decision layer. Kev is a fake transport (no network) or a scripted double.
 */

const ROLE = 'notion_product-lead-data-platform'; // inbox, company Notion
const NOW = '2026-10-08T12:00:00.000Z';
const agent: OpContext = ctxAt('agent', {}, NOW);
const human: OpContext = ctxAt('human', {}, NOW);
const crit = (s: string) => Object.fromEntries([...s].map((v, i) => [`c${i + 1}`, Number(v)]));

let e: FixtureEngine;
afterEach(() => e.cleanup());

const decisions = (where = '1', ...args: unknown[]) =>
  e.db
    .prepare(`SELECT * FROM decision WHERE kind = 'roles.criterion' AND length(id) > 10 AND ${where} ORDER BY rowid`)
    .all(...args) as Array<Record<string, unknown> & { question_json: string; answer_json: string }>;
const status = () => (e.db.prepare('SELECT status FROM role WHERE id = ?').get(ROLE) as { status: string }).status;
const facts = (s: Score) =>
  s.facts_json as {
    criteria_source: Record<string, { backend: string; p: number; decision_id: string; latency_ms: number }>;
    second_opinion?: string;
    disagreements?: Array<{ criterion: string; agent: number; kev: number }>;
  };

/** A Kev HTTP server double: answers every score question at level index `idx` with p 0.9, records the bodies. */
function kevTransport(idx = 3) {
  const bodies: Array<{ state: Record<string, string>; questions: Record<string, unknown> }> = [];
  const fetch = (async (url: string, init?: { body?: string }) => {
    expect(url).toBe('http://127.0.0.1:8009/v1/systemone');
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const answers = Object.fromEntries(
      Object.keys(body.questions).map((id) => [id, { type: 'score', score: idx, probabilities: { [String(idx)]: 0.9, '0': 0.1 } }]),
    );
    return new Response(JSON.stringify({ model: 'kev-test', answers }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { bodies, kev: createKevBackend({ fetch, clock: () => 0 }) };
}

describe('roles.score without criteria: the resolver judges (#40)', () => {
  it('Kev judges C1..C9 in one call per state, blind for C1 C2 C3 C4 C9, one decision row per criterion', async () => {
    const t = kevTransport(3); // level index 3 = score 4
    e = openFixtureEngine({ services: { backends: { kev: t.kev } } });
    const out = okOut(await e.runOp('roles.score', { role_id: ROLE, facts: { workplace: 'remote', remote_ok: true } }, agent));

    expect(t.bodies).toHaveLength(2);
    const [blind, open] = t.bodies;
    expect(Object.keys(blind?.questions ?? {})).toEqual(['c1', 'c2', 'c3', 'c4', 'c9']);
    expect(Object.keys(open?.questions ?? {})).toEqual(['c5', 'c6', 'c7', 'c8']);
    expect(leaksBrand(JSON.stringify(blind?.state), { name: 'Notion', slug: 'notion' })).toBe(false);
    expect(open?.state.company).toBe('Notion');
    expect(blind?.state.job_description).toContain('Own the roadmap');

    for (const c of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'] as const) expect(out.score[c]).toBe(4);
    const rows = decisions('subject_id = ?', ROLE);
    expect(rows).toHaveLength(9);
    expect(rows.every((r) => r.backend === 'kev' && r.p === 0.9 && r.status === 'applied')).toBe(true);
    const src = facts(out.score).criteria_source;
    expect(Object.keys(src).sort()).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']);
    expect(src.c1).toMatchObject({ backend: 'kev', p: 0.9, latency_ms: 0 });
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining(Object.values(src).map((s) => s.decision_id)));
    expect(status()).not.toBe('inbox');
  });

  it('without Kev an attached agent is told to judge (nothing queued, nothing written)', async () => {
    e = openFixtureEngine();
    const o = await e.runOp('roles.score', { role_id: ROLE }, agent);
    expect(o).toMatchObject({ status: 'error', code: 'backend_unavailable' });
    expect(decisions()).toHaveLength(0);
    expect(status()).toBe('inbox');
  });

  it('without Kev or an agent the nine criteria go to Needs you; once resolved, the score uses them', async () => {
    e = openFixtureEngine();
    const first = await e.runOp('roles.score', { role_id: ROLE }, human);
    expect(first.status).toBe('requires_human');
    const pending = decisions(`status = 'pending'`);
    expect(pending).toHaveLength(9);
    // Asking again does not queue duplicates.
    expect((await e.runOp('roles.score', { role_id: ROLE }, human)).status).toBe('requires_human');
    expect(decisions()).toHaveLength(9);

    for (const d of pending) {
      const id = (JSON.parse(d.question_json) as { id: string }).id;
      okOut(await e.runOp('decisions.resolve', { decision_id: d.id, action: 'change', value: id === 'c6' ? 3 : 5 }, human));
    }
    const out = okOut(await e.runOp('roles.score', { role_id: ROLE, facts: { workplace: 'remote', remote_ok: true } }, human));
    expect(out.score.c6).toBe(3);
    expect(out.score.c1).toBe(5);
    expect(facts(out.score).criteria_source.c6).toMatchObject({ backend: 'human', p: 1 });
    expect(decisions()).toHaveLength(9);
  });
});

describe('roles.score with agent criteria (#40)', () => {
  const kevSays: FakeScript = (q) => (q.type === 'score' ? { value: q.id === 'c3' ? 2 : 4, p: 0.8 } : undefined);

  it('records nine agent decisions; Kev gives a second opinion and gaps over one point are flagged', async () => {
    e = openFixtureEngine({ kev: kevSays });
    const out = okOut(
      await e.runOp(
        'roles.score',
        { role_id: ROLE, criteria: crit('455454444'), criteria_p: { c1: 0.9 }, facts: { workplace: 'remote', remote_ok: true } },
        agent,
      ),
    );
    expect(e.kev.calls).toHaveLength(2);
    const rows = decisions('subject_id = ?', ROLE);
    expect(rows).toHaveLength(9);
    expect(rows.every((r) => r.backend === 'agent')).toBe(true);
    const c3 = rows.find((r) => (JSON.parse(r.question_json) as { id: string }).id === 'c3') as Record<string, unknown>;
    expect(JSON.parse(String(c3.answer_json))).toMatchObject({ value: 5, second: { backend: 'kev', value: 2, p: 0.8 }, disagree: true });
    const f = facts(out.score);
    expect(f.second_opinion).toBe('kev');
    expect(f.disagreements).toEqual([{ criterion: 'c3', agent: 5, kev: 2, kev_p: 0.8 }]);
    expect(f.criteria_source.c1).toMatchObject({ backend: 'agent', p: 0.9 });
    expect(f.criteria_source.c2).toMatchObject({ backend: 'agent', p: 0.75 });
  });

  it('Kev down: the agent criteria still score and the score says no second opinion', async () => {
    e = openFixtureEngine();
    const out = okOut(await e.runOp('roles.score', { role_id: ROLE, criteria: crit('455454444') }, agent));
    expect(facts(out.score).second_opinion).toBe('unavailable');
    expect(facts(out.score).disagreements).toEqual([]);
    expect(decisions()).toHaveLength(9);
  });

  it('a rescore carries the judged sources and writes no decisions', async () => {
    e = openFixtureEngine({ kev: kevSays });
    const first = okOut(await e.runOp('roles.score', { role_id: ROLE, criteria: crit('455454444') }, agent));
    const before = decisions().length;
    const again = okOut(
      await e.runOp('roles.score', { role_id: ROLE, criteria: crit('455454444'), facts: first.score.facts_json, rescore: true }, agent),
    );
    expect(decisions()).toHaveLength(before);
    expect(facts(again.score).criteria_source).toEqual(facts(first.score).criteria_source);
    const ids = Object.values(facts(again.score).criteria_source).map((s) => s.decision_id);
    const rows = e.db.prepare(`SELECT id FROM decision WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Decision[];
    expect(rows).toHaveLength(9);
  });
});
