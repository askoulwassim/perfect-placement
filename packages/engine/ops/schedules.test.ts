import type { PolicyConfig, Run, ScheduleJobState, ScheduleKey } from '@perfect-placement/contracts';
import { FIXTURE_NOW, FIXTURE_ROLE_IDS as R } from '@perfect-placement/fixtures';
import { afterEach, describe, expect, it } from 'vitest';
import { ctxAt, type FixtureEngine, okOut, openFixtureEngine } from '../testing/index.js';
import { catchUpSchedules, lastScheduledRun } from './schedules.js';
import type { ScheduleJobs } from './services.js';

/*
 * Schedules (#29) and run-linked events (#50), engine side, on a temp fixture vault (fake launcher).
 */

let e: FixtureEngine;
afterEach(() => e?.cleanup());

const human = ctxAt('human');
const crit = (s: string) => Object.fromEntries([...s].map((v, i) => [`c${i + 1}`, Number(v)]));
/** The fixture vault has one open inbox run; close it so inbox runs are not deduped onto it. */
const quiet = () => e.runOp('runs.finish', { run_id: 'rn_0003', status: 'ok' }, ctxAt('agent'));
const all = async (): Promise<Run[]> => okOut(await e.runOp('runs.list', { limit: 200 }, human)).items;

function fakeJobs(states: Partial<Record<ScheduleKey, ScheduleJobState>> = {}) {
  const synced: PolicyConfig['schedules'][] = [];
  const jobs: ScheduleJobs = {
    status: () => ({ inbox: 'installed', freshness: 'installed', scout_score: 'installed', ...states }),
    sync: async (s) => {
      synced.push(s);
    },
  };
  return { jobs, synced };
}

describe('schedules (#29)', () => {
  it('runs.start keeps the schedule; a schedule for another skill is refused', async () => {
    e = openFixtureEngine();
    const run = okOut(await e.runOp('runs.start', { skill: 'scout', schedule: 'scout_score' }, ctxAt('schedule'))).run;
    expect(run.summary_json).toMatchObject({ schedule: 'scout_score', actor: 'schedule' });
    expect(lastScheduledRun(e.db, 'scout_score')?.id).toBe(run.id);
    expect(lastScheduledRun(e.db, 'inbox')).toBeNull();
    const bad = await e.runOp('runs.start', { skill: 'inbox', schedule: 'scout_score' }, ctxAt('schedule'));
    expect(bad).toMatchObject({ status: 'error', code: 'invalid_input' });
  });

  it('schedules.status: next run, last scheduled run, job state (unknown without a job manager)', async () => {
    e = openFixtureEngine({ config: { schedules: { inbox: 'daily 07:30', freshness: 'off', scout_score: 'fri 05:30' } } });
    okOut(await quiet());
    const run = okOut(await e.runOp('runs.start', { skill: 'inbox', schedule: 'inbox' }, ctxAt('schedule'))).run;
    okOut(await e.runOp('runs.finish', { run_id: run.id, status: 'error', summary: { error: 'x' } }, ctxAt('agent')));
    const items = okOut(await e.runOp('schedules.status', {}, human)).items;
    expect(items.map((s) => [s.key, s.skill, s.on, s.job])).toEqual([
      ['inbox', 'inbox', true, 'unknown'],
      ['freshness', 'freshness', false, 'unknown'],
      ['scout_score', 'scout', true, 'unknown'],
    ]);
    const now = new Date(FIXTURE_NOW);
    const next = new Date(items[0]?.next_run as string);
    expect(next > now && next.getTime() - now.getTime() <= 86_400_000).toBe(true);
    expect([next.getHours(), next.getMinutes()]).toEqual([7, 30]);
    expect(new Date(items[2]?.next_run as string).getDay()).toBe(5);
    expect(items[1]?.next_run).toBeNull();
    expect(items[0]?.last_run).toMatchObject({ id: run.id, status: 'error' });
    expect(items[2]?.last_run).toBeNull();
  });

  it('config.update syncs the OS jobs after commit when the schedules change, and only then', async () => {
    const { jobs, synced } = fakeJobs({ freshness: 'missing' });
    e = openFixtureEngine({ services: { scheduleJobs: jobs } });
    expect(okOut(await e.runOp('schedules.status', {}, human)).items.map((s) => s.job)).toEqual(['installed', 'missing', 'installed']);
    okOut(await e.runOp('config.update', { patch: { policy: { auto: 0.91 } } }, human));
    expect(synced).toEqual([]);
    okOut(await e.runOp('config.update', { patch: { schedules: { inbox: 'off' } } }, human));
    expect(synced).toHaveLength(1);
    expect(synced[0]?.inbox).toBe('off');
    okOut(await e.runOp('config.update', { patch: { schedules: { inbox: 'off' } } }, { ...human, dryRun: true }));
    expect(synced).toHaveLength(1);
  });

  it('catch-up: a schedule that fired since its last run is queued once; never-run, active and off are left alone', async () => {
    e = openFixtureEngine({ config: { schedules: { inbox: 'daily 07:30', freshness: 'daily 06:30', scout_score: 'off' } } });
    okOut(await quiet());
    const at = (iso: string) => ctxAt('schedule', {}, iso);
    // inbox last ran three days ago: missed. freshness never ran: left alone.
    const old = okOut(await e.runOp('runs.start', { skill: 'inbox', schedule: 'inbox' }, at('2026-10-05T12:00:00.000Z'))).run;
    okOut(await e.runOp('runs.finish', { run_id: old.id, status: 'ok' }, ctxAt('agent')));
    const now = () => new Date(FIXTURE_NOW);
    const config = (await e.runOp('config.get', {}, human)) as { output: PolicyConfig };
    const caught = await catchUpSchedules(e.db, e.runOp, config.output, now);
    expect(caught.map((c) => c.key)).toEqual(['inbox']);
    const run = (await all()).find((r) => r.id === caught[0]?.run_id);
    expect(run?.summary_json).toMatchObject({ schedule: 'inbox', actor: 'schedule' });
    // Its last run is now active: a second pp up start queues nothing.
    expect(await catchUpSchedules(e.db, e.runOp, config.output, now)).toEqual([]);
  });
});

