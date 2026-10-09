import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type OpContext, type OpOutcome, vaultPath } from '@perfect-placement/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ctxAt, type FixtureEngine, openFixtureEngine } from '../testing/index.js';
import {
  buildWriterPrompt,
  checkDraft,
  coverExcerpt,
  coverProof,
  type DraftContext,
  type MxResolver,
  pickTeamInbox,
  templateDraft,
} from './index.js';

/*
 * #78: the no-contact fallback through runOp on a temp fixture vault: a synthetic company at
 * acme.example with a draft-ready role at Connect, its tailored cover letter in the vault, a fake MX
 * resolver (no DNS) and placeholder people only.
 */

// biome-ignore lint/suspicious/noExplicitAny: test helper returns loosely typed output
const ok = (o: OpOutcome<unknown>): any => {
  if (o.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(o)}`);
  return o.output;
};

const ROLE = 'acme_product-lead';
const COVER = [
  '# Cover letter',
  '',
  'Dear Acme hiring team,',
  '',
  'I build data products that people actually use. At my last company I led a team of 27 analysts through a platform rebuild.',
  'I also launched a self-serve analytics product that 400 teams adopted.',
  '',
  'I would love to talk about the Product Lead role.',
  '',
  'Best,',
  'Sam',
].join('\n');

let v: FixtureEngine;
const mx: MxResolver = async () => true;
const agent = (over: Partial<OpContext> = {}) => ctxAt('agent', over);
const human = () => ctxAt('human');
const run = (name: string, input: unknown, c: OpContext = agent()) => v.runOp(name, input, c);
const write = (rel: string, md: string) => {
  const abs = join(v.home, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, md);
};
const stage = () => (v.db.prepare('SELECT stage FROM application WHERE role_id = ?').get(ROLE) as { stage: string }).stage;

function open(opts: { jd?: string; stage?: string; status?: string } = {}) {
  v?.cleanup();
  v = openFixtureEngine({ services: { mx } });
  v.db
    .prepare(
      `INSERT INTO company (id, slug, name, domain, ats_type, ats_board, affinity, md_path) VALUES ('acme', 'acme', 'Acme', 'acme.example', 'unknown', NULL, 0, NULL)`,
    )
    .run();
  v.db
    .prepare(
      `INSERT INTO role (id, company_id, title, source, found_at, status, md_path, created_at, updated_at) VALUES (?, 'acme', 'Product Lead', 'manual', '2026-10-01T00:00:00.000Z', ?, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    )
    .run(ROLE, opts.status ?? 'draft-ready', vaultPath.role(ROLE));
  write(
    vaultPath.role(ROLE),
    `---\nid: "${ROLE}"\ntype: "role"\n---\n\n# Product Lead\n\n## JD\n\n${opts.jd ?? 'You will own the analytics roadmap for our data platform.'}\n`,
  );
  const cover = vaultPath.application(ROLE, 'cover_letter');
  write(cover, `---\nid: "ap_acme-cover_letter"\ntype: "application_cover_letter"\n---\n\n${COVER}\n`);
  v.db
    .prepare(
      `INSERT INTO application (id, role_id, stage, applied_at, portal_url, package_paths_json) VALUES ('ap_acme', ?, ?, NULL, NULL, ?)`,
    )
    .run(ROLE, opts.stage ?? 'connect', JSON.stringify({ cover_letter: cover }));
}

beforeEach(() => open());
afterEach(() => v.cleanup());

describe('team inbox pick', () => {
  it('a named recruiter first, then team mailboxes in order; other domains and non-team mailboxes never', () => {
    const hints = [
      { email: 'jobs@acme.example', source: 'jd' as const },
      { email: 'info@acme.example', source: 'company_site' as const },
      { email: 'talent@other.example', source: 'careers' as const },
      { email: 'recruiting@jobs.acme.example', source: 'careers' as const },
    ];
    expect(pickTeamInbox(hints, 'acme.example')?.email).toBe('recruiting@jobs.acme.example');
    expect(pickTeamInbox([...hints, { email: 'pat.lee@acme.example', name: 'Pat Lee', source: 'careers' }], 'acme.example')?.email).toBe(
      'pat.lee@acme.example',
    );
    expect(pickTeamInbox([{ email: 'info@acme.example', source: 'jd' }], 'acme.example')).toBeNull();
    expect(pickTeamInbox([{ email: 'talent@other.example', source: 'jd' }], 'acme.example')).toBeNull();
  });
});

