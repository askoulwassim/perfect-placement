import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTACT_DEGREES, type OpContext, type OpOutcome } from '@perfect-placement/contracts';
import { FIXTURE_ROLE_IDS } from '@perfect-placement/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDryRunGmail, type DryRunGmail } from '../integrations/gmail/index.js';
import { createLinkedInAdapter, createRecordedDriver, type Recording, SYNTHETIC_RECORDING } from '../integrations/linkedin/index.js';
import type { EngineServices } from '../ops/services.js';
import { ctxAt, type FixtureEngine, type FixtureOptions, openFixtureEngine } from '../testing/index.js';
import { checkDraft, handlers, readOutreachSections, templateDraft, tierFor } from './index.js';

/*
 * Lane H ops through runOp on a temp fixture vault: lane A repos, runOp's emitter + staged vault,
 * the real resolver with a scripted fake Kev, dry-run LinkedIn and Gmail adapters.
 */

const R = FIXTURE_ROLE_IDS;
// biome-ignore lint/suspicious/noExplicitAny: test helper returns loosely typed output
const ok = (o: OpOutcome<unknown>): any => {
  if (o.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(o)}`);
  return o.output;
};
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

/** Kev classifies by contact name (p configurable). */
const kevByName =
  (p = 0.95): NonNullable<FixtureOptions['kev']> =>
  (_q, req) => ({ value: WHO[(req.state as Record<string, string>).contact_name ?? ''] ?? 'other', p });

let v: FixtureEngine;
let gmail: DryRunGmail;
const testCtx = (over: Partial<OpContext> = {}): OpContext => ctxAt('agent', over);
const linkedin = (rec: Recording = AIRTABLE) => createLinkedInAdapter({ driver: createRecordedDriver(rec), mode: 'dry-run', minDelayS: 0 });

/** (Re)open the engine with these adapters. */
function open(opts: { p?: number; services?: EngineServices; config?: Record<string, unknown> } = {}) {
  v?.cleanup();
  gmail = createDryRunGmail();
  v = openFixtureEngine({
    kev: kevByName(opts.p),
    services: { linkedin: linkedin(), gmail, ...(opts.services ?? {}) },
    ...(opts.config ? { config: opts.config } : {}),
  });
}
const count = (sql: string, ...args: unknown[]) => (v.db.prepare(sql).get(...args) as { n: number }).n;
const run = (name: string, input: unknown, c: OpContext = testCtx()) => v.runOp(name, input, c);
/** A known work address for a fixture contact (#132: a recipient with no address gets no Gmail draft). */
const knownEmail = (contactId: string, email: string) =>
  v.db.prepare(`UPDATE contact SET email = ?, email_source = 'gmail', email_confidence = 1 WHERE id = ?`).run(email, contactId);

beforeEach(() => open());
afterEach(() => v.cleanup());

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
  it('picks an active role first (#105), refuses unpicked inbox or archived roles', async () => {
    const r = await run('people.find', { role_id: R.datadogActive, dry_run: true }, testCtx());
    expect(r).toMatchObject({ status: 'error', code: 'conflict' }); // a dry run picks nothing
    expect(await run('people.find', { role_id: 'nope_nope' }, testCtx())).toMatchObject({ status: 'error', code: 'not_found' });
  });

  it('upserts contacts, links them with provisional tiers, emits contact_found, logs the run', async () => {
    const before = count('SELECT COUNT(*) n FROM contact');
    const out = ok(await run('people.find', { role_id: R.airtableOnDeck }, testCtx()));
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
    expect(count('SELECT COUNT(*) n FROM contact') - before).toBe(6);
    expect(count("SELECT COUNT(*) n FROM event WHERE type = 'contact_found'")).toBe(
      5 + count("SELECT COUNT(*) n FROM event WHERE type = 'contact_found' AND ts < '2026-10-08T12:00:00.000Z'"),
    );
    const findRun = v.db.prepare("SELECT summary_json FROM run WHERE op = 'people.find'").get() as { summary_json: string };
    expect(JSON.parse(findRun.summary_json)).toMatchObject({ linkedin_profiles_read: 6, capped: false, found: 5 });
    // Stored fields only: name, headline, URL, email, source. Notes stay empty.
    const ana = v.db.prepare("SELECT * FROM contact WHERE name = 'Ana B.'").get() as Record<string, unknown>;
    expect(ana).toMatchObject({ linkedin_url: 'https://www.linkedin.com/in/fixture-ana-b', email: null, notes: null, source: 'linkedin' });

    // Re-run is idempotent: no new contacts or links.
    const links = count('SELECT COUNT(*) n FROM contact_link');
    ok(await run('people.find', { role_id: R.airtableOnDeck }, testCtx()));
    expect(count('SELECT COUNT(*) n FROM contact_link')).toBe(links);
  });

  it('dedupes against existing contacts by LinkedIn URL', async () => {
    // Linear draft-ready role: fixture already has Maya R., Dev P., Lina K., Priya T.
    open({ services: { linkedin: linkedin(SYNTHETIC_RECORDING) } });
    const out = ok(await run('people.find', { role_id: R.linearDraft }, testCtx()));
    const maya = out.found.find((f) => f.contact.name === 'Maya R.');
    expect(maya?.contact.id).toBe('ct_0001');
    expect(maya?.link.id).toBe('cl_0001');
    expect(count("SELECT COUNT(*) n FROM contact WHERE name = 'Maya R.'")).toBe(1);
  });

  it('dry run writes nothing', async () => {
    const snap = () => ['contact', 'contact_link', 'event', 'run'].map((t) => count(`SELECT COUNT(*) n FROM ${t}`));
    const before = snap();
    const out = ok(await run('people.find', { role_id: R.airtableOnDeck, dry_run: true }, testCtx()));
    expect(out.found).toHaveLength(5);
    expect(snap()).toEqual(before);
  });

  it('enforces the daily LinkedIn cap across runs', async () => {
    open({ config: { linkedin: { max_profiles_per_day: 7 } } });
    const first = ok(await run('people.find', { role_id: R.airtableOnDeck }, testCtx()));
    expect(first.capped).toBe(false);
    // 6 read, 1 left: the next picked role is capped after one card.
    const second = ok(await run('people.find', { role_id: R.stripeOnDeck }, testCtx()));
    expect(second.capped).toBe(true);
    const third = ok(await run('people.find', { role_id: R.stripeOnDeck }, testCtx()));
    expect(third.capped).toBe(true);
    const reads = v.db
      .prepare("SELECT json_extract(summary_json, '$.linkedin_profiles_read') n FROM run WHERE op = 'people.find' ORDER BY started_at, id")
      .all() as Array<{ n: number }>;
    expect(reads.reduce((s, r) => s + r.n, 0)).toBeLessThanOrEqual(7);
    // Next UTC day the budget resets.
    const tomorrow = ok(
      await run('people.find', { role_id: R.stripeOnDeck }, testCtx({ now: () => new Date('2026-10-09T08:00:00.000Z') })),
    );
    expect(tomorrow.capped).toBe(false);
  });

  it('accepts JD and team-page hints from the skill, deduped by email', async () => {
    const out = ok(
      await run('people.find', {
        role_id: R.linearDraft,
        hints: [
          { name: 'Omar S.', email: 'omar.s@example.com', source: 'jd' },
          { name: 'Zoe Q.', headline: 'VP Product', source: 'company_site' },
        ],
      }),
    );
    expect(out.found.map((f) => f.contact.id)).toContain('ct_0004');
    const zoe = out.found.find((f) => f.contact.name === 'Zoe Q.');
    expect(zoe?.link).toMatchObject({ degree: 'cold', tier: 'cold_other' });
  });
});

describe('people.find: the agent reads LinkedIn via Claude in Chrome (#82)', () => {
  /** No recorded adapter: LinkedIn people come only from the agent's hints. Placeholder people only. */
  const agentOnly = (config?: Record<string, unknown>) => open({ services: { linkedin: undefined }, ...(config ? { config } : {}) });
  const li = (slug: string, extra: Record<string, unknown> = {}) => ({
    name: `Fixture ${slug}`,
    headline: 'Product at Airtable',
    linkedin_url: `https://www.linkedin.com/in/fixture-${slug}/?miniProfile=x`,
    source: 'linkedin',
    degree: '1',
    ...extra,
  });
  /** Insertion order: runs in one test share a timestamp, and ulid order within a millisecond is random. */
  const lastFind = () => {
    const row = v.db.prepare("SELECT summary_json FROM run WHERE op = 'people.find' ORDER BY rowid DESC").get() as { summary_json: string };
    return JSON.parse(row.summary_json);
  };

  it('records linkedin_mode agent, keeps degree / via / hiring team, stores only the allowed fields', async () => {
    agentOnly();
    const out = ok(
      await run('people.find', {
        role_id: R.airtableOnDeck,
        linkedin: { pages_opened: 3 },
        hints: [
          li('ana', { hiring_team: true }),
          li('cara', {
            degree: '2',
            via: { name: 'Fixture eli', headline: 'Data', linkedin_url: 'https://www.linkedin.com/in/fixture-eli' },
          }),
          li('gus', { degree: 'cold' }),
          { name: 'Omar S.', source: 'jd' },
        ],
      }),
    );
    expect(out.linkedin).toEqual({ mode: 'agent', people: 3, rejected: 0, budget_left: 36, reason: null });
    const byName = Object.fromEntries(out.found.map((f: { contact: { name: string } }) => [f.contact.name, f]));
    expect(byName['Fixture ana'].link).toMatchObject({ degree: '1', is_hiring_team: true, tier: 'warm_hiring' });
    expect(byName['Fixture cara'].link).toMatchObject({ degree: '2', tier: 'bridge' });
    expect(byName['Fixture gus'].link).toMatchObject({ degree: 'cold', tier: 'cold_other' });
    expect(byName['Omar S.'].link).toMatchObject({ degree: 'cold' });
    const ana = v.db.prepare("SELECT * FROM contact WHERE name = 'Fixture ana'").get() as Record<string, unknown>;
    expect(ana).toMatchObject({ linkedin_url: 'https://www.linkedin.com/in/fixture-ana', source: 'linkedin', notes: null, email: null });
    const eli = v.db.prepare('SELECT name FROM contact WHERE id = ?').get(byName['Fixture cara'].link.via_contact_id);
    expect(eli).toEqual({ name: 'Fixture eli' });
    // 3 people + the via mutual count against the daily budget.
    expect(lastFind()).toMatchObject({
      linkedin_mode: 'agent',
      linkedin_people: 3,
      linkedin_profiles_read: 4,
      linkedin_pages_opened: 3,
      linkedin_reason: null,
      capped: false,
    });
  });

  it('without the agent reading LinkedIn the run is dry-run with a reason, never agent', async () => {
    agentOnly();
    const none = ok(await run('people.find', { role_id: R.airtableOnDeck, hints: [{ name: 'Omar S.', source: 'jd' }] }));
    expect(none.linkedin).toMatchObject({ mode: 'dry-run', people: 0, reason: 'not_reported' });
    const skipped = ok(await run('people.find', { role_id: R.airtableOnDeck, linkedin: { pages_opened: 0, skipped: 'checkpoint' } }));
    expect(skipped.linkedin).toMatchObject({ mode: 'dry-run', reason: 'checkpoint' });
    expect(lastFind()).toMatchObject({ linkedin_mode: 'dry-run', linkedin_reason: 'checkpoint', linkedin_profiles_read: 0 });
    // The recorded adapter (tests) is dry-run too.
    open();
    expect(ok(await run('people.find', { role_id: R.airtableOnDeck })).linkedin).toMatchObject({ mode: 'dry-run', reason: 'dry_run' });
  });

  it('config off or dry-run: LinkedIn hints are rejected', async () => {
    agentOnly({ linkedin: { mode: 'off' } });
    const off = ok(await run('people.find', { role_id: R.airtableOnDeck, hints: [li('ana')] }));
    expect(off.found).toHaveLength(0);
    expect(off.linkedin).toMatchObject({ mode: 'off', people: 0, rejected: 1, reason: 'off' });
    agentOnly({ linkedin: { mode: 'dry-run' } });
    const dry = ok(await run('people.find', { role_id: R.airtableOnDeck, hints: [li('ana')], linkedin: { pages_opened: 1 } }));
    expect(dry.linkedin).toMatchObject({ mode: 'dry-run', rejected: 1, reason: 'dry_run' });
  });

  it('enforces the profile URL allowlist', async () => {
    agentOnly();
    const out = ok(
      await run('people.find', {
        role_id: R.airtableOnDeck,
        linkedin: { pages_opened: 1 },
        hints: [
          li('ok'),
          li('msg', { linkedin_url: 'https://www.linkedin.com/messaging/thread/1/' }),
          li('evil', { linkedin_url: 'https://evil.example.com/in/fixture-evil' }),
          li('nourl', { linkedin_url: null }),
          li('company', { linkedin_url: 'https://www.linkedin.com/company/airtable/people/' }),
          li('badvia', { degree: '2', via: { name: 'X', linkedin_url: 'https://www.linkedin.com/mynetwork/' } }),
        ],
      }),
    );
    expect(out.found.map((f: { contact: { name: string } }) => f.contact.name).sort()).toEqual(['Fixture badvia', 'Fixture ok']);
    expect(out.linkedin).toMatchObject({ mode: 'agent', people: 2, rejected: 4 });
    // A via outside the allowlist is dropped, the person kept.
    expect(out.found.find((f: { contact: { name: string } }) => f.contact.name === 'Fixture badvia').link.via_contact_id).toBeNull();
  });

  it('rejects hints beyond the daily budget, the mutual cap, and flags a run over the page cap', async () => {
    agentOnly({ linkedin: { max_profiles_per_day: 3, max_mutual_expansions: 1, max_pages_per_run: 2 } });
    const via = (n: string) => ({ name: `Fixture ${n}`, linkedin_url: `https://www.linkedin.com/in/fixture-${n}` });
    const first = ok(
      await run('people.find', {
        role_id: R.airtableOnDeck,
        linkedin: { pages_opened: 4 },
        hints: [li('a', { degree: '2', via: via('m1') }), li('b', { degree: '2', via: via('m2') }), li('c'), li('d')],
      }),
    );
    // a + m1 = 2, b (its via dropped: 1 expansion max) = 3, then c and d are over budget.
    expect(first.found.map((f: { contact: { name: string } }) => f.contact.name)).toEqual(['Fixture a', 'Fixture b']);
    expect(first.found[1].link.via_contact_id).toBeNull();
    expect(first.capped).toBe(true);
    expect(first.linkedin).toMatchObject({ mode: 'agent', people: 2, rejected: 2, budget_left: 0 });
    expect(lastFind()).toMatchObject({ linkedin_profiles_read: 3, linkedin_over_page_cap: true, capped: true });
    expect(v.db.prepare("SELECT status FROM run WHERE op = 'people.find'").get()).toEqual({ status: 'partial' });
    // Budget spent for today: the next read is refused entirely.
    const second = ok(await run('people.find', { role_id: R.stripeOnDeck, hints: [li('e')], linkedin: { pages_opened: 1 } }));
    expect(second.found).toHaveLength(0);
    expect(second.linkedin).toMatchObject({ people: 0, rejected: 1, budget_left: 0 });
    expect(second.capped).toBe(true);
  });

  it('dry run counts nothing against the budget', async () => {
    agentOnly();
    const out = ok(await run('people.find', { role_id: R.airtableOnDeck, dry_run: true, hints: [li('a')], linkedin: { pages_opened: 1 } }));
    expect(out.linkedin).toMatchObject({ mode: 'agent', people: 1 });
    expect(count("SELECT COUNT(*) n FROM run WHERE op = 'people.find'")).toBe(0);
  });
});

