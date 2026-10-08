import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_ROLE_IDS } from '@perfect-placement/fixtures';
import { afterEach, describe, expect, it } from 'vitest';
import { createDryRunGmail } from '../integrations/gmail/index.js';
import { createLinkedInAdapter, createRecordedDriver, type Recording } from '../integrations/linkedin/index.js';
import { ctxAt, type FixtureEngine, fakeProfileLlm, learnKev, okOut, openFixtureEngine, tickingClock } from '../testing/index.js';

/*
 * Wave 2 Phase 2 integration on a temp fixture vault. Every write goes through runOp; the resolver is
 * the real one with a scripted fake Kev; LinkedIn and Gmail are dry-run adapters; nothing spawns.
 */

let e: FixtureEngine;
afterEach(() => e.cleanup());
const clock = tickingClock('2026-10-08T12:00:00.000Z');
const status = (id: string) => (e.db.prepare('SELECT status FROM role WHERE id = ?').get(id) as { status: string }).status;

describe('(a) learn loop end to end', () => {
  it('rejection event -> profile.learn -> resolver -> diffs -> policy -> profile v+1 -> rescore of affected roles', async () => {
    e = openFixtureEngine({ kev: learnKev(['craft', 'dealbreakers']), services: { profileLlm: fakeProfileLlm } });
    const human = () => ctxAt('human', {}, clock);
    const agent = () => ctxAt('agent', {}, clock);
    const role = FIXTURE_ROLE_IDS.rampIv;

    // 1. The inbox monitor (agent, confident) classifies a rejection: the role archives, a `rejection` event is written.
    const msg = { message_id: 'it-rej-1', received_at: '2026-10-08T11:00:00.000Z', role_id: role, class: 'rejection', p: 0.97 };
    const ing = okOut(await e.runOp('inbox.ingest', { messages: [msg] }, agent()));
    expect(ing.applied).toEqual([{ message_id: 'it-rej-1', role_id: role, to: 'archived' }]);
    expect(status(role)).toBe('archived');
    const eventId = (e.db.prepare(`SELECT id FROM event WHERE type = 'rejection' AND subject_id = ?`).get(role) as { id: string }).id;

    // Movable roles before the change (on-deck and later are never rescored, #13).
    const before = okOut(await e.runOp('profile.get', {}, human())).version.id;
    const movable = (
      e.db.prepare(`SELECT id FROM role WHERE status IN ('inbox','active','held') AND id IN (SELECT role_id FROM score)`).all() as {
        id: string;
      }[]
    ).map((r) => r.id);
    const onDeckScores = e.db.prepare(`SELECT count(*) n FROM score WHERE role_id IN (SELECT id FROM role WHERE status = 'on-deck')`).get();

    // 2. profile.learn: Noulli x 11 -> drafts -> nested propose/apply ops under policy.
    const learned = okOut(await e.runOp('profile.learn', { event_id: eventId }, agent()));
    expect(learned.proposed.map((d: { component_key: string }) => d.component_key).sort()).toEqual(['craft', 'dealbreakers']);
    // Dealbreakers: hard exclusion, waits for the human in Needs you.
    expect(learned.queued).toHaveLength(1);
    const queue = okOut(await e.runOp('decisions.queue', {}, human()));
    expect(queue.pending.map((d: { id: string }) => d.id)).toContain(learned.queued[0].decision_id);
    // Craft: medium + confident -> applied with a 24h undo.
    expect(learned.applied).toHaveLength(1);
    const v = okOut(await e.runOp('profile.get', {}, human())).version;
    expect(v).toMatchObject({ id: learned.applied[0].version_id, parent_id: before, event_id: eventId });

    // 3. Rescore: every movable scored role got a score row under v+1; on-deck untouched.
    const rescored = (e.db.prepare('SELECT role_id FROM score WHERE profile_version_id = ?').all(v.id) as { role_id: string }[]).map(
      (r) => r.role_id,
    );
    expect(rescored.sort()).toEqual(movable.sort());
    expect(e.db.prepare(`SELECT count(*) n FROM score WHERE role_id IN (SELECT id FROM role WHERE status = 'on-deck')`).get()).toEqual(
      onDeckScores,
    );

    // 4. The human rejects the dealbreaker change from Needs you (skip): nothing applies.
    okOut(await e.runOp('decisions.resolve', { decision_id: learned.queued[0].decision_id, action: 'skip' }, human()));
    expect(okOut(await e.runOp('profile.get', {}, human())).version.id).toBe(v.id);
  });
});

const ACME: Recording = {
  pages: {
    '/search/results/people': [
      { name: 'Rae M.', headline: 'VP Product at Acme Robotics', profileUrl: '/in/fixture-rae-m', degreeLabel: '1st' },
    ],
    '/company/acme-robotics/people': [
      { name: 'Sol N.', headline: 'Technical Recruiter', profileUrl: '/in/fixture-sol-n', degreeLabel: '3rd+' },
    ],
  },
};

