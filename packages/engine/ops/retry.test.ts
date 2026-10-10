import type { Run } from '@perfect-placement/contracts';
import { FIXTURE_NOW } from '@perfect-placement/fixtures';
import { afterEach, describe, expect, it } from 'vitest';
import { ctxAt, type FixtureEngine, okOut, openFixtureEngine } from '../testing/index.js';
import {
  backoffMs,
  CONNECTOR_RETRY,
  CONNECTOR_RETRY_DELAY_MS,
  isTransient,
  nextRetry,
  type RetryPolicy,
  type Timer,
  withRetry,
} from './retry.js';
import { CONNECTOR_SKILLS, DEFAULT_SKILLS_DIR, gmailDraftPrompt, gmailToPrompt, skillPrompt } from './runner.js';

/*
 * #122: the transient-retry helper, and the run queue re-queuing a run that ended `connector_unavailable` once after
 * the delay. Fake launcher, fake clock, fake timer: nothing spawns, nothing waits.
 */

describe('transient-retry helper', () => {
  it('codes and text patterns: connector_unavailable, stalled, idle timeout, ECONNRESET, ETIMEDOUT', () => {
    expect(isTransient({ code: 'connector_unavailable' })).toBe(true);
    expect(isTransient({ code: 'stalled' })).toBe(true);
    for (const m of [
      'gmail unavailable: search_threads failed (2x idle timeout 1068s/488s)',
      'read ECONNRESET',
      'connect ETIMEDOUT 1.2.3.4:443',
      'error: stalled',
      'connector unavailable',
    ])
      expect(isTransient({ message: m }), m).toBe(true);
    expect(isTransient({ message: 'tool denied: mcp__claude_ai_Gmail__create_draft' })).toBe(false);
    expect(isTransient({ code: 'other', message: 'portal questions unreadable' })).toBe(false);
    expect(isTransient({})).toBe(false);
    // The connector policy is code-only: free text never triggers it.
    expect(isTransient({ message: 'ECONNRESET' }, CONNECTOR_RETRY)).toBe(false);
    expect(isTransient({ code: 'stalled' }, CONNECTOR_RETRY)).toBe(false);
    expect(isTransient({ code: 'connector_unavailable' }, CONNECTOR_RETRY)).toBe(true);
  });

  it('backoff schedule and tries left (the last delay repeats)', () => {
    const p: RetryPolicy = { attempts: 4, backoffMs: [60_000, 300_000, 900_000] };
    expect([1, 2, 3, 4].map((a) => backoffMs(p, a))).toEqual([60_000, 300_000, 900_000, 900_000]);
    const now = new Date(FIXTURE_NOW);
    expect(nextRetry(p, { message: 'ECONNRESET' }, 2, now)).toEqual({
      attempt: 3,
      delayMs: 300_000,
      at: new Date(now.getTime() + 300_000),
    });
    expect(nextRetry(p, { message: 'ECONNRESET' }, 4, now)).toBeNull();
    expect(nextRetry(p, { message: 'boom' }, 1, now)).toBeNull();
    expect(nextRetry(CONNECTOR_RETRY, { code: 'connector_unavailable' }, 1, now)?.delayMs).toBe(CONNECTOR_RETRY_DELAY_MS);
    expect(nextRetry(CONNECTOR_RETRY, { code: 'connector_unavailable' }, 2, now)).toBeNull();
  });

  it('withRetry: retries transient throws with the injected sleep, rethrows the rest', async () => {
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
    };
    const policy: RetryPolicy = { attempts: 3, backoffMs: [10, 20] };
    let n = 0;
    expect(
      await withRetry(
        async (attempt) => {
          n++;
          if (attempt < 3) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
          return 'ok';
        },
        { policy: { ...policy, codes: ['ECONNRESET'] }, sleep },
      ),
    ).toBe('ok');
    expect([n, slept]).toEqual([3, [10, 20]]);
    await expect(withRetry(async () => Promise.reject(new Error('ECONNRESET')), { policy, sleep })).rejects.toThrow('ECONNRESET');
    expect(slept).toEqual([10, 20, 10, 20]);
    let m = 0;
    await expect(
      withRetry(
        async () => {
          m++;
          throw new Error('bad input');
        },
        { policy, sleep },
      ),
    ).rejects.toThrow('bad input');
    expect(m).toBe(1);
  });
});

