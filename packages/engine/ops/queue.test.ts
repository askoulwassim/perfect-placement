import type { Run } from '@perfect-placement/contracts';
import { FIXTURE_ROLE_IDS as R } from '@perfect-placement/fixtures';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeFetch, page } from '../integrations/ats/__fixtures__/fake-fetch.js';
import { ctxAt, type FixtureEngine, fakeLauncher, okOut, openFixtureEngine } from '../testing/index.js';

/*
 * The run queue and the automatic pipeline (#30) on a temp fixture vault with a fake launcher.
 */

let e: FixtureEngine;
afterEach(() => e?.cleanup());

const human = ctxAt('human');
const start = async (input: Record<string, unknown>, ctx = human) =>
  okOut(await e.runOp('runs.start', input, ctx)) as { run: Run; deduped?: boolean };
const get = async (id: string): Promise<Run> => okOut(await e.runOp('runs.get', { run_id: id }, human)).run;
const finish = (id: string, status: 'ok' | 'partial' | 'error' = 'ok', summary?: Record<string, unknown>) =>
  e.runOp('runs.finish', { run_id: id, status, ...(summary ? { summary } : {}) }, ctxAt('agent'));
const launched = () => e.launcher.specs.map((s) => s.runId);
const crit = (s: string) => Object.fromEntries([...s].map((v, i) => [`c${i + 1}`, Number(v)]));
const all = async (): Promise<Run[]> => okOut(await e.runOp('runs.list', { limit: 200 }, human)).items;

describe('run queue', () => {
  it('queues, launches at most runs.max_concurrent, then the next one oldest first when a slot frees', async () => {
    e = openFixtureEngine();
    const a = (await start({ skill: 'tailor', role_id: R.stripeOnDeck })).run;
    const b = (await start({ skill: 'tailor', role_id: R.linearDraft })).run;
    const c = (await start({ skill: 'fill', role_id: R.vercelDraft })).run;
    expect([a.status, b.status, c.status]).toEqual(['queued', 'queued', 'queued']);
    expect(launched()).toEqual([a.id, b.id]);
    expect((await get(a.id)).status).toBe('running');
    expect((await get(c.id)).status).toBe('queued');
    okOut(await finish(a.id));
    expect(launched()).toEqual([a.id, b.id, c.id]);
    const ran = await get(c.id);
    expect(ran.status).toBe('running');
    expect(ran.summary_json).toMatchObject({ actor: 'human', runner: 'claude' });
    expect(typeof (ran.summary_json as { queued_at?: unknown }).queued_at).toBe('string');
  });

  it('config runs.max_concurrent; runs.dispatch drains what fits and reports the rest', async () => {
    e = openFixtureEngine({ config: { runs: { max_concurrent: 1 } } });
    const a = (await start({ skill: 'inbox' })).run;
    const b = (await start({ skill: 'learn' })).run;
    expect(launched()).toEqual([a.id]);
    expect(okOut(await e.runOp('runs.dispatch', {}, ctxAt('schedule')))).toEqual({ launched: [], queued: 1, running: 1 });
    okOut(await finish(a.id));
    expect(launched()).toEqual([a.id, b.id]);
  });

  it('no duplicate active run for the same skill and scope; research is scoped to the company', async () => {
    e = openFixtureEngine();
    const first = await start({ skill: 'scout' });
    const again = await start({ skill: 'scout' });
    expect(again).toMatchObject({ deduped: true, run: { id: first.run.id } });
    // Another role is another scope.
    const t1 = await start({ skill: 'tailor', role_id: R.stripeOnDeck });
    const t2 = await start({ skill: 'tailor', role_id: R.stripeApplied });
    expect(t2.deduped).toBeUndefined();
    expect(t2.run.id).not.toBe(t1.run.id);
    // Two Stripe roles share one dossier: one research run.
    const r1 = await start({ skill: 'research', role_id: R.stripeOnDeck });
    expect(r1.run.summary_json).toMatchObject({ company_id: 'stripe' });
    expect(await start({ skill: 'research', role_id: R.stripeApplied })).toMatchObject({ deduped: true, run: { id: r1.run.id } });
    // Once it ends, a new one can start.
    okOut(await finish(r1.run.id));
    expect((await start({ skill: 'research', role_id: R.stripeApplied })).deduped).toBeUndefined();
  });

  it("an agent's own run is running at once, never queued, launched, deduped against or counted", async () => {
    e = openFixtureEngine({ config: { runs: { max_concurrent: 1 } } });
    const mine = (await start({ skill: 'scout' }, ctxAt('agent'))).run;
    expect(mine.status).toBe('running');
    const theirs = await start({ skill: 'scout' });
    expect(theirs.deduped).toBeUndefined();
    expect(launched()).toEqual([theirs.run.id]);
  });

  it('a runner that cannot start fails its run and frees the slot', async () => {
    const broken = fakeLauncher('spawn claude ENOENT');
    e = openFixtureEngine({ services: { launcher: broken }, config: { runs: { max_concurrent: 1 } } });
    const a = (await start({ skill: 'inbox' })).run;
    const b = (await start({ skill: 'learn' })).run;
    expect((await get(a.id)).status).toBe('error');
    expect((await get(b.id)).status).toBe('error');
    expect(broken.specs.map((s) => s.runId)).toEqual([a.id, b.id]);
  });

  it('a dry run queues and launches nothing', async () => {
    e = openFixtureEngine();
    await e.runOp('runs.start', { skill: 'scout' }, ctxAt('human', { dryRun: true }));
    expect(launched()).toEqual([]);
    expect((await all()).filter((r) => r.status === 'queued')).toHaveLength(0);
  });
});

