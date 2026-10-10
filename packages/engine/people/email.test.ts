import type { OpContext, OpOutcome } from '@perfect-placement/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDryRunGmail, type DryRunGmail } from '../integrations/gmail/index.js';
import type { EngineServices } from '../ops/services.js';
import { ctxAt, type FixtureEngine, openFixtureEngine } from '../testing/index.js';
import {
  dossierDomain,
  type EmailProvider,
  emailsIn,
  learnFormat,
  localFor,
  type MxResolver,
  nameParts,
  patternsOf,
  rankCandidates,
} from './index.js';

/*
 * #37: contact emails. Pure pattern mechanics, then people.find_email through runOp on a temp fixture
 * vault with a synthetic company at acme.example, a fake MX resolver (no DNS) and placeholder people.
 */

// biome-ignore lint/suspicious/noExplicitAny: test helper returns loosely typed output
const ok = (o: OpOutcome<unknown>): any => {
  if (o.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(o)}`);
  return o.output;
};

describe('names and formats', () => {
  it('parses names: accents, honorifics, suffixes, initials', () => {
    expect(nameParts("Dr. María-José O'Neil, PhD")).toEqual({ first: 'mariajose', last: 'oneil', lastInitial: 'o' });
    expect(nameParts('Ana B.')).toEqual({ first: 'ana', last: null, lastInitial: 'b' });
    expect(nameParts('Cher')).toEqual({ first: 'cher', last: null, lastInitial: null });
    expect(nameParts('J')).toBeNull();
  });

  it('generates each format and recognizes it back', () => {
    const n = nameParts('Maya Rivera');
    if (!n) throw new Error('name');
    expect(['first.last', 'flast', 'first', 'firstl', 'f.last', 'last'].map((p) => localFor(p as never, n))).toEqual([
      'maya.rivera',
      'mrivera',
      'maya',
      'mayar',
      'm.rivera',
      'rivera',
    ]);
    expect(patternsOf('M.Rivera+jobs@acme.example', n)).toEqual(['f.last']);
    // An initial-only last name can fill only first and firstl.
    const ana = nameParts('Ana B.');
    if (!ana) throw new Error('name');
    expect(localFor('first.last', ana)).toBeNull();
    expect(localFor('firstl', ana)).toBe('anab');
  });

  it('learns the format from named, known-person and shaped addresses; ignores role mailboxes and other domains', () => {
    const learned = learnFormat(
      [
        { email: 'lee.park@acme.example', name: 'Lee Park', source: 'gmail' },
        { email: 'sam.ortiz@acme.example', source: 'public' },
        { email: 'jobs@acme.example', source: 'public' },
        { email: 'kim.ng@other.example', name: 'Kim Ng', source: 'gmail' },
        { email: 'x.yz@acme.example', source: 'public' },
      ],
      'acme.example',
      ['Sam Ortiz'],
    );
    expect(learned.pattern).toBe('first.last');
    expect(learned.counts['first.last']).toBe(2);
    expect(learned.counts['f.last']).toBe(0.5);
    expect(learned.examples).toBe(3);
  });

  it('ranks candidates: priors alone are unsure, three consistent examples are confident, no MX scales down', () => {
    const n = nameParts('Maya Rivera');
    if (!n) throw new Error('name');
    const none = learnFormat([], 'acme.example');
    const priors = rankCandidates(n, 'acme.example', none, null);
    expect(priors[0]).toEqual({ email: 'maya.rivera@acme.example', pattern: 'first.last', p: 0.45 });
    expect(priors).toHaveLength(6);
    const three = learnFormat(
      ['Lee Park', 'Sam Ortiz', 'Kai Dunn'].map((name) => ({
        email: `${name.split(' ')[0]?.[0]}${name.split(' ')[1]}@acme.example`.toLowerCase(),
        name,
        source: 'gmail' as const,
      })),
      'acme.example',
    );
    const ranked = rankCandidates(n, 'acme.example', three, true);
    expect(ranked[0]?.email).toBe('mrivera@acme.example');
    expect(ranked[0]?.p).toBeGreaterThanOrEqual(0.9);
    expect(rankCandidates(n, 'acme.example', three, false)[0]?.p).toBeLessThan(0.3);
  });

  it('finds emails and the company domain in text', () => {
    expect(emailsIn('Write to jobs@acme.example or maya.rivera@acme.example.')).toEqual(['jobs@acme.example', 'maya.rivera@acme.example']);
    expect(dossierDomain('# Acme\n\n- **Website:** https://www.acme.example/about\n')).toBe('acme.example');
    expect(dossierDomain('Domain: acme.example')).toBe('acme.example');
    expect(dossierDomain('No site here.')).toBeNull();
  });
});

// ---------------------------------------------------------------- people.find_email

let v: FixtureEngine;
let gmail: DryRunGmail;
let mxCalls: string[];
const ROLE = 'acme_product-lead';

const mx =
  (answer: boolean | null): MxResolver =>
  async (d) => {
    mxCalls.push(d);
    return answer;
  };

function open(services: EngineServices = {}, opts: { domain?: string | null; jd?: string } = {}) {
  v?.cleanup();
  mxCalls = [];
  gmail = createDryRunGmail();
  v = openFixtureEngine({ services: { gmail, mx: mx(true), ...services } });
  const domain = opts.domain === undefined ? 'acme.example' : opts.domain;
  v.db
    .prepare(
      `INSERT INTO company (id, slug, name, domain, ats_type, ats_board, affinity, md_path) VALUES ('acme', 'acme', 'Acme', ?, 'unknown', NULL, 0, NULL)`,
    )
    .run(domain);
  v.db
    .prepare(
      `INSERT INTO role (id, company_id, title, source, found_at, status, md_path, created_at, updated_at) VALUES (?, 'acme', 'Product Lead', 'manual', 'x', 'on-deck', NULL, 'x', 'x')`,
    )
    .run(ROLE);
  person('ct_maya', 'Maya Rivera');
}

function person(id: string, name: string, email: string | null = null, source: string | null = null) {
  v.db
    .prepare(
      `INSERT INTO contact (id, name, headline, linkedin_url, email, source, notes, email_source, email_confidence) VALUES (?, ?, NULL, NULL, ?, 'linkedin', NULL, ?, ?)`,
    )
    .run(id, name, email, source, email ? 1 : null);
  v.db
    .prepare(
      `INSERT INTO contact_link (id, contact_id, company_id, role_id, degree, tier, via_contact_id, is_hiring_team) VALUES (?, ?, 'acme', ?, 'cold', 'cold_other', NULL, 0)`,
    )
    .run(`cl_${id}`, id, ROLE);
}

const agent = (over: Partial<OpContext> = {}) => ctxAt('agent', over);
const find = (input: Record<string, unknown>, c: OpContext = agent()) =>
  v.runOp('people.find_email', { contact_id: 'ct_maya', ...input }, c);
const contact = (id = 'ct_maya') =>
  v.db.prepare('SELECT email, email_source, email_confidence FROM contact WHERE id = ?').get(id) as Record<string, unknown>;
const pendingEmail = () =>
  v.db.prepare(`SELECT * FROM decision WHERE kind = 'people.email' AND status = 'pending'`).all() as Array<Record<string, string>>;

beforeEach(() => open());
afterEach(() => v.cleanup());

describe('people.find_email', () => {
  it('a hint naming the person is their address: stored as known, confirmed, no decision', async () => {
    const out = ok(await find({ role_id: ROLE, hints: [{ email: 'Maya.Rivera@acme.example', name: 'Maya Rivera', source: 'gmail' }] }));
    expect(out).toMatchObject({ email: 'maya.rivera@acme.example', source: 'gmail', confidence: 1, confirmed: true, decision_id: null });
    expect(contact()).toEqual({ email: 'maya.rivera@acme.example', email_source: 'gmail', email_confidence: 1 });
    expect(mxCalls).toEqual([]);
  });

  it('an unnamed address in the JD that spells the full name is theirs (public)', async () => {
    v.db.prepare(`UPDATE role SET md_path = 'roles/acme_product-lead.md' WHERE id = ?`).run(ROLE);
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(`${v.home}/roles`, { recursive: true });
    writeFileSync(
      `${v.home}/roles/acme_product-lead.md`,
      '---\nid: "x"\ntype: "role"\n---\n\nQuestions: m.rivera@acme.example or jobs@acme.example\n',
    );
    const out = ok(await find({ role_id: ROLE }));
    expect(out).toMatchObject({ email: 'm.rivera@acme.example', source: 'public', confidence: 0.9, confirmed: true });
  });

  it('three consistent addresses at the domain + MX: a confident guess is auto-applied and confirmed', async () => {
    const hints = ['Lee Park', 'Sam Ortiz', 'Kai Dunn'].map((name) => ({
      email: `${name[0]}${name.split(' ')[1]}@acme.example`.toLowerCase(),
      name,
      source: 'gmail',
    }));
    const out = ok(await find({ role_id: ROLE, hints }));
    expect(out).toMatchObject({
      email: 'mrivera@acme.example',
      source: 'pattern',
      pattern: 'flast',
      mx: true,
      confirmed: true,
      outcome: 'auto',
    });
    expect(out.confidence).toBeGreaterThanOrEqual(0.9);
    expect(mxCalls).toEqual(['acme.example']);
    expect(contact()).toMatchObject({ email: 'mrivera@acme.example', email_source: 'pattern' });
    const d = v.db.prepare('SELECT * FROM decision WHERE id = ?').get(out.decision_id) as Record<string, unknown>;
    expect(d).toMatchObject({ kind: 'people.email', status: 'applied', impact: 'medium', backend: 'rule', subject_type: 'contact' });
    expect(pendingEmail()).toEqual([]);
  });

  it('known peers at the company teach the format too', async () => {
    person('ct_lee', 'Lee Park', 'lee.park@acme.example', 'gmail');
    person('ct_sam', 'Sam Ortiz', 'sam.ortiz@acme.example', 'public');
    const out = ok(await find({ role_id: ROLE, hints: [{ email: 'kai.dunn@acme.example', source: 'public' }] }));
    expect(out.pattern).toBe('first.last');
    expect(out.candidates[0]).toMatchObject({ email: 'maya.rivera@acme.example', pattern: 'first.last' });
  });

  it('low confidence: stored as an unconfirmed guess, a people.email decision waits in Needs you with the alternatives', async () => {
    const out = ok(await find({ role_id: ROLE }));
    expect(out).toMatchObject({
      email: 'maya.rivera@acme.example',
      source: 'pattern',
      confidence: 0.45,
      confirmed: false,
      outcome: 'human',
    });
    expect(out.reason).toMatch(/unconfirmed guess \(45%\)/);
    const [d] = pendingEmail();
    const q = JSON.parse(d?.question_json as string);
    expect(q).toMatchObject({ type: 'choice', instructions: 'Use maya.rivera@acme.example for Maya Rivera?', domain: 'acme.example' });
    expect(q.options).toEqual(['maya.rivera@acme.example', 'mrivera@acme.example', 'maya@acme.example', 'm.rivera@acme.example', 'other']);
    expect(JSON.parse(d?.action_json as string)).toEqual({
      op: 'people.find_email',
      input: { contact_id: 'ct_maya', role_id: ROLE, value: '$value' },
    });

    // A second run replaces the pending pick.
    ok(await find({ role_id: ROLE }));
    expect(pendingEmail()).toHaveLength(1);
    expect(pendingEmail()[0]?.id).not.toBe(d?.id);

    // The human picks an alternative: confirmed at 1, still a pattern address.
    const pick = pendingEmail()[0]?.id as string;
    const r = ok(
      await v.runOp('decisions.resolve', { decision_id: pick, action: 'change', value: 'mrivera@acme.example' }, ctxAt('human')),
    );
    expect(r.op_status).toBe('ok');
    expect(contact()).toEqual({ email: 'mrivera@acme.example', email_source: 'pattern', email_confidence: 1 });
  });

  it('a typed address is manual; "other" without text and an agent value are refused', async () => {
    ok(await find({ role_id: ROLE }));
    const pick = pendingEmail()[0]?.id as string;
    const bad = ok(await v.runOp('decisions.resolve', { decision_id: pick, action: 'change', value: 'other' }, ctxAt('human')));
    expect(bad.op_status).toBe('error');
    ok(await v.runOp('decisions.resolve', { decision_id: pick, action: 'change', value: 'maya@mail.example' }, ctxAt('human')));
    expect(contact()).toEqual({ email: 'maya@mail.example', email_source: 'manual', email_confidence: 1 });
    expect(await find({ value: 'maya@acme.example' })).toMatchObject({ status: 'error', code: 'invalid_input' });
  });

  it('a known address is kept and never re-guessed', async () => {
    v.db
      .prepare(`UPDATE contact SET email = 'maya@mail.example', email_source = 'manual', email_confidence = 1 WHERE id = 'ct_maya'`)
      .run();
    const out = ok(await find({ role_id: ROLE }));
    expect(out).toMatchObject({ email: 'maya@mail.example', source: 'manual', confirmed: true, decision_id: null });
    expect(mxCalls).toEqual([]);
  });

  it('no MX (or A) record drops every candidate (#99)', async () => {
    open({ mx: mx(false) });
    const out = ok(await find({ role_id: ROLE }));
    expect(out.mx).toBe(false);
    expect(out).toMatchObject({ email: null, candidates: [], decision_id: null });
    expect(out.dropped).toContain('maya.rivera@acme.example');
  });

  it('no company domain: nothing guessed until the agent passes one (or the dossier names it)', async () => {
    open({}, { domain: null });
    const none = ok(await find({ role_id: ROLE }));
    expect(none).toMatchObject({ email: null, domain: null, candidates: [], decision_id: null, reason: 'no company domain: pass domain' });
    const out = ok(await find({ role_id: ROLE, domain: 'acme.example' }));
    expect(out.domain).toBe('acme.example');
    expect(out.email).toBe('maya.rivera@acme.example');
  });

  it('dry run writes nothing', async () => {
    const out = ok(await find({ role_id: ROLE }, agent({ dryRun: true })));
    expect(out.email).toBe('maya.rivera@acme.example');
    expect(contact()).toEqual({ email: null, email_source: null, email_confidence: null });
    expect(pendingEmail()).toEqual([]);
  });

  it('provider seam (pinned): a configured finder can supply the top candidate', async () => {
    const provider: EmailProvider = { name: 'fake', find: async () => ({ email: 'maya@acme.example', confidence: 0.95 }) };
    open({ emailProvider: provider });
    const out = ok(await find({ role_id: ROLE }));
    expect(out).toMatchObject({ email: 'maya@acme.example', source: 'provider', confirmed: true });
  });
});

describe('Gmail draft recipient (#37)', () => {
  const setMaya = (email: string | null, source: string | null, p: number | null) =>
    v.db.prepare(`UPDATE contact SET email = ?, email_source = ?, email_confidence = ? WHERE id = 'ct_0001'`).run(email, source, p);

  it('outreach.get names the To; an unsure guess leaves it empty with a reason', async () => {
    setMaya('maya.r@example.com', 'pattern', 0.5);
    let o = ok(await v.runOp('outreach.get', { outreach_id: 'or_0001' }, ctxAt('human')));
    expect(o.to).toMatchObject({ contact_id: 'ct_0001', email: null, guess: 'maya.r@example.com', email_confidence: 0.5 });
    expect(o.to.reason).toMatch(/unconfirmed/);
    setMaya('maya.r@example.com', 'pattern', 0.92);
    o = ok(await v.runOp('outreach.get', { outreach_id: 'or_0001' }, ctxAt('human')));
    expect(o.to).toMatchObject({ email: 'maya.r@example.com', reason: null });
    setMaya(null, null, null);
    o = ok(await v.runOp('outreach.get', { outreach_id: 'or_0001' }, ctxAt('human')));
    expect(o.to).toMatchObject({ email: null, reason: 'no email found' });
  });

  it('outreach.to_gmail fills To only when confirmed or confident, and flags the rest', async () => {
    setMaya('maya.r@example.com', 'pattern', 0.5);
    const unsure = ok(await v.runOp('outreach.to_gmail', { outreach_id: 'or_0001' }, ctxAt('human')));
    expect(unsure).toMatchObject({ to: null });
    expect(unsure.to_reason).toMatch(/unconfirmed/);
    expect(gmail.drafts[0]?.to).toBeNull();
  });

  it('a confirmed address goes in To', async () => {
    setMaya('maya.r@example.com', 'manual', 1);
    const out = ok(await v.runOp('outreach.to_gmail', { outreach_id: 'or_0001' }, ctxAt('human')));
    expect(out).toMatchObject({ to: 'maya.r@example.com', to_reason: null });
    expect(gmail.drafts[0]?.to).toBe('maya.r@example.com');
  });
});
