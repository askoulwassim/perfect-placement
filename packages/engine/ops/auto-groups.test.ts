import type { AutoGroup, OpContext } from '@perfect-placement/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { ctxAt, type FixtureEngine, okOut, openFixtureEngine } from '../testing/index.js';

/*
 * #103: decisions.queue groups the auto stream per subject and run (auto_groups), and
 * decisions.undo_group undoes a group's undoable members in one call. Temp fixture vault only.
 */

const ROLE = 'notion_product-lead-data-platform';
const T1 = '2026-10-08T09:00:00.000Z';
const T2 = '2026-10-08T11:00:00.000Z';
const NOW = '2026-10-08T12:00:00.000Z';
const FIVES = Object.fromEntries(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'].map((c) => [c, 5]));

let e: FixtureEngine;
afterEach(() => e?.cleanup());

const human: OpContext = ctxAt('human', {}, NOW);

/** One agent score run for ROLE at `at`: runs.start, then roles.score inside it. Returns the run id and score total. */
async function scoreRun(at: string): Promise<{ runId: string; total: number }> {
  const run = okOut(await e.runOp('runs.start', { skill: 'score' }, ctxAt('agent', {}, at))).run;
  const out = okOut(
    await e.runOp(
      'roles.score',
      { role_id: ROLE, criteria: FIVES, facts: { workplace: 'remote', remote_ok: true } },
      ctxAt('agent', { runId: run.id }, at),
    ),
  );
  return { runId: run.id, total: out.score.total };
}

const groups = async (): Promise<AutoGroup[]> => okOut(await e.runOp('decisions.queue', {}, human)).auto_groups;
const roleGroups = async () => (await groups()).filter((g) => g.kind === 'roles.criterion' && g.subject_id === ROLE);

/** Test setup: make decisions auto + undo with an open window (scoring itself applies them as plain auto). */
const makeUndoable = (ids: string[]) => {
  const upd = e.db.prepare(`UPDATE decision SET policy_outcome = 'auto_undo', undo_until = ? WHERE id = ?`);
  for (const id of ids) upd.run('2026-10-09T12:00:00.000Z', id);
};

describe('auto stream groups (#103)', () => {
  it('nine criterion decisions for one role in one score run are one group with count 9, the run and the total', async () => {
    e = openFixtureEngine();
    const { runId, total } = await scoreRun(T1);
    const gs = await roleGroups();
    expect(gs).toHaveLength(1);
    const g = gs[0] as AutoGroup;
    expect(g).toMatchObject({ count: 9, run_id: runId, total, backend: 'agent', subject_type: 'role', undoable_ids: [] });
    expect(g.decision_ids).toHaveLength(9);
    // Every member is in recent_auto, so a client can expand the group.
    const q = okOut(await e.runOp('decisions.queue', {}, human));
    const ids = new Set(q.recent_auto.map((d: { id: string }) => d.id));
    for (const id of g.decision_ids) expect(ids.has(id)).toBe(true);
    // The decision_made events carry the run.
    const linked = e.db
      .prepare(`SELECT COUNT(*) AS n FROM event WHERE type = 'decision_made' AND json_extract(payload_json, '$.run_id') = ?`)
      .get(runId) as { n: number };
    expect(linked.n).toBe(9);
  });

  it('two score runs for the same role are two groups, newest first', async () => {
    e = openFixtureEngine();
    const a = await scoreRun(T1);
    const b = await scoreRun(T2);
    const gs = await roleGroups();
    expect(gs.map((g) => g.run_id)).toEqual([b.runId, a.runId]);
    expect(gs.map((g) => g.count)).toEqual([9, 9]);
  });

  it('decisions.undo_group undoes the undoable members in one call and skips the rest', async () => {
    e = openFixtureEngine();
    await scoreRun(T1);
    const g = (await roleGroups())[0] as AutoGroup;
    const [keep, ...rest] = g.decision_ids;
    makeUndoable(rest);
    const after = (await roleGroups())[0] as AutoGroup;
    expect(after.undoable_ids.sort()).toEqual([...rest].sort());

    const undoneEvents = () => (e.db.prepare(`SELECT COUNT(*) AS n FROM event WHERE type = 'decision_undone'`).get() as { n: number }).n;
    const before = undoneEvents();
    const out = okOut(await e.runOp('decisions.undo_group', { decision_ids: g.decision_ids }, human));
    expect(out.undone).toHaveLength(8);
    expect(out.skipped).toEqual([{ decision_id: keep, reason: 'not an auto + undo decision' }]);
    expect(undoneEvents() - before).toBe(8);
    const final = (await roleGroups())[0] as AutoGroup;
    expect(final).toMatchObject({ undoable_ids: [], undone_count: 8 });

    // Nothing left to undo: a conflict, and nothing changes.
    expect(await e.runOp('decisions.undo_group', { decision_ids: g.decision_ids }, human)).toMatchObject({
      status: 'error',
      code: 'conflict',
    });
  });

  it('a closed undo window or a human decision is never undone by a group', async () => {
    e = openFixtureEngine();
    await scoreRun(T1);
    const g = (await roleGroups())[0] as AutoGroup;
    const [late, human_, ok] = g.decision_ids as [string, string, string];
    makeUndoable([late, ok]);
    e.db.prepare(`UPDATE decision SET undo_until = ? WHERE id = ?`).run('2026-10-08T10:00:00.000Z', late);
    e.db.prepare(`UPDATE decision SET policy_outcome = 'human' WHERE id = ?`).run(human_);
    const out = okOut(await e.runOp('decisions.undo_group', { decision_ids: [late, human_, ok] }, human));
    expect(out.undone.map((d: { id: string }) => d.id)).toEqual([ok]);
    expect(out.skipped.map((s: { decision_id: string }) => s.decision_id)).toEqual([late, human_]);
  });
});
