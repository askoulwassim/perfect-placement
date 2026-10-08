import { FIXTURE_ROLE_IDS } from '@perfect-placement/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { okOut } from './_shim/assert.js';
import { ctxAt, type FixtureEngine, openFixtureEngine } from './_shim/testing.js';

/*
 * Done-when (lane B brief): a fixture role goes inbox -> active -> draft-ready ->
 * applied -> interviews through ops only. Scoring (lane F) is not merged, so the
 * inbox -> active step is the human's manual pick in River.
 */

let e: FixtureEngine;
beforeAll(() => {
  e = openFixtureEngine();
});
afterAll(() => e.cleanup());

const id = FIXTURE_ROLE_IDS.notionInbox;
const status = () => (e.db.prepare('SELECT status FROM role WHERE id = ?').get(id) as { status: string }).status;

describe('one fixture role through the funnel, ops only', () => {
  it('inbox -> active (human pick)', async () => {
    expect(status()).toBe('inbox');
    okOut(await e.runOp('roles.move', { role_id: id, to: 'active' }, ctxAt('human')));
    expect(status()).toBe('active');
  });

  it('research + tailor -> draft-ready (agent)', async () => {
    const run = okOut(await e.runOp('runs.start', { skill: 'tailor', role_id: id }, ctxAt())).run;
    const ctx = ctxAt('agent', { runId: run.id });
    okOut(await e.runOp('companies.dossier.write', { company_id: 'notion', markdown: '# Notion\n\nDossier.' }, ctx));
    okOut(await e.runOp('apply.tailor', { role_id: id, resume_md: '# R', cover_letter_md: '# C', fit_map_md: '# F' }, ctx));
    okOut(await e.runOp('apply.fill', { role_id: id, answers: [{ question: 'Why?', answer: 'Because.' }] }, ctx));
    okOut(await e.runOp('runs.finish', { run_id: run.id, status: 'ok' }, ctx));
    expect(status()).toBe('draft-ready');
  });

  it('the agent cannot submit; the confirmation email moves it to applied', async () => {
    expect((await e.runOp('apply.mark_submitted', { role_id: id }, ctxAt('agent'))).status).toBe('requires_human');
    const msg = { message_id: 'e2e-1', received_at: '2026-10-08T11:00:00.000Z', role_id: id, class: 'confirmation', p: 0.97 };
    okOut(await e.runOp('inbox.ingest', { messages: [msg] }, ctxAt('schedule')));
    expect(status()).toBe('applied');
  });

  it('applied -> interviews from the interview request', async () => {
    const msg = { message_id: 'e2e-2', received_at: '2026-10-08T11:30:00.000Z', role_id: id, class: 'interview_request', p: 0.95 };
    okOut(await e.runOp('inbox.ingest', { messages: [msg] }, ctxAt('schedule')));
    expect(status()).toBe('interviews');
    const trail = (e.db.prepare(`SELECT type FROM event WHERE subject_id = ? ORDER BY rowid`).all(id) as { type: string }[]).map(
      (r) => r.type,
    );
    expect(trail.slice(-8)).toEqual([
      'role_moved',
      'application_tailored',
      'role_moved',
      'inbox_classified',
      'role_moved',
      'inbox_classified',
      'interview_scheduled',
      'role_moved',
    ]);
    const app = okOut(await e.runOp('roles.get', { role_id: id }, ctxAt())).application;
    expect(app).toMatchObject({ stage: 'done', applied_at: '2026-10-08T11:00:00.000Z' });
    expect(Object.keys(app.package_paths_json).sort()).toEqual(['answers', 'cover_letter', 'dossier', 'fit_map', 'resume']);
  });
});
