import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runnerAlive, runnerDir } from '../runners/launcher.js';
import { ctxAt, type FixtureEngine, okOut, openFixtureEngine } from '../testing/index.js';
import { INTERRUPTED, interruptStaleRuns } from './stale-runs.js';

let e: FixtureEngine;
beforeEach(() => {
  e = openFixtureEngine();
});
afterEach(() => e.cleanup());

const later = (ms: number) => () => new Date(Date.parse('2026-10-08T12:00:00.000Z') + ms);
const get = async (id: string) => okOut(await e.runOp('runs.get', { run_id: id }, ctxAt())).run;

describe('interruptStaleRuns (#21)', () => {
  it('finishes launched runs whose runner is gone as error "interrupted", leaves the rest', async () => {
    const dead = okOut(await e.runOp('runs.start', { skill: 'scout' }, ctxAt('human'))).run;
    const alive = okOut(await e.runOp('runs.start', { skill: 'inbox' }, ctxAt('schedule'))).run;
    const agent = okOut(await e.runOp('runs.start', { skill: 'tailor' }, ctxAt('agent'))).run;
    const ids = await interruptStaleRuns(e.runOp, { isAlive: (r) => r.id === alive.id, now: later(120_000) });
    expect(ids).toEqual([dead.id]);
    const d = await get(dead.id);
    expect(d).toMatchObject({ status: 'error', finished_at: expect.any(String) });
    expect(d.summary_json).toMatchObject({ error: INTERRUPTED, skill: 'scout' });
    const log = okOut(await e.runOp('runs.get', { run_id: dead.id }, ctxAt())).log_md;
    expect(log).toContain('Interrupted');
    expect((await get(alive.id)).status).toBe('running');
    // An agent session's own run and the fixture's in-process run (no runner) are not ours to close.
    expect((await get(agent.id)).status).toBe('running');
    expect((await get('rn_0003')).status).toBe('running');
    // Idempotent.
    expect(await interruptStaleRuns(e.runOp, { isAlive: () => false, now: later(120_000) })).toEqual([alive.id]);
    expect(await interruptStaleRuns(e.runOp, { isAlive: () => false, now: later(120_000) })).toEqual([]);
  });

  it('leaves a run inside the grace period (its pid may not be written yet)', async () => {
    const r = okOut(await e.runOp('runs.start', { skill: 'scout' }, ctxAt('human'))).run;
    expect(await interruptStaleRuns(e.runOp, { isAlive: () => false, now: later(5_000) })).toEqual([]);
    expect((await get(r.id)).status).toBe('running');
  });
});

describe('runs: queued (#21, ahead of the run queue #30)', () => {
  it('a queued run can be finished; runs.finish never sets queued or running', async () => {
    e.db
      .prepare(
        `INSERT INTO run (id, op, started_at, finished_at, status, summary_json, log_path) VALUES ('rn_q', 'score', '2026-10-08T11:00:00.000Z', NULL, 'queued', '{}', NULL)`,
      )
      .run();
    expect(await e.runOp('runs.finish', { run_id: 'rn_q', status: 'queued' }, ctxAt())).toMatchObject({ code: 'invalid_input' });
    expect(await e.runOp('runs.finish', { run_id: 'rn_q', status: 'running' }, ctxAt())).toMatchObject({ code: 'invalid_input' });
    const fin = okOut(await e.runOp('runs.finish', { run_id: 'rn_q', status: 'error', summary: { error: 'cancelled' } }, ctxAt()));
    expect(fin.run).toMatchObject({ status: 'error' });
    const list = okOut(await e.runOp('runs.list', { op: 'score' }, ctxAt()));
    expect(list.items[0]?.id).toBe('rn_q');
  });
});

describe('runnerAlive', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'pp-runner-'));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));
  it('reads the launcher pid file: this process is alive, no file or a bad pid is gone', () => {
    mkdirSync(runnerDir(base), { recursive: true });
    writeFileSync(join(runnerDir(base), 'rn_me.pid'), String(process.pid));
    writeFileSync(join(runnerDir(base), 'rn_bad.pid'), 'nope');
    expect(runnerAlive('rn_me', base)).toBe(true);
    expect(runnerAlive('rn_bad', base)).toBe(false);
    expect(runnerAlive('rn_none', base)).toBe(false);
  });
});