describe('people.classify', () => {
  it('applies a confident pick to the link', async () => {
    const found = ok(await run('people.find', { role_id: R.airtableOnDeck }, testCtx())).found;
    const ana = found.find((f) => f.contact.name === 'Ana B.');
    const out = ok(await run('people.classify', { contact_id: ana?.contact.id, role_id: R.airtableOnDeck }, testCtx()));
    expect(out).toMatchObject({ role: 'hiring_manager', tier: 'warm_hiring', p: 0.95 });
    const link = v.db.prepare('SELECT tier, is_hiring_team FROM contact_link WHERE id = ?').get(ana?.link.id);
    expect(link).toEqual({ tier: 'warm_hiring', is_hiring_team: 1 });
    expect(v.kev.calls[0]).toMatchObject({ decision: 'people.classify', impact: 'low', subject: { type: 'contact' } });
    const q = v.kev.calls[0]?.questions[0];
    expect(q?.type === 'choice' && q.options).toEqual(['hiring_manager', 'hiring_team', 'recruiter', 'peer', 'unrelated', 'other']);
    expect(count("SELECT COUNT(*) n FROM decision WHERE id = ? AND kind = 'people.classify'", out.decision_id)).toBe(1);
  });

  it('a low-confidence pick is applied with a 24h undo (#24 grid: low impact never goes to Needs you)', async () => {
    open({ p: 0.55 });
    const found = ok(await run('people.find', { role_id: R.airtableOnDeck }, testCtx())).found;
    const gus = found.find((f) => f.contact.name === 'Gus H.');
    const out = ok(await run('people.classify', { contact_id: gus?.contact.id, role_id: R.airtableOnDeck }, testCtx()));
    expect(out).toMatchObject({ tier: 'cold_hiring', outcome: 'auto_undo' });
    expect(v.db.prepare('SELECT tier FROM contact_link WHERE id = ?').get(gus?.link.id)).toEqual({ tier: 'cold_hiring' });
    expect(v.db.prepare('SELECT policy_outcome FROM decision WHERE id = ?').get(out.decision_id)).toEqual({
      policy_outcome: 'auto_undo',
    });
  });

  it('a human pick from Needs you applies through the decision action (people.classify role: $value)', async () => {
    const found = ok(await run('people.find', { role_id: R.airtableOnDeck }, testCtx())).found;
    const ben = found.find((f: { contact: { name: string } }) => f.contact.name === 'Ben C.');
    const out = ok(await run('people.classify', { contact_id: ben.contact.id, role_id: R.airtableOnDeck }, testCtx()));
    const d = v.db.prepare('SELECT action_json FROM decision WHERE id = ?').get(out.decision_id) as { action_json: string };
    expect(JSON.parse(d.action_json)).toEqual({
      op: 'people.classify',
      input: { contact_id: ben.contact.id, role_id: R.airtableOnDeck, role: '$value' },
    });
    // The human changes the pick: tier follows the chosen role.
    const direct = ok(
      await run('people.classify', { contact_id: ben.contact.id, role_id: R.airtableOnDeck, role: 'hiring_team' }, ctxAt('human')),
    );
    expect(direct).toMatchObject({ role: 'hiring_team', tier: 'warm_hiring', outcome: 'auto' });
    expect(v.db.prepare('SELECT tier FROM contact_link WHERE id = ?').get(ben.link.id)).toEqual({ tier: 'warm_hiring' });
  });

  it('needs an existing link', async () => {
    expect(await run('people.classify', { contact_id: 'ct_0006', role_id: R.linearDraft }, testCtx())).toMatchObject({
      status: 'error',
      code: 'not_found',
    });
  });
});