describe('people.fallback', () => {
  it('no contacts: a team mailbox in the JD becomes the "Hiring team" contact (public email, cold_hiring)', async () => {
    open({ jd: 'You will own the analytics roadmap. Questions? Write to jobs@acme.example.' });
    const out = ok(await run('people.fallback', { role_id: ROLE }));
    expect(out).toMatchObject({ fallback: 'team_inbox', reason: 'jobs@ from jd' });
    expect(out.contact).toMatchObject({
      name: 'Hiring team',
      email: 'jobs@acme.example',
      email_source: 'public',
      email_confidence: 0.9,
      source: 'jd',
    });
    expect(out.link).toMatchObject({ degree: 'cold', tier: 'cold_hiring', is_hiring_team: true, role_id: ROLE });
    expect(stage()).toBe('connect');
    const got = ok(await run('roles.get', { role_id: ROLE }));
    expect(got.connect).toMatchObject({ fallback: 'team_inbox', contact_id: out.contact.id });
    expect(got.contacts).toHaveLength(1);
    // Now there is a usable contact: a second call finds no fallback is needed.
    expect(ok(await run('people.fallback', { role_id: ROLE }))).toMatchObject({ fallback: null, reason: '1 usable contact' });
  });

  it("the agent's recruiting hint beats a JD mailbox; an address at another domain is ignored", async () => {
    open({ jd: 'Apply or write to jobs@acme.example.' });
    const out = ok(
      await run('people.fallback', {
        role_id: ROLE,
        team_inbox: [
          { email: 'talent@other.example', source: 'careers' },
          { email: 'recruiting@acme.example', source: 'careers', url: 'https://acme.example/careers' },
        ],
      }),
    );
    expect(out.contact).toMatchObject({ name: 'Hiring team', email: 'recruiting@acme.example', source: 'company_site' });
  });

  it('no team inbox: a cold note to the likely hiring leader with a pattern-guessed email, flagged in Needs you', async () => {
    const out = ok(
      await run('people.fallback', {
        role_id: ROLE,
        team_inbox: [{ email: 'info@acme.example', source: 'company_site' }],
        leader: { name: 'Jordan Vale', headline: 'VP Product, Acme' },
      }),
    );
    expect(out).toMatchObject({ fallback: 'cold_leader', reason: 'no team inbox found' });
    expect(out.contact).toMatchObject({ name: 'Jordan Vale', email: 'jordan.vale@acme.example', email_source: 'pattern' });
    expect(out.link).toMatchObject({ tier: 'cold_hiring', is_hiring_team: true });
    expect(out.email).toMatchObject({ email: 'jordan.vale@acme.example', confirmed: false, outcome: 'human' });
    expect(out.email.confidence).toBeLessThan(0.7);
    const pending = v.db.prepare(`SELECT id FROM decision WHERE kind = 'people.email' AND status = 'pending'`).all();
    expect(pending).toHaveLength(1);
    expect(ok(await run('roles.get', { role_id: ROLE })).connect).toMatchObject({ fallback: 'cold_leader' });
    expect(stage()).toBe('connect');
  });

  it('nothing at all: Connect is skipped and the application moves to Fill', async () => {
    const out = ok(await run('people.fallback', { role_id: ROLE }));
    expect(out).toMatchObject({ fallback: 'skipped', reason: 'no contacts', contact: null });
    expect(out.application).toMatchObject({ stage: 'fill' });
    expect(stage()).toBe('fill');
    expect(ok(await run('roles.get', { role_id: ROLE })).connect).toMatchObject({
      fallback: 'skipped',
      reason: 'no contacts',
      contact_id: null,
    });
  });

  it('a role with a usable contact needs no fallback; an unpicked role is refused', async () => {
    v.db
      .prepare(
        `INSERT INTO contact (id, name, headline, linkedin_url, email, source, notes, email_source, email_confidence) VALUES ('ct_kim', 'Kim Ash', NULL, NULL, NULL, 'manual', NULL, NULL, NULL)`,
      )
      .run();
    v.db
      .prepare(
        `INSERT INTO contact_link (id, contact_id, company_id, role_id, degree, tier, via_contact_id, is_hiring_team) VALUES ('cl_kim', 'ct_kim', 'acme', ?, '1', 'warm_other', NULL, 0)`,
      )
      .run(ROLE);
    expect(ok(await run('people.fallback', { role_id: ROLE }))).toMatchObject({ fallback: null });
    expect(stage()).toBe('connect');
    open({ status: 'active', stage: 'tailor' });
    expect((await run('people.fallback', { role_id: ROLE })).status).toBe('error');
  });
});