describe('pipeline', () => {
  it('a scout that ends ok queues one score run for the inbox, linked both ways', async () => {
    e = openFixtureEngine();
    const scout = (await start({ skill: 'scout' })).run;
    const fin = okOut(await finish(scout.id, 'ok', { added: 1 })).run as Run;
    const score = (await all()).find((r) => r.op === 'score') as Run;
    expect(score).toBeDefined();
    expect(score.status).toBe('running');
    expect(score.summary_json).toMatchObject({ triggered_by: scout.id, triggered_by_skill: 'scout', actor: 'schedule' });
    expect((score.summary_json as { role_id?: string }).role_id).toBeUndefined();
    expect(fin.summary_json).toMatchObject({ triggered: [score.id] });
    expect(launched()).toEqual([scout.id, score.id]);
    expect(okOut(await e.runOp('runs.get', { run_id: scout.id }, human)).log_md).toContain(`Queued next: ${score.id}`);
  });

  it('pre-checks the inbox roles the scout added before scoring: closed ones are archived and never scored (#77)', async () => {
    const at = (p: string) => `https://careers.example.org/jobs/${p}`;
    const replies: Record<string, { status: number; body?: string }> = {
      [at('gone')]: { status: 403, body: page('Access denied') },
      [at('walled')]: { status: 403, body: page('Access denied') },
    };
    const f = fakeFetch((url) => replies[url]);
    e = openFixtureEngine({ services: { fetch: f } });
    const scout = (await start({ skill: 'scout' })).run;
    const added = okOut(
      await e.runOp(
        'roles.add',
        {
          candidates: [
            { company_name: 'Example Org', title: 'PM Gone', url: at('gone'), source: 'scout' },
            { company_name: 'Example Org', title: 'PM Walled', url: at('walled'), source: 'scout' },
          ],
        },
        ctxAt('agent', { runId: scout.id }),
      ),
    ).added as string[];
    expect(added).toEqual(['example-org_pm-gone', 'example-org_pm-walled']);
    // The posting closed after intake.
    replies[at('gone')] = { status: 404, body: page('Not found') };
    f.calls.length = 0;

    const fin = okOut(await finish(scout.id, 'ok')).run as Run;
    expect(fin.summary_json).toMatchObject({ precheck: { checked: 2, closed: 1, unsure: 1 } });
    // Only the roles this scout added; the fixture inbox roles are not fetched.
    expect(f.calls).toEqual([at('gone'), at('walled')]);
    const gone = e.db.prepare('SELECT status, archive_reason FROM role WHERE id = ?').get('example-org_pm-gone');
    expect(gone).toEqual({ status: 'archived', archive_reason: 'closed' });
    const walled = e.db.prepare('SELECT status, freshness, flags_json FROM role WHERE id = ?').get('example-org_pm-walled') as {
      status: string;
      freshness: string;
      flags_json: string;
    };
    expect(walled).toMatchObject({ status: 'inbox', freshness: 'unsure' });
    expect(JSON.parse(walled.flags_json)).toMatchObject({ unverified_checks: 1 });
    // The score run is still queued for what is left in the inbox.
    expect((await all()).find((r) => r.op === 'score')?.summary_json).toMatchObject({ triggered_by: scout.id });
    expect(okOut(await e.runOp('runs.get', { run_id: scout.id }, human)).log_md).toContain('Pre-check: 2 checked, 1 closed, 1 unsure');
  });

  it('when the pre-check closes every new role and the inbox is empty, no score run is queued', async () => {
    const url = 'https://careers.example.org/jobs/soon';
    let reply = { status: 403, body: page('Access denied') };
    e = openFixtureEngine({ services: { fetch: fakeFetch((u) => (u === url ? reply : undefined)) } });
    e.db.prepare(`UPDATE role SET status = 'archived', archive_reason = 'passed' WHERE status = 'inbox'`).run();
    const scout = (await start({ skill: 'scout' })).run;
    okOut(
      await e.runOp(
        'roles.add',
        { candidates: [{ company_name: 'Example Org', title: 'PM Soon Gone', url, source: 'scout' }] },
        ctxAt('agent', { runId: scout.id }),
      ),
    );
    reply = { status: 410, body: page('Gone') };
    const fin = okOut(await finish(scout.id, 'ok')).run as Run;
    expect(fin.summary_json).toMatchObject({ precheck: { checked: 1, closed: 1 } });
    expect((await all()).some((r) => r.op === 'score')).toBe(false);
  });

  it('a scout that fails, or with the rule off, queues nothing; an agent-run scout chains too', async () => {
    e = openFixtureEngine({ config: { pipeline: { score_after_scout: false } } });
    const off = (await start({ skill: 'scout' })).run;
    okOut(await finish(off.id));
    expect((await all()).some((r) => r.op === 'score')).toBe(false);
    e.cleanup();
    e = openFixtureEngine();
    const failed = (await start({ skill: 'scout' })).run;
    okOut(await finish(failed.id, 'error'));
    expect((await all()).some((r) => r.op === 'score')).toBe(false);
    const agent = (await start({ skill: 'scout' }, ctxAt('agent'))).run;
    okOut(await finish(agent.id));
    expect((await all()).find((r) => r.op === 'score')?.summary_json).toMatchObject({ triggered_by: agent.id });
  });

  it('a pipeline score waits behind a running all-inbox score (that one listed the inbox earlier), then runs', async () => {
    e = openFixtureEngine();
    const running = (await start({ skill: 'score' })).run;
    const scout = (await start({ skill: 'scout' })).run;
    okOut(await finish(scout.id));
    const next = (await all()).find((r) => r.op === 'score' && r.id !== running.id) as Run;
    expect(next.status).toBe('queued');
    expect(launched()).toEqual([running.id, scout.id]);
    // A second scout does not stack another one behind it.
    const scout2 = (await start({ skill: 'scout' })).run;
    okOut(await finish(scout2.id));
    expect((await all()).filter((r) => r.op === 'score')).toHaveLength(2);
    okOut(await finish(running.id));
    expect((await get(next.id)).status).toBe('running');
  });

  it('a score run queues research once per company with no dossier, for roles it kept', async () => {
    e = openFixtureEngine();
    const score = (await start({ skill: 'score' })).run;
    const inRun = ctxAt('agent', { runId: score.id });
    // Notion has no dossier: scored active -> research. Linear has one: nothing.
    okOut(await e.runOp('roles.score', { role_id: R.notionInbox, criteria: crit('555555555'), facts: { workplace: 'remote' } }, inRun));
    e.db
      .prepare(
        `INSERT INTO role (id, company_id, title, source, found_at, workplace, status, created_at, updated_at) VALUES (?, ?, ?, 'scout', ?, 'remote', 'inbox', ?, ?)`,
      )
      .run('linear_staff-pm', 'linear', 'Staff PM', '2026-10-08T08:00:00.000Z', '2026-10-08T08:00:00.000Z', '2026-10-08T08:00:00.000Z');
    okOut(await e.runOp('roles.score', { role_id: 'linear_staff-pm', criteria: crit('555555555'), facts: { workplace: 'remote' } }, inRun));
    const fin = okOut(await finish(score.id)).run as Run;
    const research = (await all()).filter((r) => r.op === 'research');
    expect(research).toHaveLength(1);
    expect(research[0]?.summary_json).toMatchObject({
      role_id: R.notionInbox,
      company_id: 'notion',
      triggered_by: score.id,
      triggered_by_skill: 'score',
    });
    expect(fin.summary_json).toMatchObject({ triggered: [research[0]?.id] });
  });

  it('archived roles and the research rule switched off queue no research', async () => {
    e = openFixtureEngine({ config: { pipeline: { research_after_score: false } } });
    const score = (await start({ skill: 'score' })).run;
    const inRun = ctxAt('agent', { runId: score.id });
    okOut(await e.runOp('roles.score', { role_id: R.notionInbox, criteria: crit('555555555'), facts: { workplace: 'remote' } }, inRun));
    okOut(await finish(score.id));
    expect((await all()).some((r) => r.op === 'research')).toBe(false);
    e.cleanup();
    e = openFixtureEngine();
    const s2 = (await start({ skill: 'score' })).run;
    okOut(
      await e.runOp(
        'roles.score',
        { role_id: R.notionInbox, criteria: crit('111111111'), facts: { workplace: 'remote' } },
        ctxAt('agent', { runId: s2.id }),
      ),
    );
    okOut(await finish(s2.id));
    expect((await all()).some((r) => r.op === 'research')).toBe(false);
  });
});
