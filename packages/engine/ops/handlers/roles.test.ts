import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLE_STATUSES } from '@perfect-placement/contracts';
import { FIXTURE_ROLE_IDS, roles as fixtureRoles } from '@perfect-placement/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { okOut } from '../_shim/assert.js';
import { ctxAt, type FixtureEngine, openFixtureEngine } from '../_shim/testing.js';
import { roleIdFor } from '../ids.js';

let e: FixtureEngine;
beforeEach(() => {
  e = openFixtureEngine();
});
afterEach(() => e.cleanup());

const status = (id: string) => (e.db.prepare('SELECT status FROM role WHERE id = ?').get(id) as { status: string }).status;
const events = (type: string, subject: string) =>
  (e.db.prepare('SELECT count(*) n FROM event WHERE type = ? AND subject_id = ?').get(type, subject) as { n: number }).n;
const existing = fixtureRoles.find((r) => r.id === FIXTURE_ROLE_IDS.stripeApplied);

describe('roles.add', () => {
  it('adds new roles to inbox with markdown, a new company, an event and a run log', async () => {
    const o = await e.runOp(
      'roles.add',
      {
        candidates: [
          {
            company_name: 'Acme Robotics, Inc.',
            company_domain: 'https://www.acme.dev',
            title: 'Principal PM, Data',
            url: 'https://boards.greenhouse.io/acme/jobs/9900001',
            source: 'scout',
            workplace: 'remote',
            jd_markdown: 'Own the data platform.',
          },
        ],
      },
      ctxAt(),
    );
    const out = okOut(o);
    expect(out).toEqual({ added: ['acme-robotics_principal-pm-data'], duplicates: [], possible_duplicates: [] });
    const role = e.db.prepare('SELECT * FROM role WHERE id = ?').get('acme-robotics_principal-pm-data') as Record<string, unknown>;
    expect(role).toMatchObject({ status: 'inbox', ats_job_id: '9900001', remote_ok: 1, company_id: 'acme-robotics' });
    expect(e.db.prepare(`SELECT * FROM company WHERE id = 'acme-robotics'`).get()).toMatchObject({
      name: 'Acme Robotics',
      domain: 'acme.dev',
      ats_type: 'greenhouse',
      ats_board: 'acme',
    });
    const md = readFileSync(join(e.home, 'roles/acme-robotics_principal-pm-data.md'), 'utf8');
    expect(md).toMatch(/^---\nid: "acme-robotics_principal-pm-data"\ntype: "role"\n---/);
    expect(md).toContain('Own the data platform.');
    expect(events('role_added', 'acme-robotics_principal-pm-data')).toBe(1);
    const run = e.db.prepare(`SELECT * FROM run WHERE op = 'roles.add'`).get() as { log_path: string; summary_json: string };
    expect(JSON.parse(run.summary_json)).toMatchObject({ candidates: 1, added: 1 });
    expect(readFileSync(join(e.home, run.log_path), 'utf8')).toContain('acme-robotics_principal-pm-data');
  });

  it('dedupes on url, ATS job id and company + fuzzy title, including within a batch', async () => {
    const o = await e.runOp(
      'roles.add',
      {
        candidates: [
          { company_name: 'Whoever', title: 'Anything', url: `${existing?.url}/?utm_source=li`, source: 'scout' },
          {
            company_name: 'Stripe',
            title: 'Different title',
            url: 'https://example.com/other',
            ats_job_id: existing?.ats_job_id ?? 'x',
            source: 'scout',
          },
          { company_name: 'Stripe', title: 'Principal Product Manager - Revenue Data (Remote)', source: 'link' },
          { company_name: 'NewCo', title: 'Head of Product', source: 'link' },
          { company_name: 'NewCo', title: 'Head of Product', source: 'link' },
        ],
      },
      ctxAt(),
    );
    const out = okOut(o);
    expect(out.added).toEqual(['newco_head-of-product']);
    expect(out.duplicates).toEqual([
      { index: 0, existing_id: existing?.id, match: 'url' },
      { index: 1, existing_id: existing?.id, match: 'ats_job_id' },
      { index: 2, existing_id: existing?.id, match: 'company_title' },
      { index: 4, existing_id: 'newco_head-of-product', match: 'company_title' },
    ]);
  });

  it('adds a near-duplicate and queues a roles.dedupe decision for a human', async () => {
    const o = await e.runOp(
      'roles.add',
      { candidates: [{ company_name: 'Stripe', title: 'Staff PM, Data Pipelines', source: 'scout' }] },
      ctxAt(),
    );
    const [id] = okOut(o).added;
    const d = e.db.prepare(`SELECT * FROM decision WHERE kind = 'roles.dedupe' AND subject_id = ?`).get(id) as Record<string, string>;
    expect(d).toMatchObject({ policy_outcome: 'human', status: 'pending', impact: 'low' });
    expect(JSON.parse(d.action_json as string)).toMatchObject({ op: 'roles.archive', input: { role_id: id, reason: 'passed' } });
  });

  it('suffixes colliding role ids', () => {
    const taken = new Set(['stripe_staff-pm', 'stripe_staff-pm-2']);
    expect(roleIdFor('stripe', 'Staff PM', (id) => taken.has(id))).toBe('stripe_staff-pm-3');
    expect(roleIdFor('stripe', 'Staff PM!', () => false)).toBe('stripe_staff-pm');
  });
});