describe('runs and their ops (#50)', () => {
  it('ops with ctx.runId record the run id on their events', async () => {
    e = openFixtureEngine();
    okOut(await e.runOp('roles.move', { role_id: R.notionInbox, to: 'active' }, human));
    const run = okOut(await e.runOp('runs.start', { skill: 'tailor', role_id: R.notionInbox }, ctxAt('agent'))).run;
    const inRun = ctxAt('agent', { runId: run.id });
    okOut(await e.runOp('apply.tailor', { role_id: R.notionInbox, resume_md: '# R', cover_letter_md: '# C', fit_map_md: '# F' }, inRun));
    const tailored = e.db
      .prepare(`SELECT json_extract(payload_json, '$.run_id') run_id FROM event WHERE type = 'application_tailored' AND subject_id = ?`)
      .all(R.notionInbox) as { run_id: string | null }[];
    expect(tailored.map((t) => t.run_id)).toEqual([run.id]);
  });

  it('research rule: a queue score run uses the link only; roles scored by another session in its window do not count', async () => {
    e = openFixtureEngine();
    const score = okOut(await e.runOp('runs.start', { skill: 'score' }, human)).run;
    // Scored in the run's time window, but not by the run (no run id).
    okOut(
      await e.runOp('roles.score', { role_id: R.notionInbox, criteria: crit('555555555'), facts: { workplace: 'remote' } }, ctxAt('agent')),
    );
    okOut(await e.runOp('runs.finish', { run_id: score.id, status: 'ok' }, ctxAt('agent')));
    expect((await all()).some((r) => r.op === 'research')).toBe(false);
  });

  it("research rule: an agent's own run with no linked events falls back to the time window", async () => {
    e = openFixtureEngine();
    const score = okOut(await e.runOp('runs.start', { skill: 'score' }, ctxAt('agent'))).run;
    okOut(
      await e.runOp('roles.score', { role_id: R.notionInbox, criteria: crit('555555555'), facts: { workplace: 'remote' } }, ctxAt('agent')),
    );
    okOut(await e.runOp('runs.finish', { run_id: score.id, status: 'ok' }, ctxAt('agent')));
    const research = (await all()).filter((r) => r.op === 'research');
    expect(research.map((r) => r.summary_json)).toEqual([expect.objectContaining({ company_id: 'notion', triggered_by: score.id })]);
  });
});