describe('connector prompts (#122)', () => {
  it('connector skills: inbox, connect, voice (Gmail); connect, fill, voice (Chrome)', () => {
    expect([...CONNECTOR_SKILLS].sort()).toEqual(['connect', 'fill', 'inbox', 'voice']);
  });

  it('a connector skill is told to report connector_unavailable; others are not', () => {
    for (const skill of ['inbox', 'connect', 'voice', 'fill'] as const)
      expect(skillPrompt(DEFAULT_SKILLS_DIR, { runId: 'rn_1', skill }), skill).toContain('error_code: "connector_unavailable"');
    expect(skillPrompt(DEFAULT_SKILLS_DIR, { runId: 'rn_1', skill: 'learn' })).not.toContain('connector_unavailable');
    const ids = { runId: 'rn_1', outreachId: 'or_1', roleId: 'r', contactId: 'c' };
    const draft = gmailDraftPrompt(DEFAULT_SKILLS_DIR, ids);
    expect(draft).toContain('error_code: "connector_unavailable"');
    expect(draft).toContain('`outreach.gmail_draft_id` is set');
    expect(gmailToPrompt(DEFAULT_SKILLS_DIR, ids)).toContain('error_code: "connector_unavailable"');
  });
});

describe('run queue: connector retry (#122)', () => {
  let e: FixtureEngine;
  afterEach(() => e?.cleanup());

  /** A clock the test moves, and a timer that only records (fire() runs what is due). */
  function setup(config?: Record<string, unknown>) {
    let t = Date.parse(FIXTURE_NOW);
    const timers: Array<{ fn: () => void; ms: number; at: number }> = [];
    const timer: Timer = (fn, ms) => {
      timers.push({ fn, ms, at: t + ms });
    };
    e = openFixtureEngine({ services: { timer }, ...(config ? { config } : {}) });
    const now = () => new Date(t);
    const human = ctxAt('human', {}, now);
    const agent = ctxAt('agent', {}, now);
    return {
      now,
      human,
      agent,
      timers,
      advance: (ms: number) => {
        t += ms;
      },
      /** Run every due timer callback, then let its dispatch settle. */
      async fire() {
        for (const x of timers.splice(0).filter((x) => x.at <= t)) x.fn();
        await new Promise((r) => setTimeout(r, 0));
      },
      start: async (input: Record<string, unknown>) => okOut(await e.runOp('runs.start', input, human)).run as Run,
      get: async (id: string) => okOut(await e.runOp('runs.get', { run_id: id }, human)) as { run: Run; log_md: string | null },
      finish: (id: string, rest: Record<string, unknown>) => e.runOp('runs.finish', { run_id: id, ...rest }, agent),
      launched: () => e.launcher.specs.map((s) => s.runId),
    };
  }
  const unavailable = {
    status: 'error',
    error_code: 'connector_unavailable',
    error: 'connector_unavailable: mcp__claude_ai_Gmail__search_threads',
  };

  it('connector_unavailable: one retry after the delay, same inputs, linked; then ok', async () => {
    const x = setup();
    const first = await x.start({ skill: 'inbox' });
    expect(x.launched()).toEqual([first.id]);
    const done = okOut(await x.finish(first.id, unavailable)).run as Run;
    const retryId = (done.summary_json as { retried: string }).retried;
    expect(done.status).toBe('error');
    expect(done.summary_json).toMatchObject({ error_code: 'connector_unavailable', error: unavailable.error, retried: retryId });

    const retry = (await x.get(retryId)).run;
    expect(retry.status).toBe('queued');
    expect(retry.summary_json).toMatchObject({
      skill: 'inbox',
      retry_of: first.id,
      attempt: 2,
      not_before: new Date(x.now().getTime() + CONNECTOR_RETRY_DELAY_MS).toISOString(),
    });
    // Waits out the delay: a dispatch before it launches nothing.
    expect(x.launched()).toEqual([first.id]);
    expect(x.timers.map((t) => t.ms)).toEqual([CONNECTOR_RETRY_DELAY_MS]);
    x.advance(CONNECTOR_RETRY_DELAY_MS - 1000);
    okOut(await e.runOp('runs.dispatch', {}, x.human));
    expect(x.launched()).toEqual([first.id]);
    // A second click meanwhile dedupes onto the queued retry.
    expect(okOut(await e.runOp('runs.start', { skill: 'inbox' }, x.human))).toMatchObject({ deduped: true, run: { id: retryId } });

    x.advance(1000);
    await x.fire();
    expect(x.launched()).toEqual([first.id, retryId]);
    expect((await x.get(retryId)).run.status).toBe('running');
    okOut(await x.finish(retryId, { status: 'ok', summary: { classified: 2 } }));

    // Both logs show the tries.
    expect((await x.get(first.id)).log_md).toContain(`retried: ${retryId}`);
    const log = (await x.get(retryId)).log_md as string;
    expect(log).toContain(`Retry of ${first.id} (try 2 of 2): connector_unavailable`);
    expect(log).toMatch(/: ok/);
    // The failed run can't be retried again by hand through retry_of.
    expect(await e.runOp('runs.start', { skill: 'inbox', retry_of: first.id }, x.human)).toMatchObject({ code: 'conflict' });
  });

  it('a second connector_unavailable does not loop', async () => {
    const x = setup();
    const first = await x.start({ skill: 'inbox' });
    const retryId = (okOut(await x.finish(first.id, unavailable)).run.summary_json as { retried: string }).retried;
    x.advance(CONNECTOR_RETRY_DELAY_MS);
    await x.fire();
    expect(x.launched()).toEqual([first.id, retryId]);
    const again = okOut(await x.finish(retryId, unavailable)).run as Run;
    expect(again.status).toBe('error');
    expect(again.summary_json).toMatchObject({ retry_skipped: 'try 2 of 2' });
    expect((again.summary_json as { retried?: string }).retried).toBeUndefined();
    x.advance(10 * CONNECTOR_RETRY_DELAY_MS);
    await x.fire();
    okOut(await e.runOp('runs.dispatch', {}, x.human));
    expect(x.launched()).toEqual([first.id, retryId]);
    expect((await x.get(retryId)).log_md).toContain('Not retried: try 2 of 2');
  });

  it('non-transient errors, a free-text connector error, and a skill with no connector are not retried', async () => {
    const x = setup();
    const a = await x.start({ skill: 'inbox' });
    const plain = okOut(await x.finish(a.id, { status: 'error', error: 'tool denied: mcp__claude_ai_Gmail__search_threads' })).run as Run;
    expect(plain.summary_json).not.toHaveProperty('retried');
    expect(plain.summary_json).not.toHaveProperty('retry_skipped');
    const b = await x.start({ skill: 'inbox' });
    const text = okOut(await x.finish(b.id, { status: 'error', summary: { error: 'read ECONNRESET' } })).run as Run;
    expect(text.summary_json).not.toHaveProperty('retried');
    const c = await x.start({ skill: 'learn' });
    const learn = okOut(await x.finish(c.id, { status: 'error', error_code: 'connector_unavailable' })).run as Run;
    expect(learn.summary_json).toMatchObject({ retry_skipped: 'learn uses no connector' });
    x.advance(CONNECTOR_RETRY_DELAY_MS);
    await x.fire();
    expect(x.launched()).toEqual([a.id, b.id, c.id]);
    expect(x.timers).toEqual([]);
    // An agent's own run is never re-queued.
    const own = okOut(await e.runOp('runs.start', { skill: 'inbox' }, x.agent)).run as Run;
    const mine = okOut(await x.finish(own.id, unavailable)).run as Run;
    expect(mine.summary_json).not.toHaveProperty('retried');
    // runs.start refuses a retry of a run that is not a connector failure.
    expect(await e.runOp('runs.start', { skill: 'inbox', retry_of: a.id }, x.human)).toMatchObject({ code: 'conflict' });
    expect(await e.runOp('runs.start', { skill: 'tailor', retry_of: a.id }, x.human)).toMatchObject({ code: 'invalid_input' });
  });

  describe('connect Gmail draft step', () => {
    const clearPending = () =>
      e.db.prepare("UPDATE decision SET status = 'rejected' WHERE kind = 'outreach.to_gmail' AND subject_id = 'or_0001'").run();
    const draftId = () =>
      (e.db.prepare("SELECT gmail_draft_id FROM outreach WHERE id = 'or_0001'").get() as { gmail_draft_id: string | null }).gmail_draft_id;

    it('connector missing before any draft: the step is retried once, scoped to the same outreach', async () => {
      const x = setup();
      clearPending();
      const first = await x.start({ skill: 'connect', outreach_id: 'or_0001' });
      expect(first.summary_json).toMatchObject({ step: 'gmail_draft' });
      const done = okOut(await x.finish(first.id, { ...unavailable, error: 'connector_unavailable: mcp__claude_ai_Gmail__create_draft' }))
        .run as Run;
      const retryId = (done.summary_json as { retried: string }).retried;
      expect((await x.get(retryId)).run.summary_json).toMatchObject({ outreach_id: 'or_0001', step: 'gmail_draft', retry_of: first.id });
      x.advance(CONNECTOR_RETRY_DELAY_MS);
      await x.fire();
      expect(x.launched()).toEqual([first.id, retryId]);
      expect(e.launcher.specs[1]?.args.join(' ')).toContain('Gmail draft step only');
    });

    it('a draft already created (gmail_draft_id) is never created twice: no retry, no second launch', async () => {
      const x = setup();
      clearPending();
      const first = await x.start({ skill: 'connect', outreach_id: 'or_0001' });
      // The session created the draft and recorded it, then lost the connector.
      okOut(await e.runOp('outreach.to_gmail', { outreach_id: 'or_0001', gmail_draft_id: 'gd-1' }, x.human));
      const done = okOut(await x.finish(first.id, unavailable)).run as Run;
      expect(done.summary_json).toMatchObject({ retry_skipped: 'Gmail draft gd-1 already created' });
      x.advance(CONNECTOR_RETRY_DELAY_MS);
      await x.fire();
      expect(x.launched()).toEqual([first.id]);
      expect(draftId()).toBe('gd-1');
      // And a drafted outreach that somehow has a draft id is refused by runs.start itself.
      e.db.prepare("UPDATE outreach SET status = 'drafted' WHERE id = 'or_0001'").run();
      expect(await e.runOp('runs.start', { skill: 'connect', outreach_id: 'or_0001' }, x.human)).toMatchObject({ code: 'conflict' });
      expect(draftId()).toBe('gd-1');
    });

    it('a draft waiting to be recorded in Needs you is not retried either', async () => {
      const x = setup();
      // The fixture's pending outreach.to_gmail decision on or_0001 stands for a draft made but not yet recorded.
      e.db.prepare("UPDATE decision SET status = 'rejected' WHERE kind = 'outreach.to_gmail' AND subject_id = 'or_0001'").run();
      const first = await x.start({ skill: 'connect', outreach_id: 'or_0001' });
      e.db.prepare("UPDATE decision SET status = 'pending' WHERE kind = 'outreach.to_gmail' AND subject_id = 'or_0001'").run();
      const done = okOut(await x.finish(first.id, unavailable)).run as Run;
      expect(done.summary_json).toMatchObject({ retry_skipped: 'Gmail draft for or_0001 waits in Needs you' });
      expect(x.launched()).toEqual([first.id]);
    });
  });
});