describe('roles.move / roles.archive', () => {
  it('human manual move, with role_picked and a markdown log line', async () => {
    const id = FIXTURE_ROLE_IDS.datadogActive;
    const out = okOut(await e.runOp('roles.move', { role_id: id, to: 'on-deck' }, ctxAt('human')));
    expect(out.from).toBe('active');
    expect(out.role.status).toBe('on-deck');
    expect(events('role_picked', id)).toBe(1);
    expect(readFileSync(join(e.home, `roles/${id}.md`), 'utf8')).toMatch(/- 2026-10-08 active -> on-deck \(roles\.move\)/);
  });

  it('a freed slot promotes the best held role at the company', async () => {
    const id = FIXTURE_ROLE_IDS.datadogActive;
    const held = fixtureRoles.filter((r) => r.company_id === 'datadog' && r.status === 'held').map((r) => r.id);
    await e.runOp('roles.move', { role_id: id, to: 'on-deck' }, ctxAt('human'));
    const promoted = held.filter((h) => status(h) === 'active');
    expect(promoted).toHaveLength(1);
    expect(events('role_promoted', promoted[0] as string)).toBe(1);
    expect(held.filter((h) => status(h) === 'held')).toHaveLength(1);
  });

  it('refuses non-manual moves, held as a target and archiving via move', async () => {
    const human = ctxAt('human');
    expect(await e.runOp('roles.move', { role_id: FIXTURE_ROLE_IDS.linearDraft, to: 'applied' }, human)).toMatchObject({
      code: 'forbidden_transition',
    });
    expect(await e.runOp('roles.move', { role_id: FIXTURE_ROLE_IDS.datadogActive, to: 'held' }, human)).toMatchObject({
      code: 'forbidden_transition',
    });
    expect(await e.runOp('roles.move', { role_id: FIXTURE_ROLE_IDS.datadogActive, to: 'archived' }, human)).toMatchObject({
      code: 'forbidden_transition',
    });
    expect(await e.runOp('roles.move', { role_id: 'nope', to: 'active' }, human)).toMatchObject({ code: 'not_found' });
  });

  it('no-downgrade holds even with an approved decision for an agent', async () => {
    const q = await e.runOp('roles.move', { role_id: FIXTURE_ROLE_IDS.figmaIv, to: 'applied' }, ctxAt('agent'));
    expect(q.status).toBe('requires_human');
    const o = await e.runOp(
      'roles.move',
      { role_id: FIXTURE_ROLE_IDS.figmaIv, to: 'applied' },
      ctxAt('agent', { decisionId: (q as { decisionId: string }).decisionId }),
    );
    expect(o).toMatchObject({ code: 'forbidden_transition' });
    expect(status(FIXTURE_ROLE_IDS.figmaIv)).toBe('interviews');
  });

  it('archive sets the reason, emits role_skipped for passed picks, and needs a reason', async () => {
    const id = FIXTURE_ROLE_IDS.airtableOnDeck;
    const out = okOut(await e.runOp('roles.archive', { role_id: id, reason: 'passed', note: 'team too small' }, ctxAt('human')));
    expect(out.role).toMatchObject({ status: 'archived', archive_reason: 'passed' });
    expect(out.role.flags_json.archive_note).toBe('team too small');
    expect(events('role_archived', id)).toBe(1);
    expect(events('role_skipped', id)).toBe(1);
    expect(await e.runOp('roles.archive', { role_id: id }, ctxAt('human'))).toMatchObject({ code: 'invalid_input' });
    expect(await e.runOp('roles.archive', { role_id: id, reason: 'passed' }, ctxAt('human'))).toMatchObject({ code: 'conflict' });
  });

  it('a human restores an archived role', async () => {
    const out = okOut(await e.runOp('roles.move', { role_id: FIXTURE_ROLE_IDS.vercelClosed, to: 'active' }, ctxAt('human')));
    expect(out.role).toMatchObject({ status: 'active', archive_reason: null });
  });
});

