import type { Run } from '@perfect-placement/contracts';
import { FIXTURE_NOW } from '@perfect-placement/fixtures';
import { afterEach, describe, expect, it } from 'vitest';
import { doctor } from '../db/doctor.js';
import { readConfig } from '../db/vault.js';
import { ctxAt, type FixtureEngine, fakeLauncher, okOut, openFixtureEngine } from '../testing/index.js';
import { CONNECTOR_RETRY_DELAY_MS, retryPolicyFor, SCHEDULE_RETRY, STALL_LIMIT_MS, type Timer, transientMarker } from './retry.js';
import { catchUpSchedules } from './schedules.js';
import { capStalledRuns } from './stale-runs.js';

/*
 * #121: scheduled runs survive a sleeping machine. Transient failures of a scheduled run (or one chained or retried
 * from it) are retried under SCHEDULE_RETRY (1, 5, 15 min), a scheduled run past its skill's cap is killed and finished
 * `stalled`, the catch-up re-queues a schedule whose retries are spent, and doctor shows the last failure. Fake
 * launcher, clock, timer and kill: nothing spawns, nothing waits.
 */

const MIN = 60_000;

describe('scheduled retry policy (#121)', () => {
  it('one policy per run: scheduled (or chained from a schedule) vs any other queue run', () => {
    expect(retryPolicyFor({ schedule: 'inbox' })).toBe(SCHEDULE_RETRY);
    expect(retryPolicyFor({ schedule_origin: 'scout_score' })).toBe(SCHEDULE_RETRY);
    expect(retryPolicyFor({}).backoffMs).toEqual([CONNECTOR_RETRY_DELAY_MS]);
    expect(SCHEDULE_RETRY).toMatchObject({ attempts: 4, backoffMs: [MIN, 5 * MIN, 15 * MIN] });
    expect(STALL_LIMIT_MS).toMatchObject({ inbox: 10 * MIN, freshness: 20 * MIN, scout: 15 * MIN, score: 15 * MIN, tailor: 10 * MIN });
    expect(transientMarker('API Error: read ECONNRESET at ...')).toBe('ECONNRESET');
    expect(transientMarker('all good')).toBeNull();
  });
});

