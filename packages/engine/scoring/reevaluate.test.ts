import type { OpContext, OpOutput } from '@perfect-placement/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { ctxAt, type FixtureEngine, okOut, openFixtureEngine } from '../testing/index.js';

/*
 * #83: roles archived by the old work-mode rule are re-checked against the current profile.
 * Synthetic fixtures only; the profile edit is test setup on the temp vault's db.
 */

const HYBRID_NYC = 'notion_product-lead-data-platform'; // inbox, fixture workplace hybrid
const ONSITE = 'snowflake_principal-pm-ai-observability'; // inbox
const NOW = '2026-10-08T12:00:00.000Z';
const agent: OpContext = ctxAt('agent', {}, NOW);
const human: OpContext = ctxAt('human', {}, NOW);
const FIVES = Object.fromEntries(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'].map((c) => [c, 5]));

let e: FixtureEngine;
afterEach(() => e.cleanup());

const role = (id: string) =>
  e.db.prepare('SELECT status, archive_reason FROM role WHERE id = ?').get(id) as { status: string; archive_reason: string | null };
const restoreDecisions = () =>
  e.db.prepare(`SELECT * FROM decision WHERE kind = 'roles.move' ORDER BY rowid`).all() as Array<{
    id: string;
    status: string;
    policy_outcome: string;
    subject_id: string;
    action_json: string;
  }>;

/** The owner edits Work mode: remote preferred, New York accepted, remote only no longer set. */
function setWorkMode(data: Record<string, unknown>) {
  const v = e.db.prepare('SELECT id FROM profile_version ORDER BY created_at DESC, id DESC LIMIT 1').get() as { id: string };
  e.db.prepare(`UPDATE profile_component SET data_json = ? WHERE version_id = ? AND key = 'work_mode'`).run(JSON.stringify(data), v.id);
}

async function archiveUnderRemoteOnly() {
  // The fixture profile is explicitly remote only: hybrid NYC and onsite both archive.
  const a = okOut(
    await e.runOp('roles.score', { role_id: HYBRID_NYC, criteria: FIVES, facts: { workplace: 'hybrid', location: 'New York, NY' } }, agent),
  );
  expect(a.status).toBe('archived');
  expect(a.score.facts_json.dealbreaker_hits).toEqual(['remote_required']);
  const b = okOut(
    await e.runOp('roles.score', { role_id: ONSITE, criteria: FIVES, facts: { workplace: 'onsite', location: 'New York, NY' } }, agent),
  );
  expect(b.status).toBe('archived');
  expect(b.score.facts_json.dealbreaker_hits).toEqual(['work_mode_hard_no']); // "onsite only" hard no
}

const run = async (input: Record<string, unknown>, c: OpContext = human) =>
  okOut(await e.runOp('roles.reevaluate_filters', input, c)) as OpOutput<'roles.reevaluate_filters'>;

describe('roles.reevaluate_filters (#83)', () => {
  it('dry run lists what would be queued and writes nothing', async () => {
    e = openFixtureEngine();
    await archiveUnderRemoteOnly();
    setWorkMode({ modes: ['remote'], locations: ['New York', 'US remote'] });
    const out = await run({ dry_run: true });
    const byId = Object.fromEntries(out.items.map((i) => [i.role_id, i]));
    expect(byId[HYBRID_NYC]).toMatchObject({
      old_hits: ['remote_required'],
      hits: [],
      passes: true,
      band: 'green',
      decision_id: null,
      skipped: 'dry_run',
    });
    expect(byId[ONSITE]).toMatchObject({ old_hits: ['work_mode_hard_no'], hits: ['work_mode_hard_no'], passes: false, skipped: 'fails' });
    // Archives with other hits (the fixture's judged ad-tech archive) are not work-mode archives.
    expect(out.items.map((i) => i.role_id).sort()).toEqual([HYBRID_NYC, ONSITE].sort());
    expect(out.queued).toBe(0);
    expect(restoreDecisions()).toHaveLength(0);
    expect(role(HYBRID_NYC)).toEqual({ status: 'archived', archive_reason: 'dealbreaker' });
  });

  it('queues one Needs-you restore per passing role, never auto; resolving it rescores the role', async () => {
    e = openFixtureEngine();
    await archiveUnderRemoteOnly();
    setWorkMode({ modes: ['remote'], locations: ['New York', 'US remote'] });

    // Even a confident agent cannot restore on its own.
    const out = await run({}, ctxAt('agent', { confidence: { p: 0.99, backend: 'agent' } }, NOW));
    expect(out.queued).toBe(1);
    const item = out.items.find((i) => i.role_id === HYBRID_NYC);
    expect(item?.decision_id).toBeTruthy();
    const [d] = restoreDecisions();
    expect(d).toMatchObject({ id: item?.decision_id, status: 'pending', policy_outcome: 'human', subject_id: HYBRID_NYC });
    expect(JSON.parse(d?.action_json ?? '{}')).toMatchObject({
      op: 'roles.score',
      input: { role_id: HYBRID_NYC, rescore: true },
      when: true,
    });
    expect(role(HYBRID_NYC).status).toBe('archived');

    // A second pass does not duplicate it.
    const again = await run({});
    expect(again.queued).toBe(0);
    expect(again.items.find((i) => i.role_id === HYBRID_NYC)?.skipped).toBe('pending');
    expect(restoreDecisions()).toHaveLength(1);

    okOut(await e.runOp('decisions.resolve', { decision_id: d?.id, action: 'accept' }, human));
    expect(['active', 'held']).toContain(role(HYBRID_NYC).status);
    expect(role(ONSITE)).toEqual({ status: 'archived', archive_reason: 'dealbreaker' });
  });

  it('declining keeps the role archived', async () => {
    e = openFixtureEngine();
    await archiveUnderRemoteOnly();
    setWorkMode({ modes: ['remote'], locations: ['New York'] });
    const out = await run({ role_ids: [HYBRID_NYC] });
    expect(out.items).toHaveLength(1);
    okOut(await e.runOp('decisions.resolve', { decision_id: out.items[0]?.decision_id, action: 'change', value: false }, human));
    expect(role(HYBRID_NYC)).toEqual({ status: 'archived', archive_reason: 'dealbreaker' });
  });

  it('an explicit remote-only profile still fails them: nothing queued', async () => {
    e = openFixtureEngine();
    await archiveUnderRemoteOnly();
    const out = await run({});
    expect(out.items.find((i) => i.role_id === HYBRID_NYC)).toMatchObject({ passes: false, hits: ['remote_required'], skipped: 'fails' });
    expect(out.queued).toBe(0);
  });
});
