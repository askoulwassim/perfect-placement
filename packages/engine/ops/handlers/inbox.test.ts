import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_ROLE_IDS } from '@perfect-placement/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { okOut } from '../_shim/assert.js';
import { ctxAt, type FixtureEngine, openFixtureEngine } from '../_shim/testing.js';

let e: FixtureEngine;
beforeEach(() => {
  e = openFixtureEngine();
});
afterEach(() => e.cleanup());

const at = '2026-10-08T07:00:00.000Z';
const msg = (id: string, role_id: string | null, cls: string, p = 0.96, extra: Record<string, unknown> = {}) => ({
  message_id: id,
  received_at: at,
  role_id,
  class: cls,
  p,
  ...extra,
});
const status = (id: string) =>
  e.db.prepare('SELECT status, archive_reason FROM role WHERE id = ?').get(id) as { status: string; archive_reason: string | null };
const count = (sql: string, ...p: unknown[]) => (e.db.prepare(sql).get(...p) as { n: number }).n;

describe('inbox.ingest', () => {
  it('confident confirmation: auto + undo, moves draft-ready to applied, records applied_at', async () => {
    const id = FIXTURE_ROLE_IDS.linearDraft;
    const out = okOut(await e.runOp('inbox.ingest', { messages: [msg('m1', id, 'confirmation')] }, ctxAt('schedule')));
    expect(out).toEqual({ applied: [{ message_id: 'm1', role_id: id, to: 'applied' }], queued: [], ignored: [] });
    expect(status(id).status).toBe('applied');
    const d = e.db.prepare(`SELECT * FROM decision WHERE kind = 'inbox.classify' AND subject_id = ? ORDER BY ts DESC`).get(id) as Record<
      string,
      string
    >;
    expect(d).toMatchObject({ policy_outcome: 'auto_undo', status: 'applied', undo_until: '2026-10-09T12:00:00.000Z' });
    const ev = e.db.prepare(`SELECT decision_id FROM event WHERE type = 'role_moved' AND subject_id = ?`).get(id) as {
      decision_id: string;
    };
    expect(ev.decision_id).toBe(d.id);
    expect((e.db.prepare('SELECT applied_at FROM application WHERE role_id = ?').get(id) as { applied_at: string }).applied_at).toBe(at);
    expect(readFileSync(join(e.home, `roles/${id}.md`), 'utf8')).toContain('draft-ready -> applied (inbox.ingest: confirmation)');
  });

  it('unsure classification is queued with its action; running the decision applies it once', async () => {
    const id = FIXTURE_ROLE_IDS.stripeApplied;
    const out = okOut(
      await e.runOp(
        'inbox.ingest',
        { messages: [msg('m2', id, 'interview_request', 0.8, { interview_at: '2026-10-12T16:00:00.000Z' })] },
        ctxAt(),
      ),
    );
    expect(out.applied).toEqual([]);
    const decisionId = out.queued[0].decision_id;
    expect(status(id).status).toBe('applied');
    // asking again does not double-queue
    const again = okOut(await e.runOp('inbox.ingest', { messages: [msg('m2', id, 'interview_request', 0.8)] }, ctxAt()));
    expect(again.queued[0].decision_id).toBe(decisionId);
    const action = JSON.parse(
      (e.db.prepare('SELECT action_json FROM decision WHERE id = ?').get(decisionId) as { action_json: string }).action_json,
    );
    expect(action.op).toBe('inbox.ingest');
    const ran = okOut(await e.runOp(action.op, action.input, ctxAt('human', { decisionId })));
    expect(ran.applied[0].to).toBe('interviews');
    expect(status(id).status).toBe('interviews');
    expect(e.db.prepare('SELECT round, at, outcome FROM interview WHERE role_id = ?').get(id)).toEqual({
      round: 1,
      at: '2026-10-12T16:00:00.000Z',
      outcome: 'pending',
    });
    expect(count(`SELECT count(*) n FROM event WHERE type = 'interview_scheduled' AND subject_id = ?`, id)).toBe(1);
    // replay is ignored
    const replay = okOut(await e.runOp(action.op, action.input, ctxAt('human', { decisionId })));
    expect(replay.ignored).toEqual(['m2']);
  });

  it('no-downgrade: a late confirmation never pulls a role back from interviews', async () => {
    const id = FIXTURE_ROLE_IDS.figmaIv;
    const out = okOut(await e.runOp('inbox.ingest', { messages: [msg('m3', id, 'confirmation')] }, ctxAt('schedule')));
    expect(out.applied).toEqual([{ message_id: 'm3', role_id: id, to: null }]);
    expect(status(id).status).toBe('interviews');
  });

  it('a second-round invite records a new interview without a move', async () => {
    const id = FIXTURE_ROLE_IDS.figmaIv;
    okOut(await e.runOp('inbox.ingest', { messages: [msg('m4', id, 'interview_request')] }, ctxAt('schedule')));
    expect(count('SELECT max(round) n FROM interview WHERE role_id = ?', id)).toBe(3);
    expect(status(id).status).toBe('interviews');
  });

  it('rejection archives from any funnel stage with reason rejected', async () => {
    const id = FIXTURE_ROLE_IDS.rampIv;
    okOut(await e.runOp('inbox.ingest', { messages: [msg('m5', id, 'rejection')] }, ctxAt('schedule')));
    expect(status(id)).toEqual({ status: 'archived', archive_reason: 'rejected' });
    expect(count(`SELECT count(*) n FROM event WHERE type = 'rejection' AND subject_id = ?`, id)).toBe(1);
  });

  it('offer moves interviews to offers', async () => {
    const id = FIXTURE_ROLE_IDS.figmaIv;
    okOut(await e.runOp('inbox.ingest', { messages: [msg('m6', id, 'offer', 0.99)] }, ctxAt('schedule')));
    expect(status(id).status).toBe('offers');
    expect(count(`SELECT count(*) n FROM event WHERE type = 'offer' AND subject_id = ?`, id)).toBe(1);
  });

  it('outreach replies mark the outreach; other and unmatched mail is ignored', async () => {
    const out = okOut(
      await e.runOp(
        'inbox.ingest',
        {
          messages: [
            msg('m7', null, 'outreach_reply', 0.95, { outreach_id: 'or_0002' }),
            msg('m8', FIXTURE_ROLE_IDS.linearDraft, 'other'),
            msg('m9', null, 'rejection'),
            msg('m10', 'ghost_role', 'offer'),
          ],
        },
        ctxAt('schedule'),
      ),
    );
    expect(out.applied).toEqual([{ message_id: 'm7', role_id: null, to: null }]);
    expect(out.ignored).toEqual(['m8', 'm9', 'm10']);
    expect((e.db.prepare(`SELECT status FROM outreach WHERE id = 'or_0002'`).get() as { status: string }).status).toBe('replied');
    expect(count(`SELECT count(*) n FROM event WHERE type = 'outreach_replied' AND subject_id = 'or_0002'`)).toBe(1);
  });

  it('writes a run log', async () => {
    okOut(await e.runOp('inbox.ingest', { messages: [msg('m11', FIXTURE_ROLE_IDS.linearDraft, 'confirmation')] }, ctxAt('schedule')));
    const run = e.db.prepare(`SELECT * FROM run WHERE op = 'inbox.ingest'`).get() as { log_path: string };
    expect(run.log_path).toBe('runs/2026-10-08_inbox-ingest.md');
    expect(readFileSync(join(e.home, run.log_path), 'utf8')).toContain('m11: confirmation');
  });
});