describe('reads', () => {
  it('roles.get returns company, latest score, application, contacts and the markdown body', async () => {
    const out = okOut(await e.runOp('roles.get', { role_id: FIXTURE_ROLE_IDS.linearDraft }, ctxAt()));
    expect(out.company.id).toBe('linear');
    expect(out.latest_score.role_id).toBe(FIXTURE_ROLE_IDS.linearDraft);
    expect(out.application.stage).toBe('connect');
    expect(out.contacts.length).toBe(5);
    expect(out.md_body).toMatch(/^# Product Lead, Insights, Linear/);
    expect(await e.runOp('roles.get', { role_id: 'nope' }, ctxAt())).toMatchObject({ code: 'not_found' });
  });

  it('roles.get picks the newest score when a role was rescored', async () => {
    const id = fixtureRoles[3]?.id as string;
    const out = okOut(await e.runOp('roles.get', { role_id: id }, ctxAt()));
    expect(out.latest_score.profile_version_id).toBe('pv_0002');
  });

  it('roles.list filters, sorts and pages', async () => {
    const active = okOut(await e.runOp('roles.list', { status: ['active'], sort: 'fit' }, ctxAt()));
    expect(active.items.length).toBe(fixtureRoles.filter((r) => r.status === 'active').length);
    const totals = active.items.map((i: { latest_score: { total: number } }) => i.latest_score.total);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
    const red = okOut(await e.runOp('roles.list', { band: ['red', 'yellow'] }, ctxAt()));
    expect(red.items.every((i: { latest_score: { band: string } }) => i.latest_score.band !== 'green')).toBe(true);
    const p1 = okOut(await e.runOp('roles.list', { limit: 10 }, ctxAt()));
    expect(p1.items).toHaveLength(10);
    expect(p1.next_cursor).toBe('10');
    const all = okOut(await e.runOp('roles.list', { limit: 500 }, ctxAt()));
    expect(all.items).toHaveLength(fixtureRoles.length);
    expect(all.next_cursor).toBeNull();
    const dd = okOut(await e.runOp('roles.list', { company_id: 'datadog', workplace: ['remote'] }, ctxAt()));
    expect(dd.items.every((i: { role: { company_id: string } }) => i.role.company_id === 'datadog')).toBe(true);
  });

  it('pipeline.summary counts every status and the Now numbers', async () => {
    const out = okOut(await e.runOp('pipeline.summary', {}, ctxAt()));
    for (const s of ROLE_STATUSES) expect(out.counts[s]).toBe(fixtureRoles.filter((r) => r.status === s).length);
    expect(out.archived_by_reason.closed).toBe(1);
    expect(out.needs_you).toBeGreaterThanOrEqual(5);
    expect(out.auto_share_24h).toBeGreaterThan(0);
    expect(out.drafts_ready).toBe(2);
    expect(out.replies).toBe(1);
    expect(existsSync(join(e.home, 'pp.db'))).toBe(true);
  });
});