describe('apply.skip_connect', () => {
  it('moves connect -> fill with the reason; past Connect it is a no-op', async () => {
    const out = ok(await run('apply.skip_connect', { role_id: ROLE, reason: 'user' }, human()));
    expect(out).toMatchObject({ skipped: true, application: { stage: 'fill' } });
    expect(ok(await run('roles.get', { role_id: ROLE })).connect).toMatchObject({ fallback: 'skipped', reason: 'user' });
    expect(ok(await run('apply.skip_connect', { role_id: ROLE, reason: 'user' }, human()))).toMatchObject({ skipped: false });
    expect(stage()).toBe('fill');
  });

  it('refuses a role that has not reached Connect', async () => {
    open({ status: 'active', stage: 'tailor' });
    const o = await run('apply.skip_connect', { role_id: ROLE, reason: 'user' }, human());
    expect(o).toMatchObject({ status: 'error', code: 'conflict' });
  });
});

describe('cover-letter draft (team inbox / cold leader)', () => {
  const story = { data: { name: 'Sam Fixture', wins: ['Launched a self-serve analytics product to 400 teams'] }, text: '' };
  const ctx = (fallback: DraftContext['fallback']): DraftContext => ({
    tier: 'cold_hiring',
    contact: { name: fallback === 'team_inbox' ? 'Hiring team' : 'Jordan Vale', headline: null },
    via: null,
    role: { title: 'Product Lead', jd: 'You will own the analytics roadmap for our data platform.' },
    company: { name: 'Acme', dossier: null },
    story,
    voice: { data: {}, text: '' },
    fallback,
    cover: coverExcerpt(COVER),
  });

  it('the cover excerpt drops the title, salutation and closing; the proof is its first-person sentences', () => {
    const cover = coverExcerpt(COVER) ?? '';
    expect(cover).not.toMatch(/Dear|Best,|# Cover/);
    expect(coverProof(cover)).toBe(
      'I build data products that people actually use. At my last company I led a team of 27 analysts through a platform rebuild.',
    );
  });

  it('team inbox: greets the company team, proof from the cover letter, passes checkDraft with the cover letter as a source', () => {
    const d = templateDraft(ctx('team_inbox'));
    expect(d.hook).toMatch(/^Hi Acme team, I am applying for the Product Lead role\./);
    expect(d.proof).toContain('27 analysts');
    expect(d.ask).toMatch(/hiring manager/);
    expect(checkDraft(d, `${JSON.stringify(story.data)}\n${coverExcerpt(COVER)}`)).toEqual([]);
    // Without the cover letter as a source, its number is ungrounded.
    expect(checkDraft(d, JSON.stringify(story.data)).map((i) => i.rule)).toContain('ungrounded_number');
  });

  it('cold leader: the writer prompt carries the cover letter and its goal', () => {
    const p = buildWriterPrompt(ctx('cold_leader'));
    expect(p.user).toContain('COVER LETTER');
    expect(p.user).toContain('27 analysts');
    expect(p.user).toContain('fallback: cold_leader');
    expect(p.system).toContain('COVER LETTER');
    const d = templateDraft(ctx('cold_leader'));
    expect(d.hook).toMatch(/^Hi Jordan, your team is hiring a Product Lead\./);
    expect(checkDraft(d, `${JSON.stringify(story.data)}\n${coverExcerpt(COVER)}`)).toEqual([]);
  });

  it('outreach.draft grounds a fallback draft in the cover letter; the same text fails for a non-fallback contact', async () => {
    open({ jd: 'Write to recruiting@acme.example.' });
    const fb = ok(await run('people.fallback', { role_id: ROLE }));
    const text = templateDraft(ctx('team_inbox'));
    const saved = ok(await run('outreach.draft', { contact_id: fb.contact.id, role_id: ROLE, tier: 'cold_hiring', ...text }));
    expect(saved.outreach).toMatchObject({ status: 'drafted', tier: 'cold_hiring' });
    const got = ok(await run('outreach.get', { outreach_id: saved.outreach.id }));
    expect(got.to).toMatchObject({ email: 'recruiting@acme.example' });
    expect(got.body).toMatch(/^Hi Acme team,\n\nI am applying/);

    v.db
      .prepare(
        `INSERT INTO contact (id, name, headline, linkedin_url, email, source, notes, email_source, email_confidence) VALUES ('ct_rae', 'Rae Moss', NULL, NULL, NULL, 'manual', NULL, NULL, NULL)`,
      )
      .run();
    v.db
      .prepare(
        `INSERT INTO contact_link (id, contact_id, company_id, role_id, degree, tier, via_contact_id, is_hiring_team) VALUES ('cl_rae', 'ct_rae', 'acme', ?, 'cold', 'cold_hiring', NULL, 1)`,
      )
      .run(ROLE);
    const refused = await run('outreach.draft', { contact_id: 'ct_rae', role_id: ROLE, tier: 'cold_hiring', ...text });
    expect(refused).toMatchObject({ status: 'error', code: 'invalid_input' });
  });
});