describe('(b) one role through every stage, runOp only', () => {
  it('add -> score -> pick -> research run -> dossier -> tailor -> people -> outreach -> Gmail draft -> fill -> submit (human only) -> applied -> interview', async () => {
    const gmail = createDryRunGmail();
    e = openFixtureEngine({
      kev: (_q, req) =>
        req.decision === 'people.classify'
          ? { value: (req.state as Record<string, string>).contact_name === 'Rae M.' ? 'hiring_manager' : 'recruiter', p: 0.95 }
          : undefined,
      services: {
        linkedin: createLinkedInAdapter({ driver: createRecordedDriver(ACME), mode: 'dry-run', minDelayS: 0 }),
        gmail,
      },
    });
    const agent = (extra = {}) => ctxAt('agent', extra, clock);
    const human = () => ctxAt('human', {}, clock);
    const sure = { confidence: { p: 0.95, backend: 'agent' as const } };

    // Scout: add to inbox (dedupe), then score (lane F) -> active.
    const add = okOut(
      await e.runOp(
        'roles.add',
        {
          candidates: [
            {
              company_name: 'Acme Robotics',
              company_domain: 'acme-robotics.example',
              title: 'Principal PM, Data Platform',
              url: 'https://jobs.lever.co/acme-robotics/0a1b2c3d-0000-4000-8000-000000000001',
              source: 'scout',
              workplace: 'remote',
            },
          ],
        },
        agent(),
      ),
    );
    const id = add.added[0] as string;
    expect(status(id)).toBe('inbox');
    const score = okOut(
      await e.runOp(
        'roles.score',
        {
          role_id: id,
          criteria: { c1: 5, c2: 4, c3: 4, c4: 5, c5: 4, c6: 4, c7: 4, c8: 4, c9: 5 },
          facts: { workplace: 'remote', remote_ok: true },
        },
        agent(),
      ),
    );
    expect(score.status).toBe('active');
    expect(score.score.band).toBe('green');

    // The human picks it (River): active -> on-deck, role_picked.
    okOut(await e.runOp('roles.move', { role_id: id, to: 'on-deck' }, human()));

    // Research: a headless run (fake runner), then the dossier through ops.
    const run = okOut(await e.runOp('runs.start', { skill: 'research', role_id: id }, human())).run;
    expect(e.launcher.specs).toHaveLength(1);
    expect(e.launcher.specs[0]).toMatchObject({ command: 'claude', runId: run.id });
    const inRun = (extra = {}) => agent({ runId: run.id, ...extra });
    okOut(
      await e.runOp('companies.dossier.write', { company_id: 'acme-robotics', markdown: '# Acme Robotics\n\nSynthetic dossier.' }, inRun()),
    );
    okOut(await e.runOp('runs.finish', { run_id: run.id, status: 'ok' }, inRun()));

    // Tailor: package -> draft-ready.
    okOut(await e.runOp('apply.tailor', { role_id: id, resume_md: '# Resume', cover_letter_md: '# Cover', fit_map_md: '# Fit' }, agent()));
    expect(status(id)).toBe('draft-ready');

    // Connect: people (dry-run LinkedIn), classify (Kev), outreach draft, Gmail draft (dry-run, never sent).
    const found = okOut(await e.runOp('people.find', { role_id: id }, agent())).found as Array<{ contact: { id: string; name: string } }>;
    expect(found.map((f) => f.contact.name).sort()).toEqual(['Rae M.', 'Sol N.']);
    const rae = found.find((f) => f.contact.name === 'Rae M.')?.contact.id as string;
    expect(okOut(await e.runOp('people.classify', { contact_id: rae, role_id: id }, agent())).tier).toBe('warm_hiring');
    const draft = okOut(
      await e.runOp(
        'outreach.draft',
        {
          contact_id: rae,
          role_id: id,
          tier: 'warm_hiring',
          hook: 'Your data platform team is growing fast.',
          proof: 'I launched a self-serve analytics product used by 400 teams.',
          ask: '20 minutes next week?',
        },
        agent(),
      ),
    ).outreach;
    // Medium op: no confidence = Needs you; with confidence it runs (#17).
    expect((await e.runOp('outreach.to_gmail', { outreach_id: draft.id }, agent())).status).toBe('requires_human');
    expect(okOut(await e.runOp('outreach.to_gmail', { outreach_id: draft.id }, agent(sure))).gmail_draft_id).toBe('dryrun-1');
    expect(gmail.drafts).toHaveLength(1);
    expect(await e.runOp('outreach.send', { outreach_id: draft.id }, human())).toMatchObject({ code: 'unimplemented' });

    // Fill: answers to the real portal questions.
    okOut(
      await e.runOp(
        'apply.fill',
        {
          role_id: id,
          portal_url: 'https://jobs.lever.co/acme-robotics/0a1b2c3d-0000-4000-8000-000000000001/apply',
          answers: [{ question: 'Why us?', answer: 'Because.' }],
        },
        agent(),
      ),
    );

    // Submit is human only: the agent gets requires_human (high, hard exclusion), nothing moves.
    const sub = await e.runOp('apply.mark_submitted', { role_id: id }, agent(sure));
    expect(sub.status).toBe('requires_human');
    const dec = e.db.prepare('SELECT * FROM decision WHERE id = ?').get((sub as { decisionId: string }).decisionId) as Record<
      string,
      string
    >;
    expect(dec).toMatchObject({ kind: 'apply.submit', policy_outcome: 'human', status: 'pending', impact: 'high' });
    expect(status(id)).toBe('draft-ready');

    // The human submits in the portal; the confirmation email moves it to applied, then the interview request.
    const confirm = { message_id: 'it-1', received_at: '2026-10-08T13:00:00.000Z', role_id: id, class: 'confirmation', p: 0.96 };
    okOut(await e.runOp('inbox.ingest', { messages: [confirm] }, agent()));
    expect(status(id)).toBe('applied');
    const invite = { message_id: 'it-2', received_at: '2026-10-08T14:00:00.000Z', role_id: id, class: 'interview_request', p: 0.95 };
    okOut(await e.runOp('inbox.ingest', { messages: [invite] }, agent()));
    expect(status(id)).toBe('interviews');

    const got = okOut(await e.runOp('roles.get', { role_id: id }, human()));
    expect(got.application).toMatchObject({ stage: 'done', applied_at: '2026-10-08T13:00:00.000Z' });
    expect(Object.keys(got.application.package_paths_json).sort()).toEqual(['answers', 'cover_letter', 'dossier', 'fit_map', 'resume']);
    expect(got.contacts.map((c: { contact: { name: string } }) => c.contact.name).sort()).toEqual(['Rae M.', 'Sol N.']);
    expect(readFileSync(join(e.home, `roles/${id}.md`), 'utf8')).toContain('applied -> interviews (inbox.ingest: interview_request)');
  });
});

