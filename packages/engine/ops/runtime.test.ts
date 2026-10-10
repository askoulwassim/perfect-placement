import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OP_NAMES, OPS } from '@perfect-placement/contracts';
import { FIXTURE_ROLE_IDS } from '@perfect-placement/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ctxAt, type FixtureEngine, okOut, openFixtureEngine } from '../testing/index.js';
import { ALL_HANDLERS, defineHandler, LANE_B_HANDLERS } from './index.js';

let e: FixtureEngine;
beforeEach(() => {
  e = openFixtureEngine();
});
afterEach(() => e.cleanup());

const count = (sql: string, ...p: unknown[]) => (e.db.prepare(sql).get(...p) as { n: number }).n;

describe('runOp', () => {
  it('covers the registry: every op has a handler except outreach.send (unimplemented by contract)', async () => {
    for (const name of OP_NAMES) {
      expect(name in ALL_HANDLERS, name).toBe(name !== 'outreach.send');
      expect(e.has(name), name).toBe(name !== 'outreach.send');
      if (OPS[name].owner === 'B') expect(name in LANE_B_HANDLERS, name).toBe(true);
    }
    expect(await e.runOp('outreach.send', { outreach_id: 'or_0001' }, ctxAt('human'))).toMatchObject({ code: 'unimplemented' });
    expect(await e.runOp('nope.nope', {}, ctxAt())).toMatchObject({ code: 'not_found' });
  });

  it('validates input with zod', async () => {
    const o = await e.runOp('roles.move', { role_id: 'x', to: 'nowhere' }, ctxAt('human'));
    expect(o).toMatchObject({ status: 'error', code: 'invalid_input' });
    expect((o as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
  });

  it('human-only ops queue a high-impact decision for agents', async () => {
    const before = count('SELECT count(*) n FROM decision');
    const o = await e.runOp('apply.mark_submitted', { role_id: FIXTURE_ROLE_IDS.linearDraft }, ctxAt('agent'));
    expect(o.status).toBe('requires_human');
    const id = (o as { decisionId: string }).decisionId;
    const d = e.db.prepare('SELECT * FROM decision WHERE id = ?').get(id) as Record<string, string>;
    expect(d).toMatchObject({ kind: 'apply.submit', impact: 'high', policy_outcome: 'human', status: 'pending' });
    expect(JSON.parse(d.action_json as string).op).toBe('apply.mark_submitted');
    expect(count('SELECT count(*) n FROM decision')).toBe(before + 1);
    expect(count(`SELECT count(*) n FROM role WHERE id = ? AND status = 'draft-ready'`, FIXTURE_ROLE_IDS.linearDraft)).toBe(1);
  });

  it('medium ops from automated actors queue; the decision id then authorizes the run', async () => {
    const roleId = FIXTURE_ROLE_IDS.datadogActive;
    const q = await e.runOp('roles.archive', { role_id: roleId, reason: 'passed' }, ctxAt('schedule'));
    expect(q.status).toBe('requires_human');
    const decisionId = (q as { decisionId: string }).decisionId;
    expect(count(`SELECT count(*) n FROM role WHERE id = ? AND status = 'active'`, roleId)).toBe(1);
    // A decision for another op does not authorize.
    const wrong = await e.runOp('roles.move', { role_id: roleId, to: 'on-deck' }, ctxAt('agent', { decisionId }));
    expect(wrong.status).toBe('requires_human');
    const ran = await e.runOp('roles.archive', { role_id: roleId, reason: 'passed' }, ctxAt('agent', { decisionId }));
    expect(okOut(ran).role.status).toBe('archived');
    const ev = e.db.prepare(`SELECT decision_id FROM event WHERE type = 'role_archived' AND subject_id = ?`).get(roleId) as {
      decision_id: string;
    };
    expect(ev.decision_id).toBe(decisionId);
  });

  it('dry run validates and computes but writes nothing', async () => {
    const events = count('SELECT count(*) n FROM event');
    const o = await e.runOp(
      'roles.add',
      { candidates: [{ company_name: 'Acme', title: 'Staff PM', source: 'link' }] },
      ctxAt('agent', { dryRun: true }),
    );
    expect(okOut(o).added).toHaveLength(1);
    expect(o.status === 'ok' && o.eventIds).toEqual([]);
    expect(count('SELECT count(*) n FROM event')).toBe(events);
    expect(count(`SELECT count(*) n FROM company WHERE id = 'acme'`)).toBe(0);
  });

  it('rolls back db and vault when a handler throws', async () => {
    e.register(
      'roles.add',
      defineHandler('roles.add', {
        run(_input, h) {
          h.vault.write('roles/zz.md', 'x');
          h.emit('role_added', 'role', 'zz');
          throw new Error('boom');
        },
      }),
    );
    const events = count('SELECT count(*) n FROM event');
    const o = await e.runOp('roles.add', { candidates: [{ company_name: 'Acme', title: 'PM', source: 'link' }] }, ctxAt());
    expect(o).toMatchObject({ status: 'error', code: 'internal', message: 'boom' });
    expect(count('SELECT count(*) n FROM event')).toBe(events);
    expect(() => readFileSync(join(e.home, 'roles/zz.md'))).toThrow();
  });

  it('refuses events outside the op emits list and outputs that break the contract', async () => {
    e.register(
      'roles.get',
      defineHandler('roles.get', {
        run: (_i, h) => {
          h.emit('offer', 'role', 'x');
          return {} as never;
        },
      }),
    );
    expect(await e.runOp('roles.get', { role_id: 'x' }, ctxAt())).toMatchObject({
      code: 'internal',
      message: expect.stringContaining('may not emit'),
    });
    e.register('runs.list', defineHandler('runs.list', { run: () => ({ items: 'nope' }) as never }));
    expect(await e.runOp('runs.list', {}, ctxAt())).toMatchObject({ code: 'internal', message: expect.stringContaining('contract') });
  });

  it('other lanes plug in with register()', async () => {
    e.register(
      'roles.score',
      defineHandler('roles.score', {
        run: () => {
          throw new Error('not lane B');
        },
      }),
    );
    expect(e.has('roles.score')).toBe(true);
    const criteria = { c1: 3, c2: 3, c3: 3, c4: 3, c5: 3, c6: 3, c7: 3, c8: 3, c9: 3 };
    expect(await e.runOp('roles.score', { role_id: 'x', criteria, facts: {} }, ctxAt())).toMatchObject({ message: 'not lane B' });
  });
});

describe('runtime: nesting, backends, policy gate', () => {
  it('a nested op that fails rolls back alone; the parent commits', async () => {
    const roleId = FIXTURE_ROLE_IDS.datadogActive;
    e.register(
      'roles.move',
      defineHandler('roles.move', {
        async run(input, h) {
          const bad = await h.runOp('roles.archive', { role_id: 'nope', reason: 'passed' }, h.ctx);
          expect(bad.status).toBe('error');
          const good = await h.runOp('roles.archive', { role_id: input.role_id, reason: 'passed' }, h.ctx);
          expect(good.status).toBe('ok');
          return { role: (good as { output: { role: never } }).output.role, from: 'active' };
        },
      }),
    );
    okOut(await e.runOp('roles.move', { role_id: roleId, to: 'on-deck' }, ctxAt('human')));
    expect(count(`SELECT count(*) n FROM role WHERE id = ? AND status = 'archived'`, roleId)).toBe(1);
  });

  it('system.backends lists rule, Kev (not installed in tests) and the agent session; the API adapter only when enabled', async () => {
    const out = okOut(await e.runOp('system.backends', {}, ctxAt('human')));
    expect(out.items).toEqual([
      { name: 'rule', mode: 'local', status: 'ok', latencyMs: 0 },
      { name: 'kev', mode: 'local', status: 'not_installed', latencyMs: null },
      // The fixture's one agent-answered decision took 140 ms (#100).
      { name: 'agent', mode: 'session', status: 'ok', latencyMs: 140 },
    ]);
  });

  it('system.backends: agent latency is the median of recent measured agent work, null when none, never a constant 0 (#100)', async () => {
    const agent = async () => okOut(await e.runOp('system.backends', {}, ctxAt('human'))).items.find((i) => i.name === 'agent');
    e.db.prepare(`DELETE FROM decision WHERE backend = 'agent'`).run();
    expect(await agent()).toEqual({ name: 'agent', mode: 'session', status: 'ok', latencyMs: null });

    // Unmeasured (0 ms) agent decisions and turns do not count.
    const base = e.db.prepare(`SELECT * FROM decision WHERE backend = 'kev' LIMIT 1`).get() as Record<string, unknown>;
    const add = (id: string, ts: string, ms: number) =>
      e.db
        .prepare(`INSERT INTO decision (id, ts, kind, subject_type, subject_id, question_json, backend, answer_json, p, impact,
          policy_outcome, status, human_choice, overridden, undo_until, resolved_at, latency_ms, action_json) SELECT @id, @ts, kind, subject_type, subject_id, question_json, 'agent', answer_json, p, impact,
          policy_outcome, status, human_choice, overridden, undo_until, resolved_at, @ms, action_json FROM decision WHERE id = @src`)
        .run({ id, ts, ms, src: base.id });
    add('dc_a0', '2026-10-08T07:00:00.000Z', 0);
    e.db
      .prepare(`INSERT INTO ask_thread (id, created_at, updated_at, runner, session_id, turns_json) VALUES (?, ?, ?, 'claude', NULL, ?)`)
      .run('ask_t0', '2026-10-08T07:00:00.000Z', '2026-10-08T07:00:00.000Z', JSON.stringify([{ user: 'q', reply: 'a' }]));
    expect((await agent())?.latencyMs).toBeNull();

    add('dc_a1', '2026-10-08T07:01:00.000Z', 300);
    add('dc_a2', '2026-10-08T07:02:00.000Z', 100);
    expect((await agent())?.latencyMs).toBe(200);
    e.db.prepare(`UPDATE ask_thread SET updated_at = ?, turns_json = ? WHERE id = 'ask_t0'`).run(
      '2026-10-08T07:03:00.000Z',
      JSON.stringify([
        { user: 'q', reply: 'a', ms: 9000 },
        { user: 'q2', reply: 'a2', ms: 4000 },
      ]),
    );
    const out = await agent();
    expect(out?.latencyMs).toBe(2150);
    // Seconds-long session turns are think time, not a slow service.
    expect(out?.status).toBe('ok');
  });

  it('system.backends: an installed Kev that does not answer is down (#40)', async () => {
    mkdirSync(join(e.home, 'kev'), { recursive: true });
    writeFileSync(join(e.home, 'kev', 'installed.json'), '{}');
    const out = okOut(await e.runOp('system.backends', {}, ctxAt('human')));
    expect(out.items.find((i) => i.name === 'kev')?.status).toBe('down');
  });

  it('system.doctor runs lane A checks over the open db', async () => {
    const out = okOut(await e.runOp('system.doctor', {}, ctxAt('human')));
    expect(out.counts.active).toBeGreaterThan(0);
  });

  it('agent medium ops go through the grid with ctx.confidence (#17)', async () => {
    const roleId = FIXTURE_ROLE_IDS.datadogActive;
    const sure = await e.runOp(
      'roles.move',
      { role_id: roleId, to: 'on-deck' },
      ctxAt('agent', { confidence: { p: 0.95, backend: 'agent' } }),
    );
    expect(okOut(sure).role.status).toBe('on-deck');
    const d = e.db.prepare(`SELECT * FROM decision WHERE kind = 'roles.move' AND subject_id = ? ORDER BY ts DESC`).get(roleId) as Record<
      string,
      string
    >;
    expect(d).toMatchObject({ policy_outcome: 'auto', status: 'applied', backend: 'agent', impact: 'medium' });
    const unsure = await e.runOp(
      'roles.move',
      { role_id: roleId, to: 'active' },
      ctxAt('agent', { confidence: { p: 0.5, backend: 'agent' } }),
    );
    expect(unsure.status).toBe('requires_human');
  });
});
