import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPS, type OpName } from '@perfect-placement/contracts';
import { FIXTURE_ROLE_IDS } from '@perfect-placement/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { okOut } from './_shim/assert.js';
import { ctxAt, type FixtureEngine, openFixtureEngine } from './_shim/testing.js';
import { defineHandler, LANE_B_HANDLERS, NOT_LANE_B } from './index.js';

let e: FixtureEngine;
beforeEach(() => {
  e = openFixtureEngine();
});
afterEach(() => e.cleanup());

const count = (sql: string, ...p: unknown[]) => (e.db.prepare(sql).get(...p) as { n: number }).n;

describe('runOp', () => {
  it('covers the registry: every lane B op has a handler, every other op is someone else', () => {
    for (const name of Object.keys(OPS) as OpName[]) {
      const isB = OPS[name].owner === 'B';
      expect(name in LANE_B_HANDLERS, name).toBe(isB);
      expect((NOT_LANE_B as readonly string[]).includes(name), name).toBe(!isB);
    }
  });

  it('answers unimplemented for unmerged lanes and for outreach.send', async () => {
    expect(await e.runOp('roles.score', { role_id: 'x', criteria: {}, facts: {} }, ctxAt())).toMatchObject({
      status: 'error',
      code: 'unimplemented',
      message: expect.stringContaining('lane F'),
    });
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
