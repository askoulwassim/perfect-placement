import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AskRequest, CONTACT_DEGREES, DEFAULT_CONFIG, type OpOutcome } from '@perfect-placement/contracts';
import { FIXTURE_ROLE_IDS, FIXTURE_SEED_SQL, FIXTURE_VAULT_DIR } from '@perfect-placement/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDryRunGmail } from '../integrations/gmail/index.js';
import { createLinkedInAdapter, createRecordedDriver, type Recording, SYNTHETIC_RECORDING } from '../integrations/linkedin/index.js';
import {
  checkDraft,
  classifyContact,
  composeAndDraft,
  draftOutreach,
  findPeople,
  handlers,
  linkContact,
  outreachSendHandler,
  outreachToGmailHandler,
  readOutreachSections,
  templateDraft,
  tierFor,
} from './index.js';
import { createFakeAsk, createTestVault, type ScriptedAnswer, type TestVault, testCtx, testDeps } from './testkit.js';

const R = FIXTURE_ROLE_IDS;
const ok = <O>(o: OpOutcome<O>): O => {
  if (o.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(o)}`);
  return o.output;
};
const count = (v: TestVault, sql: string, ...args: unknown[]) => (v.db.prepare(sql).get(...args) as { n: number }).n;

/** Synthetic recording for the on-deck Airtable fixture role. Placeholder people only. */
const MUTUALS = 'https://www.linkedin.com/search/results/people/?facetConnectionOf=%5B%22fixture-cara%22%5D&network=%5B%22F%22%5D';
const AIRTABLE: Recording = {
  pages: {
    '/search/results/people': [
      { name: 'Ana B.', headline: 'Director of Product, AI Platform at Airtable', profileUrl: '/in/fixture-ana-b', degreeLabel: '1st' },
      { name: 'Ben C.', headline: 'Software Engineer at Airtable', profileUrl: '/in/fixture-ben-c', degreeLabel: '1st' },
    ],
    '/company/airtable/people': [
      { name: 'Cara D.', headline: 'Product Manager, AI', profileUrl: '/in/fixture-cara-d', degreeLabel: '2nd', mutualsUrl: MUTUALS },
      { name: 'Gus H.', headline: 'Technical Recruiter', profileUrl: '/in/fixture-gus-h', degreeLabel: '3rd+' },
      { name: 'Ida J.', headline: 'Office Manager', profileUrl: '/in/fixture-ida-j', degreeLabel: '3rd+' },
    ],
    [MUTUALS]: [{ name: 'Eli F.', headline: 'Data Scientist', profileUrl: '/in/fixture-eli-f', degreeLabel: '1st' }],
  },
};
const WHO: Record<string, ContactAnswer> = {
  'Ana B.': 'hiring_manager',
  'Ben C.': 'peer',
  'Cara D.': 'hiring_team',
  'Gus H.': 'recruiter',
  'Ida J.': 'unrelated',
};
type ContactAnswer = 'hiring_manager' | 'hiring_team' | 'recruiter' | 'peer' | 'unrelated' | 'other';

const scriptByName =
  (p = 0.95) =>
  (req: AskRequest): ScriptedAnswer => {
    const state = req.state as Record<string, string>;
    return { value: WHO[state.contact_name ?? ''] ?? 'other', p };
  };

let v: TestVault;
beforeEach(() => {
  v = createTestVault(FIXTURE_VAULT_DIR, FIXTURE_SEED_SQL);
});
afterEach(() => v.cleanup());

const linkedin = (rec: Recording = AIRTABLE) => createLinkedInAdapter({ driver: createRecordedDriver(rec), mode: 'dry-run', minDelayS: 0 });

describe('tiers', () => {
  it('tier = degree x hiring team', () => {
    expect(CONTACT_DEGREES.flatMap((d) => [tierFor(d, true), tierFor(d, false)])).toEqual([
      'warm_hiring',
      'warm_other',
      'bridge',
      'bridge',
      'cold_hiring',
      'cold_other',
    ]);
  });
  it('fixture links agree with the tier mechanics', () => {
    const rows = v.db.prepare('SELECT degree, tier, is_hiring_team FROM contact_link').all() as Array<{
      degree: '1' | '2' | 'cold';
      tier: string;
      is_hiring_team: number;
    }>;
    for (const r of rows) expect(r.tier).toBe(tierFor(r.degree, r.is_hiring_team === 1));
  });
});

describe('people.find', () => {
  it('only runs on picked roles', async () => {
    const deps = testDeps(v, { ask: createFakeAsk(v.db, scriptByName()), linkedin: linkedin() });
    const r = await findPeople({ role_id: R.datadogActive }, testCtx(), deps);
    expect(r).toMatchObject({ status: 'error', code: 'conflict' });
    expect(await findPeople({ role_id: 'nope_nope' }, testCtx(), deps)).toMatchObject({ status: 'error', code: 'not_found' });
  });

  it('upserts contacts, links them with provisional tiers, emits contact_found, logs the run', async () => {
    const deps = testDeps(v, { ask: createFakeAsk(v.db, scriptByName()), linkedin: linkedin() });
    const before = count(v, 'SELECT COUNT(*) n FROM contact');
    const out = ok(await findPeople({ role_id: R.airtableOnDeck }, testCtx(), deps));
    expect(out.capped).toBe(false);
    const tiers = Object.fromEntries(out.found.map((f) => [f.contact.name, f.link.tier]));
    expect(tiers).toEqual({
      'Ana B.': 'warm_other',
      'Ben C.': 'warm_other',
      'Cara D.': 'bridge',
      'Gus H.': 'cold_other',
      'Ida J.': 'cold_other',
    });
    const cara = out.found.find((f) => f.contact.name === 'Cara D.');
    const eli = v.db.prepare('SELECT * FROM contact WHERE id = ?').get(cara?.link.via_contact_id) as { name: string };
    expect(eli.name).toBe('Eli F.');
    // 5 linked + the mutual (contact only).
    expect(count(v, 'SELECT COUNT(*) n FROM contact') - before).toBe(6);
    expect(count(v, "SELECT COUNT(*) n FROM event WHERE type = 'contact_found'")).toBe(
      5 + count(v, "SELECT COUNT(*) n FROM event WHERE type = 'contact_found' AND ts < '2026-10-08T12:00:00.000Z'"),
    );
    const run = v.db.prepare("SELECT summary_json FROM run WHERE op = 'people.find'").get() as { summary_json: string };
    expect(JSON.parse(run.summary_json)).toMatchObject({ linkedin_profiles_read: 6, capped: false, found: 5 });
    // Stored fields only: name, headline, URL, email, source. Notes stay empty.
    const ana = v.db.prepare("SELECT * FROM contact WHERE name = 'Ana B.'").get() as Record<string, unknown>;
    expect(ana).toMatchObject({ linkedin_url: 'https://www.linkedin.com/in/fixture-ana-b', email: null, notes: null, source: 'linkedin' });

    // Re-run is idempotent: no new contacts or links.
    const links = count(v, 'SELECT COUNT(*) n FROM contact_link');
    ok(await findPeople({ role_id: R.airtableOnDeck }, testCtx(), deps));
    expect(count(v, 'SELECT COUNT(*) n FROM contact_link')).toBe(links);
  });

  it('dedupes against existing contacts by LinkedIn URL', async () => {
    // Linear draft-ready role: fixture already has Maya R., Dev P., Lina K., Priya T.
    const deps = testDeps(v, { ask: createFakeAsk(v.db, scriptByName()), linkedin: linkedin(SYNTHETIC_RECORDING) });
    const out = ok(await findPeople({ role_id: R.linearDraft }, testCtx(), deps));
    const maya = out.found.find((f) => f.contact.name === 'Maya R.');
    expect(maya?.contact.id).toBe('ct_0001');
    expect(maya?.link.id).toBe('cl_0001');
    expect(count(v, "SELECT COUNT(*) n FROM contact WHERE name = 'Maya R.'")).toBe(1);
  });

  it('dry run writes nothing', async () => {
    const deps = testDeps(v, { ask: createFakeAsk(v.db, scriptByName()), linkedin: linkedin() });
    const snap = () => ['contact', 'contact_link', 'event', 'run'].map((t) => count(v, `SELECT COUNT(*) n FROM ${t}`));
    const before = snap();
    const out = ok(await findPeople({ role_id: R.airtableOnDeck, dry_run: true }, testCtx(), deps));
    expect(out.found).toHaveLength(5);
    expect(snap()).toEqual(before);
  });

  it('enforces the daily LinkedIn cap across runs', async () => {
    const config = { ...DEFAULT_CONFIG, linkedin: { ...DEFAULT_CONFIG.linkedin, max_profiles_per_day: 7 } };
    const deps = testDeps(v, { ask: createFakeAsk(v.db, scriptByName()), linkedin: linkedin(), config });
    const first = ok(await findPeople({ role_id: R.airtableOnDeck }, testCtx(), deps));
    expect(first.capped).toBe(false);
    // 6 read, 1 left: the next picked role is capped after one card.
    const second = ok(await findPeople({ role_id: R.stripeOnDeck }, testCtx(), deps));
    expect(second.capped).toBe(true);
    const third = ok(await findPeople({ role_id: R.stripeOnDeck }, testCtx(), deps));
    expect(third.capped).toBe(true);
    const reads = v.db
      .prepare("SELECT json_extract(summary_json, '$.linkedin_profiles_read') n FROM run WHERE op = 'people.find' ORDER BY started_at, id")
      .all() as Array<{ n: number }>;
    expect(reads.reduce((s, r) => s + r.n, 0)).toBeLessThanOrEqual(7);
    // Next UTC day the budget resets.
    const tomorrow = ok(await findPeople({ role_id: R.stripeOnDeck }, testCtx({ now: () => new Date('2026-10-09T08:00:00.000Z') }), deps));
    expect(tomorrow.capped).toBe(false);
  });

  it('accepts JD and team-page hints from the skill, deduped by email', async () => {
    const deps = testDeps(v, { ask: createFakeAsk(v.db, scriptByName()) });
    const out = ok(
      await findPeople(
        {
          role_id: R.linearDraft,
          hints: [
            { name: 'Omar S.', email: 'omar.s@example.com', source: 'jd' },
            { name: 'Zoe Q.', headline: 'VP Product', source: 'company_site' },
          ],
        },
        testCtx(),
        deps,
      ),
    );
    expect(out.found.map((f) => f.contact.id)).toContain('ct_0004');
    const zoe = out.found.find((f) => f.contact.name === 'Zoe Q.');
    expect(zoe?.link).toMatchObject({ degree: 'cold', tier: 'cold_other' });
  });
});

describe('people.classify', () => {
  it('applies a confident pick to the link', async () => {
    const ask = createFakeAsk(v.db, scriptByName(0.95));
    const deps = testDeps(v, { ask, linkedin: linkedin() });
    const found = ok(await findPeople({ role_id: R.airtableOnDeck }, testCtx(), deps)).found;
    const ana = found.find((f) => f.contact.name === 'Ana B.');
    const out = ok(await classifyContact({ contact_id: ana?.contact.id, role_id: R.airtableOnDeck }, testCtx(), deps));
    expect(out).toMatchObject({ role: 'hiring_manager', tier: 'warm_hiring', p: 0.95 });
    const link = v.db.prepare('SELECT tier, is_hiring_team FROM contact_link WHERE id = ?').get(ana?.link.id);
    expect(link).toEqual({ tier: 'warm_hiring', is_hiring_team: 1 });
    expect(ask.calls[0]).toMatchObject({ decision: 'people.classify', impact: 'low', subject: { type: 'contact' } });
    const q = ask.calls[0]?.questions[0];
    expect(q?.type === 'choice' && q.options).toEqual(['hiring_manager', 'hiring_team', 'recruiter', 'peer', 'unrelated', 'other']);
    expect(count(v, "SELECT COUNT(*) n FROM decision WHERE id = ? AND kind = 'people.classify'", out.decision_id)).toBe(1);
  });

  it('a low-confidence pick goes to Needs you and leaves the provisional tier', async () => {
    const deps = testDeps(v, { ask: createFakeAsk(v.db, scriptByName(0.55)), linkedin: linkedin() });
    const found = ok(await findPeople({ role_id: R.airtableOnDeck }, testCtx(), deps)).found;
    const gus = found.find((f) => f.contact.name === 'Gus H.');
    const out = ok(await classifyContact({ contact_id: gus?.contact.id, role_id: R.airtableOnDeck }, testCtx(), deps));
    expect(out.tier).toBe('cold_hiring');
    expect(v.db.prepare('SELECT tier FROM contact_link WHERE id = ?').get(gus?.link.id)).toEqual({ tier: 'cold_other' });
    expect(v.db.prepare('SELECT policy_outcome, status FROM decision WHERE id = ?').get(out.decision_id)).toEqual({
      policy_outcome: 'human',
      status: 'pending',
    });
  });

  it('needs an existing link', async () => {
    const deps = testDeps(v, { ask: createFakeAsk(v.db, scriptByName()) });
    expect(await classifyContact({ contact_id: 'ct_0006', role_id: R.linearDraft }, testCtx(), deps)).toMatchObject({
      status: 'error',
      code: 'not_found',
    });
  });
});

describe('people.link', () => {
  it('rejects a tier that does not match degree x hiring team, upserts otherwise', async () => {
    const deps = testDeps(v, { ask: createFakeAsk(v.db, scriptByName()) });
    const base = { contact_id: 'ct_0006', company_id: null, role_id: R.stripeOnDeck, via_contact_id: null };
    expect(await linkContact({ ...base, degree: 'cold', tier: 'warm_hiring', is_hiring_team: true }, testCtx(), deps)).toMatchObject({
      code: 'invalid_input',
    });
    const a = ok(await linkContact({ ...base, degree: 'cold', tier: 'cold_hiring', is_hiring_team: true }, testCtx(), deps));
    expect(a.link.company_id).toBe('stripe');
    const b = ok(await linkContact({ ...base, degree: '1', tier: 'warm_hiring', is_hiring_team: true }, testCtx(), deps));
    expect(b.link.id).toBe(a.link.id);
  });
});

describe('outreach', () => {
  const linearDeps = () => testDeps(v, { ask: createFakeAsk(v.db, scriptByName()), gmail: createDryRunGmail() });

  it('refuses em dashes and numbers not in Story', () => {
    const story = 'Launched a self-serve analytics product to 400 teams';
    expect(
      checkDraft({ subject: 's', hook: 'Fast team — nice', proof: 'Built for 400 teams.', ask: '20 minutes?' }, story).map((i) => i.rule),
    ).toEqual(['em_dash']);
    expect(checkDraft({ subject: 's', hook: 'h', proof: 'Grew revenue 3x for 900 users.', ask: 'a' }, story).map((i) => i.rule)).toEqual([
      'ungrounded_number',
      'ungrounded_number',
    ]);
  });

  it('outreach.draft writes the vault file, row and event; rejects rule breaks', async () => {
    const deps = linearDeps();
    const bad = await draftOutreach(
      { contact_id: 'ct_0002', role_id: R.linearDraft, tier: 'warm_other', hook: 'Hi Dev — quick one.', proof: 'p', ask: 'a' },
      testCtx(),
      deps,
    );
    expect(bad).toMatchObject({ status: 'error', code: 'invalid_input' });
    expect(
      await draftOutreach(
        { contact_id: 'ct_0002', role_id: R.linearDraft, tier: 'warm_hiring', hook: 'h', proof: 'p', ask: 'a' },
        testCtx(),
        deps,
      ),
    ).toMatchObject({
      code: 'invalid_input',
    });

    const r = await draftOutreach(
      {
        contact_id: 'ct_0002',
        role_id: R.linearDraft,
        tier: 'warm_other',
        hook: 'Hi Dev, Linear is hiring for Insights.',
        proof: 'I built a self-serve analytics product 400 teams use.',
        ask: 'Coffee this week?',
      },
      testCtx(),
      deps,
    );
    const out = ok(r);
    expect(r.status === 'ok' && r.eventIds).toHaveLength(1);
    expect(out.outreach).toMatchObject({ status: 'drafted', gmail_draft_id: null, md_path: `outreach/ct_0002-${R.linearDraft}.md` });
    const md = readFileSync(join(v.dir, out.outreach.md_path as string), 'utf8');
    expect(md.startsWith(`---\nid: "${out.outreach.id}"\ntype: "outreach"\n---`)).toBe(true);
    expect(readOutreachSections(md)).toMatchObject({ hook: 'Hi Dev, Linear is hiring for Insights.', ask: 'Coffee this week?' });
  });

  it('cannot redraft once in Gmail', async () => {
    const r = await draftOutreach(
      { contact_id: 'ct_0003', role_id: R.linearDraft, tier: 'bridge', hook: 'h', proof: 'p', ask: 'a' },
      testCtx(),
      linearDeps(),
    );
    expect(r).toMatchObject({ status: 'error', code: 'conflict' });
  });

  it('outreach.to_gmail creates a draft only, once', async () => {
    const gmail = createDryRunGmail();
    const deps = testDeps(v, { ask: createFakeAsk(v.db, scriptByName()), gmail });
    const out = ok(await outreachToGmailHandler({ outreach_id: 'or_0001' }, testCtx(), deps));
    expect(out.gmail_draft_id).toBe('dryrun-1');
    expect(out.outreach.status).toBe('in_gmail');
    expect(gmail.drafts[0]?.body).toBe(
      'Your insights team is shipping fast.\n\nI built a self-serve analytics product 400 teams use.\n\n20 minutes next week?\n',
    );
    const again = ok(await outreachToGmailHandler({ outreach_id: 'or_0001' }, testCtx(), deps));
    expect(again.gmail_draft_id).toBe('dryrun-1');
    expect(gmail.drafts).toHaveLength(1);
  });

  it('outreach.to_gmail without a client is backend_unavailable; dry run calls nothing', async () => {
    const deps = testDeps(v, { ask: createFakeAsk(v.db, scriptByName()) });
    expect(await outreachToGmailHandler({ outreach_id: 'or_0001' }, testCtx(), deps)).toMatchObject({ code: 'backend_unavailable' });
    expect(ok(await outreachToGmailHandler({ outreach_id: 'or_0001' }, testCtx({ dryRun: true }), deps)).gmail_draft_id).toBe('dry-run');
  });

  it('outreach.send is unimplemented', async () => {
    expect(await outreachSendHandler({ outreach_id: 'or_0001' }, testCtx({ actor: 'human' }), linearDeps())).toMatchObject({
      status: 'error',
      code: 'unimplemented',
    });
  });

  it('template drafts pass the writing rules for every tier', () => {
    const story = { data: { wins: ['Launched a self-serve analytics product to 400 teams'] }, text: '400 teams' };
    const voice = { data: {}, text: 'Punchy.' };
    for (const tier of ['warm_hiring', 'warm_other', 'bridge', 'cold_hiring', 'cold_other'] as const) {
      const d = templateDraft({
        tier,
        contact: { name: 'Maya R.', headline: 'Head of Product' },
        via: { name: 'Dev P.', headline: null },
        role: { title: 'Product Lead, Insights' },
        company: { name: 'Linear' },
        story,
        voice,
      });
      expect(checkDraft(d, story.text, { bridge: tier === 'bridge' })).toEqual([]);
    }
  });
});

describe('end to end on a picked role (dry run)', () => {
  it('finds people, classifies tiers, and lands four drafts in (dry-run) Gmail', async () => {
    const gmail = createDryRunGmail();
    const prompts: string[] = [];
    const deps = testDeps(v, {
      ask: createFakeAsk(v.db, scriptByName(0.95)),
      linkedin: linkedin(),
      gmail,
      writer: {
        async write(p) {
          prompts.push(p.user);
          return templateDraft({
            tier: p.tier,
            contact: { name: 'X', headline: null },
            via: { name: 'Eli F.', headline: null },
            role: { title: 'Principal PM, AI Platform' },
            company: { name: 'Airtable' },
            story: { data: { wins: ['Launched a self-serve analytics product to 400 teams'] }, text: '' },
            voice: { data: {}, text: '' },
          });
        },
      },
    });
    const ctx = testCtx();
    const found = ok(await findPeople({ role_id: R.airtableOnDeck }, ctx, deps)).found;
    for (const f of found) ok(await classifyContact({ contact_id: f.contact.id, role_id: R.airtableOnDeck }, ctx, deps));
    const tiers = v.db
      .prepare('SELECT c.name, l.tier FROM contact_link l JOIN contact c ON c.id = l.contact_id WHERE l.role_id = ? ORDER BY c.name')
      .all(R.airtableOnDeck) as Array<{ name: string; tier: string }>;
    expect(Object.fromEntries(tiers.map((t) => [t.name, t.tier]))).toEqual({
      'Ana B.': 'warm_hiring',
      'Ben C.': 'warm_other',
      'Cara D.': 'bridge',
      'Gus H.': 'cold_hiring',
      'Ida J.': 'cold_other',
    });

    const byName = Object.fromEntries(found.map((f) => [f.contact.name, f.contact.id]));
    const drafted: string[] = [];
    for (const name of ['Ana B.', 'Ben C.', 'Cara D.', 'Gus H.', 'Ida J.']) {
      const r = await composeAndDraft(deps, { contact_id: byName[name] as string, role_id: R.airtableOnDeck }, ctx);
      if (name === 'Ida J.') {
        expect(r).toMatchObject({ status: 'error', code: 'conflict' });
        continue;
      }
      drafted.push(ok(r).outreach.id);
    }
    for (const id of drafted) ok(await outreachToGmailHandler({ outreach_id: id }, ctx, deps));

    expect(gmail.drafts).toHaveLength(4);
    for (const d of gmail.drafts) expect(d.body).not.toMatch(/—|–/);
    // Bridge goes to the mutual: prompt names Eli F. as the recipient.
    expect(prompts.some((p) => p.includes('RECIPIENT: Eli F.'))).toBe(true);
    // Story and Voice reach the writer.
    expect(prompts[0]).toContain('400 teams');
    expect(prompts[0]).toContain('No em dashes');
    expect(count(v, "SELECT COUNT(*) n FROM outreach WHERE role_id = ? AND status = 'in_gmail'", R.airtableOnDeck)).toBe(4);
  });

  it('every lane H op has a handler', () => {
    expect(Object.keys(handlers).sort()).toEqual([
      'outreach.draft',
      'outreach.send',
      'outreach.to_gmail',
      'people.classify',
      'people.find',
      'people.link',
    ]);
  });
});