describe('people.link', () => {
  it('rejects a tier that does not match degree x hiring team, upserts otherwise', async () => {
    const base = { contact_id: 'ct_0006', company_id: null, role_id: R.stripeOnDeck, via_contact_id: null };
    expect(await run('people.link', { ...base, degree: 'cold', tier: 'warm_hiring', is_hiring_team: true }, testCtx())).toMatchObject({
      code: 'invalid_input',
    });
    const a = ok(await run('people.link', { ...base, degree: 'cold', tier: 'cold_hiring', is_hiring_team: true }, testCtx()));
    expect(a.link.company_id).toBe('stripe');
    const b = ok(await run('people.link', { ...base, degree: '1', tier: 'warm_hiring', is_hiring_team: true }, testCtx()));
    expect(b.link.id).toBe(a.link.id);
  });
});

describe('outreach', () => {
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
    const bad = await run('outreach.draft', {
      contact_id: 'ct_0002',
      role_id: R.linearDraft,
      tier: 'warm_other',
      hook: 'Hi Dev — quick one.',
      proof: 'p',
      ask: 'a',
    });
    expect(bad).toMatchObject({ status: 'error', code: 'invalid_input' });
    expect(
      await run('outreach.draft', { contact_id: 'ct_0002', role_id: R.linearDraft, tier: 'warm_hiring', hook: 'h', proof: 'p', ask: 'a' }),
    ).toMatchObject({
      code: 'invalid_input',
    });

    const r = await run('outreach.draft', {
      contact_id: 'ct_0002',
      role_id: R.linearDraft,
      tier: 'warm_other',
      hook: 'Hi Dev, Linear is hiring for Insights.',
      proof: 'I built a self-serve analytics product 400 teams use.',
      ask: 'Coffee this week?',
    });
    const out = ok(r);
    expect(r.status === 'ok' && r.eventIds).toHaveLength(1);
    expect(out.outreach).toMatchObject({ status: 'drafted', gmail_draft_id: null, md_path: `outreach/ct_0002-${R.linearDraft}.md` });
    const md = readFileSync(join(v.home, out.outreach.md_path as string), 'utf8');
    expect(md.startsWith(`---\nid: "${out.outreach.id}"\ntype: "outreach"\n---`)).toBe(true);
    expect(readOutreachSections(md)).toMatchObject({ hook: 'Hi Dev, Linear is hiring for Insights.', ask: 'Coffee this week?' });
  });

  it('cannot redraft once in Gmail', async () => {
    const r = await run('outreach.draft', {
      contact_id: 'ct_0003',
      role_id: R.linearDraft,
      tier: 'bridge',
      hook: 'h',
      proof: 'p',
      ask: 'a',
    });
    expect(r).toMatchObject({ status: 'error', code: 'conflict' });
  });

  it('outreach.to_gmail is medium: an agent without confidence waits in Needs you', async () => {
    knownEmail('ct_0001', 'maya@linear.example');
    expect((await run('outreach.to_gmail', { outreach_id: 'or_0001' }, testCtx())).status).toBe('requires_human');
    expect(gmail.drafts).toHaveLength(0);
    // With confidence it goes through the grid (#17): confident = auto.
    const out = ok(await run('outreach.to_gmail', { outreach_id: 'or_0001' }, testCtx({ confidence: { p: 0.95, backend: 'agent' } })));
    expect(out.gmail_draft_id).toBe('dryrun-1');
  });

  it('outreach.to_gmail creates a draft only, once', async () => {
    knownEmail('ct_0001', 'maya@linear.example');
    const out = ok(await run('outreach.to_gmail', { outreach_id: 'or_0001' }, ctxAt('human')));
    expect(out.gmail_draft_id).toBe('dryrun-1');
    expect(out.outreach.status).toBe('in_gmail');
    expect(gmail.drafts[0]?.body).toBe(
      'Hi Maya,\n\nYour insights team is shipping fast.\n\nI built a self-serve analytics product 400 teams use.\n\n20 minutes next week?\n\nThanks,\nSam\n',
    );
    const again = ok(await run('outreach.to_gmail', { outreach_id: 'or_0001' }, ctxAt('human')));
    expect(again.gmail_draft_id).toBe('dryrun-1');
    expect(gmail.drafts).toHaveLength(1);
  });

  it('outreach.to_gmail without a client or a draft id is backend_unavailable (use a Gmail-capable agent run); dry run calls nothing', async () => {
    open({ services: { gmail: undefined } });
    knownEmail('ct_0001', 'maya@linear.example');
    const r = await run('outreach.to_gmail', { outreach_id: 'or_0001' }, ctxAt('human'));
    expect(r).toMatchObject({ code: 'backend_unavailable' });
    expect((r as { message: string }).message).toMatch(/agent run/);
    expect(ok(await run('outreach.to_gmail', { outreach_id: 'or_0001' }, ctxAt('human', { dryRun: true }))).gmail_draft_id).toBe('dry-run');
  });

  it('outreach.to_gmail with gmail_draft_id records the agent-made draft: no client call, in_gmail, Connect done', async () => {
    open({ services: { gmail: undefined } });
    knownEmail('ct_0001', 'maya@linear.example');
    const roleId = ok(await run('outreach.get', { outreach_id: 'or_0001' })).outreach.role_id;
    // Medium impact: an agent without confidence still waits in Needs you.
    expect((await run('outreach.to_gmail', { outreach_id: 'or_0001', gmail_draft_id: 'r-agent-1' })).status).toBe('requires_human');
    const out = ok(
      await run(
        'outreach.to_gmail',
        { outreach_id: 'or_0001', gmail_draft_id: 'r-agent-1' },
        testCtx({ confidence: { p: 0.95, backend: 'agent' } }),
      ),
    );
    expect(out).toMatchObject({ gmail_draft_id: 'r-agent-1', outreach: { status: 'in_gmail', gmail_draft_id: 'r-agent-1' } });
    expect(ok(await run('outreach.get', { outreach_id: 'or_0001' })).outreach.status).toBe('in_gmail');
    expect(ok(await run('roles.get', { role_id: roleId }, ctxAt('human'))).application?.stage).toBe('fill');
    // Idempotent: a second record keeps the first id.
    const again = ok(await run('outreach.to_gmail', { outreach_id: 'or_0001', gmail_draft_id: 'r-agent-2' }, ctxAt('human')));
    expect(again.gmail_draft_id).toBe('r-agent-1');
  });

  it('outreach.to_gmail with gmail_draft_id still enforces the writing rules', async () => {
    const o = ok(await run('outreach.get', { outreach_id: 'or_0001' })).outreach;
    const file = join(v.home, o.md_path as string);
    writeFileSync(file, readFileSync(file, 'utf8').replace('## Hook\n\n', '## Hook\n\nA hook \u2014 with a dash. '));
    const r = await run('outreach.to_gmail', { outreach_id: 'or_0001', gmail_draft_id: 'r-x' }, ctxAt('human'));
    expect(r).toMatchObject({ status: 'error', code: 'invalid_input' });
    expect(ok(await run('outreach.get', { outreach_id: 'or_0001' })).outreach.status).toBe('drafted');
  });

  it('outreach.send is unimplemented, for humans too', async () => {
    expect(await run('outreach.send', { outreach_id: 'or_0001' }, ctxAt('human'))).toMatchObject({
      status: 'error',
      code: 'unimplemented',
    });
  });

  it('outreach.get / outreach.list / contacts.get read through ops', async () => {
    const g = ok(await run('outreach.get', { outreach_id: 'or_0001' }));
    expect(g.hook).toBe('Your insights team is shipping fast.');
    expect(g.variants).toHaveLength(4);
    expect(g.variants.every((x: { hook: string }) => x.hook === g.hook)).toBe(true);
    expect(ok(await run('outreach.list', { role_id: R.linearDraft })).items.map((o: { id: string }) => o.id)).toContain('or_0001');
    const c = ok(await run('contacts.get', { contact_id: 'ct_0001' }));
    expect(c.contact.name).toBe('Maya R.');
    expect(c.links.length).toBeGreaterThan(0);
    expect(await run('contacts.get', { contact_id: 'nope' })).toMatchObject({ code: 'not_found' });
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
  it('finds people, classifies tiers, and lands the drafts with an address in (dry-run) Gmail', async () => {
    const ctx = testCtx();
    const found = ok(await run('people.find', { role_id: R.airtableOnDeck }, ctx)).found as Array<{
      contact: { id: string; name: string };
    }>;
    for (const f of found) ok(await run('people.classify', { contact_id: f.contact.id, role_id: R.airtableOnDeck }, ctx));
    const tiers = v.db
      .prepare('SELECT c.name, l.tier FROM contact_link l JOIN contact c ON c.id = l.contact_id WHERE l.role_id = ? ORDER BY c.name')
      .all(R.airtableOnDeck) as Array<{ name: string; tier: string }>;
    const tierOf = Object.fromEntries(tiers.map((t) => [t.name, t.tier]));
    expect(tierOf).toEqual({
      'Ana B.': 'warm_hiring',
      'Ben C.': 'warm_other',
      'Cara D.': 'bridge',
      'Gus H.': 'cold_hiring',
      'Ida J.': 'cold_other',
    });

    const byName = Object.fromEntries(found.map((f) => [f.contact.name, f.contact.id]));
    const story = { data: { wins: ['Launched a self-serve analytics product to 400 teams'] }, text: '' };
    const drafted: string[] = [];
    // cold_other is skipped unless asked (docs/architecture.md "Connect").
    for (const name of ['Ana B.', 'Ben C.', 'Cara D.', 'Gus H.']) {
      const tier = tierOf[name] as 'warm_hiring';
      const text = templateDraft({
        tier,
        contact: { name, headline: null },
        via: { name: 'Eli F.', headline: null },
        role: { title: 'Principal PM, AI Platform' },
        company: { name: 'Airtable' },
        story,
        voice: { data: {}, text: '' },
      });
      drafted.push(
        ok(await run('outreach.draft', { contact_id: byName[name], role_id: R.airtableOnDeck, tier, ...text }, ctx)).outreach.id,
      );
    }
    // Work addresses for the three direct recipients; the bridge's mutual (Eli F.) has none.
    for (const name of ['Ana B.', 'Ben C.', 'Gus H.'])
      knownEmail(byName[name] as string, `${name.split(' ')[0]?.toLowerCase()}@airtable.example`);
    const sure = testCtx({ confidence: { p: 0.95, backend: 'agent' } });
    const results = [];
    for (const id of drafted) results.push(await run('outreach.to_gmail', { outreach_id: id }, sure));

    expect(gmail.drafts).toHaveLength(3);
    for (const d of gmail.drafts) expect(d.to).toMatch(/@airtable\.example$/);
    for (const d of gmail.drafts) expect(d.body).not.toMatch(/\u2014|\u2013/);
    // #132: the bridge goes to the mutual, who has no email on file: no Gmail draft without To; it stays in the vault.
    expect(results.filter((r) => r.status === 'error').map((r) => r.status === 'error' && r.code)).toEqual(['conflict']);
    expect(count("SELECT COUNT(*) n FROM outreach WHERE role_id = ? AND status = 'in_gmail'", R.airtableOnDeck)).toBe(3);
    expect(count("SELECT COUNT(*) n FROM outreach WHERE role_id = ? AND status = 'drafted' AND tier = 'bridge'", R.airtableOnDeck)).toBe(1);
  });

  it('every lane H op has a handler', () => {
    expect(Object.keys(handlers).sort()).toEqual([
      'outreach.draft',
      'outreach.send',
      'outreach.to_gmail',
      'people.classify',
      'people.email_checked',
      'people.fallback',
      'people.find',
      'people.find_email',
      'people.link',
      'people.set_path',
    ]);
  });
});