describe('run queue: scheduled runs (#121)', () => {
  let e: FixtureEngine;
  afterEach(() => e?.cleanup());

  function setup(opts: { launcher?: ReturnType<typeof fakeLauncher> } = {}) {
    let t = Date.parse(FIXTURE_NOW);
    const timers: Array<{ fn: () => void; ms: number; at: number }> = [];
    const timer: Timer = (fn, ms) => {
      timers.push({ fn, ms, at: t + ms });
    };
    e = openFixtureEngine({ services: { timer, ...(opts.launcher ? { launcher: opts.launcher } : {}) } });
    const now = () => new Date(t);
    const human = ctxAt('human', {}, now);
    const schedule = ctxAt('schedule', {}, now);
    const agent = ctxAt('agent', {}, now);
    const launcher = opts.launcher ?? e.launcher;
    return {
      now,
      human,
      timers,
      advance: (ms: number) => {
        t += ms;
      },
      async fire() {
        for (const x of timers.splice(0).filter((x) => x.at <= t)) x.fn();
        await new Promise((r) => setTimeout(r, 0));
      },
      scheduled: async (skill = 'inbox', schedule_key = 'inbox') =>
        okOut(await e.runOp('runs.start', { skill, schedule: schedule_key }, schedule)).run as Run,
      start: async (input: Record<string, unknown>) => okOut(await e.runOp('runs.start', input, human)).run as Run,
      get: async (id: string) => okOut(await e.runOp('runs.get', { run_id: id }, human)) as { run: Run; log_md: string | null },
      finish: (id: string, rest: Record<string, unknown>) => e.runOp('runs.finish', { run_id: id, ...rest }, agent),
      launched: () => launcher.specs.map((s) => s.runId),
      retriedOf: (r: Run) => (r.summary_json as { retried?: string }).retried,
    };
  }
  const reset = { status: 'error', summary: { error: 'gmail search_threads failed: read ECONNRESET' } };

  it('a transient failure is retried after 1, 5 and 15 min, each try linked and logged, and ends ok', async () => {
    const x = setup();
    const first = await x.scheduled();
    expect(x.launched()).toEqual([first.id]);
    const ids = [first.id];
    for (const [i, wait] of [MIN, 5 * MIN, 15 * MIN].entries()) {
      const failed = okOut(await x.finish(ids[i] as string, reset)).run as Run;
      const next = x.retriedOf(failed) as string;
      expect(next, `try ${i + 1}`).toBeDefined();
      const retry = (await x.get(next)).run;
      expect(retry.summary_json).toMatchObject({
        retry_of: ids[i],
        attempt: i + 2,
        schedule: 'inbox',
        not_before: new Date(x.now().getTime() + wait).toISOString(),
      });
      expect(x.timers.map((t) => t.ms)).toEqual([wait]);
      // Not before its delay.
      x.advance(wait - 1000);
      okOut(await e.runOp('runs.dispatch', {}, x.human));
      expect(x.launched()).toEqual(ids);
      x.advance(1000);
      await x.fire();
      ids.push(next);
      expect(x.launched()).toEqual(ids);
      expect((await x.get(next)).log_md).toContain(`Retry of ${ids[i]} (try ${i + 2} of 4)`);
    }
    okOut(await x.finish(ids[3] as string, { status: 'ok', summary: { classified: 3 } }));
    expect((await x.get(ids[3] as string)).run.status).toBe('ok');
    expect((await x.get(first.id)).log_md).toContain(`retried: ${ids[1]} (try 2 of 4`);
  });

  it('after the last try the run stays error; the catch-up queues the schedule again; doctor shows it', async () => {
    const x = setup();
    let id = (await x.scheduled()).id;
    for (let i = 0; i < 3; i++) {
      const next = x.retriedOf(okOut(await x.finish(id, reset)).run as Run) as string;
      x.advance(SCHEDULE_RETRY.backoffMs[i] as number);
      await x.fire();
      id = next;
    }
    const last = okOut(await x.finish(id, { status: 'error', error_code: 'stalled', error: 'stalled: inbox ran past its 10 min cap' }))
      .run as Run;
    expect(last.status).toBe('error');
    expect(last.summary_json).toMatchObject({ attempt: 4, retry_skipped: 'try 4 of 4' });
    expect(x.timers).toEqual([]);
    expect(doctor({ home: e.home, db: e.db }).checks.find((c) => c.name === 'scheduled_failures')).toEqual({
      name: 'scheduled_failures',
      ok: true,
      detail: `inbox stalled ${x.now().toISOString().slice(0, 10)} ${x.now().toISOString().slice(11, 16)}Z try 4`,
    });
    // The schedule did not fire again, but its last run failed for good: catch-up queues it once.
    x.advance(30 * MIN);
    const caught = await catchUpSchedules(e.db, e.runOp, readConfig(e.home), x.now);
    expect(caught.map((c) => c.key)).toEqual(['inbox']);
    // Still active: a second catch-up leaves it alone.
    expect(await catchUpSchedules(e.db, e.runOp, readConfig(e.home), x.now)).toEqual([]);
    const again = caught[0]?.run_id as string;
    okOut(await x.finish(again, { status: 'ok' }));
    expect(doctor({ home: e.home, db: e.db }).checks.find((c) => c.name === 'scheduled_failures')?.detail).toMatch(/ \(ok since\)$/);
  });

  it('a non-transient failure of a scheduled run is not retried, and catch-up leaves it to the next fire', async () => {
    const x = setup();
    const r = await x.scheduled();
    const done = okOut(await x.finish(r.id, { status: 'error', error: 'tool denied: mcp__claude_ai_Gmail__search_threads' })).run as Run;
    expect(done.summary_json).not.toHaveProperty('retried');
    expect(done.summary_json).not.toHaveProperty('retry_skipped');
    expect(x.timers).toEqual([]);
    expect(await catchUpSchedules(e.db, e.runOp, readConfig(e.home), x.now)).toEqual([]);
  });

  it('no double retry: a scheduled connector_unavailable follows the schedule policy only; a human run keeps 45 s once', async () => {
    const x = setup();
    const unavailable = { status: 'error', error_code: 'connector_unavailable', error: 'connector_unavailable: gmail' };
    const s = await x.scheduled();
    const sRetry = x.retriedOf(okOut(await x.finish(s.id, unavailable)).run as Run) as string;
    expect(x.timers.map((t) => t.ms)).toEqual([MIN]);
    expect((await x.get(sRetry)).run.summary_json).toMatchObject({ attempt: 2, retry_of: s.id });
    // Exactly one queued retry for the failed run.
    const retries = e.db.prepare("SELECT id FROM run WHERE json_extract(summary_json, '$.retry_of') = ?").all(s.id);
    expect(retries).toHaveLength(1);
    x.advance(MIN);
    await x.fire();
    // The second try fails the same way: the schedule policy retries again (5 min), where #122 would have stopped.
    const third = x.retriedOf(okOut(await x.finish(sRetry, unavailable)).run as Run);
    expect(third).toBeDefined();
    expect(x.timers.map((t) => t.ms)).toEqual([5 * MIN]);
    x.timers.length = 0;

    // A human's run: #122's policy, once after 45 s, never the schedule backoff; free text is not retried.
    const h = await x.start({ skill: 'voice' });
    const hRetry = x.retriedOf(okOut(await x.finish(h.id, unavailable)).run as Run) as string;
    expect(x.timers.map((t) => t.ms)).toEqual([CONNECTOR_RETRY_DELAY_MS]);
    x.advance(CONNECTOR_RETRY_DELAY_MS);
    await x.fire();
    const hDone = okOut(await x.finish(hRetry, unavailable)).run as Run;
    expect(hDone.summary_json).toMatchObject({ retry_skipped: 'try 2 of 2' });
    const plain = await x.start({ skill: 'learn' });
    expect(okOut(await x.finish(plain.id, reset)).run.summary_json).not.toHaveProperty('retried');
  });

  it('runs a scheduled run chains are scheduled too: a score after a scheduled scout is retried by the schedule policy', async () => {
    const x = setup();
    const scout = await x.scheduled('scout', 'scout_score');
    const done = okOut(await x.finish(scout.id, { status: 'ok', summary: { added: 0 } })).run as Run;
    const scoreId = ((done.summary_json as { triggered?: string[] }).triggered ?? [])[0] as string;
    expect(scoreId).toBeDefined();
    const score = (await x.get(scoreId)).run;
    expect(score.summary_json).toMatchObject({ schedule_origin: 'scout_score' });
    expect(score.summary_json).not.toHaveProperty('schedule');
    await x.fire();
    if (score.status === 'queued') okOut(await e.runOp('runs.dispatch', {}, x.human));
    const failed = okOut(await x.finish(scoreId, { status: 'error', error: 'idle timeout after 488s' })).run as Run;
    const retry = (await x.get(x.retriedOf(failed) as string)).run;
    expect(retry.summary_json).toMatchObject({ schedule_origin: 'scout_score', retry_of: scoreId, attempt: 2 });
  });

  it('a runner that dies on ECONNRESET without finishing is retried', async () => {
    let exit: () => void = () => {};
    const after = new Promise<void>((r) => {
      exit = r;
    });
    const launcher = fakeLauncher(undefined, { result: { code: 1, output: 'Error: read ECONNRESET' }, exitAfter: after });
    const x = setup({ launcher });
    const r = await x.scheduled();
    exit();
    await Promise.all(launcher.exited);
    await new Promise((res) => setTimeout(res, 10));
    const failed = (await x.get(r.id)).run;
    expect(failed.status).toBe('error');
    expect((failed.summary_json as { error: string }).error).toContain('(ECONNRESET)');
    expect(x.retriedOf(failed)).toBeDefined();
  });

  it('stall cap: a scheduled run past its cap is killed, finished stalled, then retried; others are left alone', async () => {
    const x = setup();
    const inbox = await x.scheduled();
    const human = await x.start({ skill: 'voice' });
    expect(x.launched()).toEqual([inbox.id, human.id]);
    const killed: string[] = [];
    const kill = (r: Run) => {
      killed.push(r.id);
    };
    x.advance(10 * MIN);
    expect(await capStalledRuns(e.runOp, { now: x.now, kill })).toEqual([]);
    x.advance(1000);
    expect(await capStalledRuns(e.runOp, { now: x.now, kill })).toEqual([inbox.id]);
    expect(killed).toEqual([inbox.id]);
    const stalled = (await x.get(inbox.id)) as { run: Run; log_md: string };
    expect(stalled.run.status).toBe('error');
    expect(stalled.run.summary_json).toMatchObject({ error_code: 'stalled', error: 'stalled: inbox ran past its 10 min cap' });
    expect(stalled.log_md).toContain('The runner was stopped');
    const retryId = x.retriedOf(stalled.run) as string;
    expect((await x.get(retryId)).run.summary_json).toMatchObject({ retry_of: inbox.id, attempt: 2 });
    expect(x.timers.map((t) => t.ms)).toEqual([MIN]);
    // The human's run is not capped, however long it runs.
    x.advance(60 * MIN);
    expect(await capStalledRuns(e.runOp, { now: x.now, kill })).toEqual([]);
    expect((await x.get(human.id)).run.status).toBe('running');
    // A runner that ends on its own after the kill finds its run already finished: nothing changes.
    expect(await x.finish(inbox.id, { status: 'ok' })).toMatchObject({ code: 'conflict' });
  });
});
