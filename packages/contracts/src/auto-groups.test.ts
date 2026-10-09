import { describe, expect, it } from 'vitest';
import { AUTO_GROUP_WINDOW_MS, groupAutoDecisions } from './auto-groups.js';
import type { Decision } from './entities.js';

/* #103: the pure grouping of the auto stream (runs, the no-run time window, kinds, batch kinds). */

const NOW = new Date('2026-10-08T12:00:00.000Z');
let n = 0;
const dec = (over: Partial<Decision>): Decision => ({
  id: `dc_${String(++n).padStart(4, '0')}`,
  ts: '2026-10-08T10:00:00.000Z',
  kind: 'roles.criterion',
  subject_type: 'role',
  subject_id: 'r1',
  question_json: {},
  backend: 'kev',
  answer_json: {},
  p: 0.9,
  impact: 'low',
  policy_outcome: 'auto',
  status: 'applied',
  human_choice: null,
  overridden: false,
  undo_until: null,
  resolved_at: null,
  latency_ms: 0,
  action_json: null,
  ...over,
});
const at = (min: number) => new Date(Date.parse('2026-10-08T10:00:00.000Z') + min * 60_000).toISOString();

describe('groupAutoDecisions (#103)', () => {
  it('one run: nine criteria of one role are one group', () => {
    const ds = Array.from({ length: 9 }, () => dec({}));
    const gs = groupAutoDecisions(ds, NOW, { runOf: () => 'rn_1', totalOf: () => 82 });
    expect(gs).toHaveLength(1);
    expect(gs[0]).toMatchObject({ count: 9, run_id: 'rn_1', total: 82, backend: 'kev', subject_id: 'r1' });
  });

  it('two runs are two groups; mixed kinds never share one', () => {
    const a = Array.from({ length: 3 }, () => dec({ ts: at(0) }));
    const b = Array.from({ length: 3 }, () => dec({ ts: at(1) }));
    const f = dec({ kind: 'freshness.closed', ts: at(1) });
    const runs = new Map([...a.map((d) => [d.id, 'rn_a']), ...b.map((d) => [d.id, 'rn_b']), [f.id, 'rn_b']] as [string, string][]);
    const gs = groupAutoDecisions([...a, ...b, f], NOW, { runOf: (d) => runs.get(d.id) ?? null });
    expect(gs.map((g) => [g.kind, g.run_id, g.count])).toEqual(
      expect.arrayContaining([
        ['roles.criterion', 'rn_a', 3],
        ['roles.criterion', 'rn_b', 3],
        ['freshness.closed', 'rn_b', 1],
      ]),
    );
    expect(gs).toHaveLength(3);
  });

  it('no run id: subject + kind + a chained time window', () => {
    const near = [dec({ ts: at(0) }), dec({ ts: at(5) }), dec({ ts: at(12) })];
    const far = dec({ ts: new Date(Date.parse(at(12)) + AUTO_GROUP_WINDOW_MS + 1).toISOString() });
    const other = dec({ ts: at(1), subject_id: 'r2' });
    const gs = groupAutoDecisions([...near, far, other], NOW);
    expect(gs.map((g) => [g.subject_id, g.count])).toEqual([
      ['r1', 1],
      ['r1', 3],
      ['r2', 1],
    ]);
  });

  it('batch kinds group across subjects; backend is the majority, else mixed; undoable members listed', () => {
    const c = [
      dec({ kind: 'people.classify', subject_type: 'contact', subject_id: 'c1', backend: 'kev' }),
      dec({ kind: 'people.classify', subject_type: 'contact', subject_id: 'c2', backend: 'rule' }),
    ];
    const [g] = groupAutoDecisions(c, NOW);
    expect(g).toMatchObject({ count: 2, subject_id: null, subject_type: 'contact', backend: 'mixed' });
    const u = dec({ policy_outcome: 'auto_undo', undo_until: '2026-10-09T00:00:00.000Z' });
    const late = dec({ policy_outcome: 'auto_undo', undo_until: '2026-10-08T11:00:00.000Z' });
    const [h] = groupAutoDecisions([u, late, dec({})], NOW);
    expect(h).toMatchObject({ count: 3, undoable_ids: [u.id], backend: 'kev' });
  });
});