describe('(c) freshness close with undo, and #16 revive', () => {
  it('a confident confirmation revives an archived role to applied with a 24h undo; undo restores the archive', async () => {
    e = openFixtureEngine();
    const role = FIXTURE_ROLE_IDS.vercelClosed; // archived, closed
    const msg = { message_id: 'it-rev', received_at: '2026-10-08T10:00:00.000Z', role_id: role, class: 'confirmation', p: 0.96 };
    okOut(await e.runOp('inbox.ingest', { messages: [msg] }, ctxAt('agent', {}, clock)));
    expect(status(role)).toBe('applied');
    const d = e.db.prepare(`SELECT * FROM decision WHERE kind = 'inbox.classify' AND subject_id = ?`).get(role) as Record<string, string>;
    expect(d.policy_outcome).toBe('auto_undo');
    expect(JSON.parse(d.action_json as string).undo).toEqual({
      op: 'roles.move',
      input: { role_id: role, to: 'archived', reason: 'closed' },
    });
    okOut(await e.runOp('decisions.undo', { decision_id: d.id }, ctxAt('human', {}, clock)));
    expect(e.db.prepare('SELECT status, archive_reason FROM role WHERE id = ?').get(role)).toEqual({
      status: 'archived',
      archive_reason: 'closed',
    });
  });

  it('an agent archive with confidence goes through the grid; auto + undo records the inverse move', async () => {
    e = openFixtureEngine({ config: { overrides: { 'roles.archive': { confident_outcome: 'auto_undo' } } } });
    const role = FIXTURE_ROLE_IDS.datadogActive;
    const o = okOut(
      await e.runOp(
        'roles.archive',
        { role_id: role, reason: 'passed' },
        ctxAt('agent', { confidence: { p: 0.95, backend: 'agent' } }, clock),
      ),
    );
    expect(o.role.status).toBe('archived');
    const d = e.db.prepare(`SELECT * FROM decision WHERE kind = 'roles.archive' AND subject_id = ?`).get(role) as Record<string, string>;
    expect(d).toMatchObject({ policy_outcome: 'auto_undo', backend: 'agent', status: 'applied' });
    expect(JSON.parse(d.action_json as string).undo).toEqual({ op: 'roles.move', input: { role_id: role, to: 'active' } });
    okOut(await e.runOp('decisions.undo', { decision_id: d.id }, ctxAt('agent', {}, clock)));
    expect(status(role)).toBe('active');
    // Middle confidence: auto only if a second backend agrees; none here -> Needs you.
    expect(
      (
        await e.runOp(
          'roles.archive',
          { role_id: role, reason: 'passed' },
          ctxAt('agent', { confidence: { p: 0.8, backend: 'agent' } }, clock),
        )
      ).status,
    ).toBe('requires_human');
  });
});
