import { FIXTURE_ROLE_IDS } from '@perfect-placement/fixtures';
import { afterEach, describe, expect, it } from 'vitest';
import { ctxAt, type FixtureEngine, fakeProfileLlm, learnKev, okOut, openFixtureEngine, tickingClock } from '../testing/index.js';

/*
 * The learn loop through runOp: profile.learn -> resolver Noulli x 11 -> writing model -> nested
 * profile.propose_diff / profile.apply_diff / profile.reject_diff -> policy (#14, #24).
 */

let e: FixtureEngine;
const clock = tickingClock('2026-10-08T13:00:00.000Z');
const agent = () => ctxAt('agent', {}, clock);
afterEach(() => e.cleanup());

/** A rejection event, as the inbox monitor writes it (human-confirmed so it applies directly). */
async function rejection(): Promise<string> {
  const role = FIXTURE_ROLE_IDS.figmaIv;
  const msg = { message_id: 'learn-1', received_at: '2026-10-08T12:30:00.000Z', role_id: role, class: 'rejection', p: 0.99 };
  okOut(await e.runOp('inbox.ingest', { messages: [msg] }, ctxAt('human', {}, clock)));
  return (e.db.prepare(`SELECT id FROM event WHERE type = 'rejection' AND subject_id = ?`).get(role) as { id: string }).id;
}
const diff = (id: string) => e.db.prepare('SELECT * FROM profile_diff WHERE id = ?').get(id) as Record<string, string>;
const decisionOf = (diffId: string) => e.db.prepare('SELECT * FROM decision WHERE subject_id = ?').get(diffId) as Record<string, string>;

describe('learn loop (profile.learn)', () => {
  it('proposes diffs and routes each by policy: dealbreakers to a human, a confident craft change auto + undo', async () => {
    e = openFixtureEngine({ kev: learnKev(['dealbreakers', 'craft', 'domain']), services: { profileLlm: fakeProfileLlm } });
    const eventId = await rejection();
    const out = okOut(await e.runOp('profile.learn', { event_id: eventId }, agent()));
    expect(e.kev.calls[0]?.questions).toHaveLength(11);
    expect(e.kev.calls[0]?.questions.every((q) => q.type === 'noulli')).toBe(true);

    // Domain: the writing model judged no change after all.
    expect(out.proposed.map((d: { component_key: string }) => d.component_key).sort()).toEqual(['craft', 'dealbreakers']);

    // Dealbreakers: a hard exclusion, queued for a human with the action that applies it.
    const dq = out.queued.find((q: { diff_id: string }) => diff(q.diff_id).component_key === 'dealbreakers');
    expect(diff(dq.diff_id)).toMatchObject({ status: 'pending', impact: 'high', event_id: eventId });
    expect(decisionOf(dq.diff_id)).toMatchObject({ policy_outcome: 'human', status: 'pending', id: dq.decision_id });

    // Craft: medium + confident -> auto + 24h undo (#14), profile v+1, 'before' from the data not the model.
    expect(out.applied).toHaveLength(1);
    const ap = out.applied[0];
    expect(JSON.parse(diff(ap.diff_id).diff_json as string).before.level).toBe('principal');
    const p = okOut(await e.runOp('profile.get', {}, agent()));
    expect(p.version).toMatchObject({ id: ap.version_id, parent_id: 'pv_0002', event_id: eventId });
    expect(p.components.find((c: { key: string }) => c.key === 'craft').data_json.level).toBe('staff');
    expect(decisionOf(ap.diff_id)).toMatchObject({ policy_outcome: 'auto_undo', status: 'applied' });
    // The applied weighted diff rescored the movable roles under v+1 (lane F).
    expect(
      (e.db.prepare('SELECT count(*) n FROM score WHERE profile_version_id = ?').get(ap.version_id) as { n: number }).n,
    ).toBeGreaterThan(0);
  });

  it('a confident "no" on the apply question rejects the diff', async () => {
    e = openFixtureEngine({
      kev: (q, req) => (req.decision === 'profile.learn' ? { value: q.id === 'craft', p: 0.97 } : { value: false, p: 0.97 }),
      services: { profileLlm: fakeProfileLlm },
    });
    const out = okOut(await e.runOp('profile.learn', { event_id: await rejection() }, agent()));
    expect(out.applied).toHaveLength(0);
    expect(diff(out.proposed[0].id).status).toBe('rejected');
  });

  it('without a writing model the resolver is still asked, and the learn skill drafts (no diffs here)', async () => {
    e = openFixtureEngine({ kev: learnKev(['craft']) });
    const out = okOut(await e.runOp('profile.learn', { event_id: await rejection() }, agent()));
    expect(e.kev.calls).toHaveLength(1);
    expect(out).toEqual({ proposed: [], applied: [], queued: [] });
  });

  it('ignores non-learning events', async () => {
    e = openFixtureEngine({ kev: learnKev(['craft']), services: { profileLlm: fakeProfileLlm } });
    okOut(await e.runOp('roles.add', { candidates: [{ company_name: 'Acme', title: 'PM', source: 'link' }] }, agent()));
    const added = (e.db.prepare(`SELECT id FROM event WHERE type = 'role_added' ORDER BY rowid DESC`).get() as { id: string }).id;
    expect(okOut(await e.runOp('profile.learn', { event_id: added }, agent()))).toEqual({ proposed: [], applied: [], queued: [] });
    expect(e.kev.calls).toHaveLength(0);
    expect(await e.runOp('profile.learn', { event_id: 'ev_nope' }, agent())).toMatchObject({ code: 'not_found' });
  });
});
