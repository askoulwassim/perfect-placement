import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OpOutcome } from '@perfect-placement/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createDryRunGmail, type DryRunGmail } from '../integrations/gmail/index.js';
import type { EngineServices } from '../ops/services.js';
import { GMAIL_DRAFT_TOOL, GMAIL_GET_DRAFT_TOOL, GMAIL_PREFIX, GMAIL_UPDATE_TOOL } from '../runners/claude-tools.js';
import { ctxAt, type FixtureEngine, openFixtureEngine } from '../testing/index.js';
import { createMailResolver } from './dns.js';
import { NO_CANDIDATE } from './email.js';
import { checkCandidates, domainCheck, isValidSyntax, PROVEN_P, riskOf } from './verify.js';

/*
 * #99: the passive email check before Needs you, the user's own manual check, and the Gmail draft waiting
 * for a confirmed address. Synthetic data on a temp fixture vault; fake DNS lookups and a fake domain
 * resolver (never the network, never a mail server); the runner launcher is the fixture fake.
 */

// biome-ignore lint/suspicious/noExplicitAny: test helper returns loosely typed output
const ok = (o: OpOutcome<unknown>): any => {
  if (o.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(o)}`);
  return o.output;
};

const dnsError = (code: string) => Object.assign(new Error(code), { code });

describe('passive checks (no network)', () => {
  it('syntax: an RFC 5322 subset', () => {
    for (const good of ['maya.rivera@acme.example', "o'neil+jobs@acme.co.uk", 'a_b-c@sub.acme-x.io'])
      expect(isValidSyntax(good), good).toBe(true);
    for (const bad of [
      'maya',
      'maya@',
      '@acme.example',
      'maya..r@acme.example',
      '.maya@acme.example',
      'maya.@acme.example',
      'ma ya@acme.example',
      'maya@acme',
      'maya@-acme.example',
      'maya@acme-.example',
      'maya@acme.123',
      'a@b@acme.example',
      `${'x'.repeat(65)}@acme.example`,
    ])
      expect(isValidSyntax(bad), bad).toBe(false);
    expect(domainCheck('maya@acme.example', true)).toBe('ok');
    expect(domainCheck('maya@acme.example', false)).toBe('no_mx');
    expect(domainCheck('maya@acme.example', null)).toBe('unknown');
    expect(domainCheck('maya..r@acme.example', true)).toBe('invalid');
  });

  it('domain: MX, else an A record (injected lookups); none = false, a failed lookup = null', async () => {
    const seen: string[] = [];
    const lookups = (mx: () => Promise<unknown[]>, a: () => Promise<unknown[]>) => ({
      resolveMx: (d: string) => {
        seen.push(`mx ${d}`);
        return mx();
      },
      resolve4: (d: string) => {
        seen.push(`a ${d}`);
        return a();
      },
    });
    const none = () => Promise.reject(dnsError('ENODATA'));
    expect(await createMailResolver(lookups(async () => [{ exchange: 'mx.acme.example' }], none))('acme.example')).toBe(true);
    expect(seen).toEqual(['mx acme.example']);
    expect(await createMailResolver(lookups(none, async () => ['192.0.2.1']))('acme.example')).toBe(true);
    expect(await createMailResolver(lookups(async () => [], none))('acme.example')).toBe(false);
    expect(await createMailResolver(lookups(() => Promise.reject(dnsError('ENOTFOUND')), none))('nope.example')).toBe(false);
    expect(await createMailResolver(lookups(() => Promise.reject(dnsError('ESERVFAIL')), none))('acme.example')).toBeNull();
    expect(
      await createMailResolver(
        lookups(() => new Promise(() => {}), none),
        5,
      )('slow.example'),
    ).toBeNull();
  });

  it('risk lists (vendored AfterShip/email-verifier): disposable, role, free, none', () => {
    expect(riskOf('maya@mailinator.com')).toBe('disposable');
    expect(riskOf('jobs@acme.example')).toBe('role');
    expect(riskOf('Sales+x@acme.example')).toBe('role');
    expect(riskOf('maya.rivera@gmail.com')).toBe('free');
    expect(riskOf('maya.rivera@acme.example')).toBe('none');
  });

  it('checkCandidates: no MX and invalid drop the candidate; proven is raised; the rest is capped for Needs you', () => {
    const ranked = [
      { email: 'maya.rivera@acme.example', pattern: 'first.last', p: 0.8 },
      { email: 'mrivera@acme.example', pattern: 'flast', p: 0.1 },
    ];
    const noMx = checkCandidates(ranked, { mail: false, peers: [], exact: new Set(), unprovenMax: 0.69 });
    expect(noMx).toEqual({ candidates: [], dropped: ['maya.rivera@acme.example', 'mrivera@acme.example'] });
    const peers = [
      { address: 'lee.park@acme.example', fits: ['first.last'] },
      { address: 'sam.ortiz@acme.example', fits: ['first.last'] },
    ];
    const proven = checkCandidates(ranked, { mail: true, peers, exact: new Set(), unprovenMax: 0.69 });
    expect(proven.candidates[0]).toEqual({
      ...ranked[0],
      p: PROVEN_P,
      check: { domain: 'ok', risk: 'none', pattern_peers: 2, public_match: false },
    });
    expect(proven.candidates[1]?.check?.pattern_peers).toBe(0);
    const conflict = checkCandidates(ranked, {
      mail: true,
      peers: [...peers, { address: 'kdunn@acme.example', fits: ['flast'] }],
      exact: new Set(),
      unprovenMax: 0.69,
    });
    expect(conflict.candidates[0]?.p).toBe(0.69);
    const exact = checkCandidates(ranked, { mail: null, peers: [], exact: new Set(['mrivera@acme.example']), unprovenMax: 0.69 });
    expect(exact.candidates[0]).toMatchObject({
      email: 'mrivera@acme.example',
      p: PROVEN_P,
      check: { domain: 'unknown', public_match: true },
    });
  });

  it('no mail server, ever: nothing in people/ opens a socket (net, tls, SMTP)', () => {
    const dir = import.meta.dirname;
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/from ['"](node:)?(net|tls|dgram|smtp)['"]/);
      expect(src, f).not.toMatch(/require\(['"](node:)?(net|tls)['"]\)/);
      expect(src, f).not.toMatch(/createConnection|nodemailer|\bEHLO\b|RCPT TO/);
    }
  });
});

// ---------------------------------------------------------------- through runOp

let v: FixtureEngine | undefined;
let gmail: DryRunGmail;
afterEach(() => {
  v?.cleanup();
  v = undefined;
});

const ROLE = 'linear_product-lead-insights';

function open(services: EngineServices = {}, config?: Record<string, unknown>) {
  gmail = createDryRunGmail();
  v = openFixtureEngine({ services: { gmail, mx: async () => true, ...services }, ...(config ? { config } : {}) });
  return v;
}
const engine = () => v as FixtureEngine;
const human = () => ctxAt('human');
const contact = (id: string) => engine().db.prepare('SELECT email, email_source, email_confidence FROM contact WHERE id = ?').get(id);
const pending = (id: string) =>
  engine()
    .db.prepare(`SELECT id, question_json FROM decision WHERE kind = 'people.email' AND status = 'pending' AND subject_id = ?`)
    .all(id) as Array<{ id: string; question_json: string }>;
const outreachRow = (id: string) =>
  engine().db.prepare('SELECT status, gmail_draft_id, gmail_to FROM outreach WHERE id = ?').get(id) as Record<string, unknown>;
const flag = (args: readonly string[], f: string) => args[args.indexOf(f) + 1];

describe('the Gmail draft waits for a confirmed address (#99)', () => {
  /** An unsure guess for a contact: stored, a people.email decision pending in Needs you. */
  const guess = async (contactId: string) => {
    const out = ok(await engine().runOp('people.find_email', { contact_id: contactId, role_id: ROLE }, ctxAt('agent')));
    expect(out.outcome).toBe('human');
    return pending(contactId)[0]?.id as string;
  };

  it('no Gmail draft while the guess is pending; confirming queues the Gmail step with To', async () => {
    open();
    const decision = await guess('ct_0001');
    // The engine client creates nothing, the Gmail step is refused, outreach.get names the waiting decision.
    expect(await engine().runOp('outreach.to_gmail', { outreach_id: 'or_0001' }, human())).toMatchObject({ code: 'conflict' });
    expect(gmail.drafts).toEqual([]);
    expect(await engine().runOp('runs.start', { skill: 'connect', outreach_id: 'or_0001' }, human())).toMatchObject({ code: 'conflict' });
    expect(engine().launcher.specs).toHaveLength(0);
    const got = ok(await engine().runOp('outreach.get', { outreach_id: 'or_0001' }, human()));
    expect(got.to).toMatchObject({ email: null, guess: 'maya@linear.example', decision_id: decision });

    // The human confirms in Needs you: the Gmail draft step is queued and launched for that draft.
    const r = ok(await engine().runOp('decisions.resolve', { decision_id: decision, action: 'accept' }, human()));
    expect(r.op_status).toBe('ok');
    expect(contact('ct_0001')).toMatchObject({ email: 'maya@linear.example', email_confidence: 1 });
    const runs = engine().db.prepare(`SELECT summary_json FROM run WHERE op = 'connect'`).all() as Array<{ summary_json: string }>;
    expect(runs.map((x) => JSON.parse(x.summary_json))).toEqual([expect.objectContaining({ outreach_id: 'or_0001', step: 'gmail_draft' })]);
    await new Promise((ok) => setTimeout(ok, 0));
    const spec = engine().launcher.specs[0];
    expect(flag(spec?.args ?? [], '--allowedTools')).toBe(`mcp__pp,${GMAIL_DRAFT_TOOL}`);
    expect(ok(await engine().runOp('outreach.get', { outreach_id: 'or_0001' }, human())).to).toMatchObject({
      email: 'maya@linear.example',
      decision_id: null,
    });

    // The engine client now creates the draft with To, and records it.
    const made = ok(await engine().runOp('outreach.to_gmail', { outreach_id: 'or_0001' }, human()));
    expect(made).toMatchObject({ to: 'maya@linear.example' });
    expect(gmail.drafts[0]?.to).toBe('maya@linear.example');
    expect(outreachRow('or_0001')).toMatchObject({ status: 'in_gmail', gmail_to: 'maya@linear.example' });
  });

  it('a Gmail draft that exists without To gets the To update step once the address is confirmed', async () => {
    open();
    // or_0002 (bridge intro to the mutual Dev P.) is already in Gmail with no To recorded.
    expect(outreachRow('or_0002')).toMatchObject({ status: 'in_gmail', gmail_draft_id: 'fixture-draft-0002', gmail_to: null });
    const decision = await guess('ct_0002');
    expect(await engine().runOp('runs.start', { skill: 'connect', outreach_id: 'or_0002' }, human())).toMatchObject({ code: 'conflict' });
    ok(await engine().runOp('decisions.resolve', { decision_id: decision, action: 'accept' }, human()));
    const run = engine().db.prepare(`SELECT summary_json FROM run WHERE op = 'connect'`).get() as { summary_json: string };
    expect(JSON.parse(run.summary_json)).toMatchObject({ outreach_id: 'or_0002', step: 'gmail_to' });
    await new Promise((ok) => setTimeout(ok, 0));
    const args = engine().launcher.specs[0]?.args ?? [];
    // Only read + update_draft next to pp; create_draft, send and every other write denied; no Chrome.
    expect(flag(args, '--allowedTools')).toBe(`mcp__pp,${GMAIL_GET_DRAFT_TOOL},${GMAIL_UPDATE_TOOL}`);
    const denied = flag(args, '--disallowedTools')?.split(',') ?? [];
    for (const t of ['send_message', 'reply', 'forward', 'create_draft', 'delete_draft', 'trash_message', 'label_message'])
      expect(denied).toContain(`${GMAIL_PREFIX}${t}`);
    expect(denied).not.toContain(GMAIL_UPDATE_TOOL);
    expect(args).not.toContain('--chrome');
    expect(args[1]).toContain('outreach_id: or_0002');
    expect(args[1]).toContain(GMAIL_UPDATE_TOOL);

    // The agent sets the To and re-records the same draft: the To is stored.
    const rec = ok(await engine().runOp('outreach.to_gmail', { outreach_id: 'or_0002', gmail_draft_id: 'fixture-draft-0002' }, human()));
    expect(rec).toMatchObject({ to: 'dev@linear.example' });
    expect(outreachRow('or_0002')).toMatchObject({ status: 'in_gmail', gmail_to: 'dev@linear.example' });
    // Nothing more to fill: the step is refused.
    expect(await engine().runOp('runs.start', { skill: 'connect', outreach_id: 'or_0002' }, human())).toMatchObject({ code: 'conflict' });
  });

  it('a draft the agent made while the guess was pending is recorded without To and filled on confirmation', async () => {
    open();
    const decision = await guess('ct_0001');
    const rec = ok(await engine().runOp('outreach.to_gmail', { outreach_id: 'or_0001', gmail_draft_id: 'r-agent-1' }, human()));
    expect(rec).toMatchObject({ to: null });
    expect(outreachRow('or_0001')).toMatchObject({ status: 'in_gmail', gmail_to: null });
    ok(await engine().runOp('decisions.resolve', { decision_id: decision, action: 'accept' }, human()));
    const run = engine().db.prepare(`SELECT summary_json FROM run WHERE op = 'connect'`).get() as { summary_json: string };
    expect(JSON.parse(run.summary_json)).toMatchObject({ outreach_id: 'or_0001', step: 'gmail_to' });
  });
});

describe('people.find_email: pattern evidence and the passive check (#99)', () => {
  const fullName = () => engine().db.prepare(`UPDATE contact SET name = 'Maya Rivera' WHERE id = 'ct_0001'`).run();
  const peer = (address: string, name: string) => ({ kind: 'inbox_peer', address, source: 'gmail', name });
  const find = (input: Record<string, unknown> = {}) =>
    engine().runOp('people.find_email', { contact_id: 'ct_0001', role_id: ROLE, ...input }, ctxAt('agent'));
  const connectRuns = () =>
    (engine().db.prepare(`SELECT summary_json FROM run WHERE op = 'connect'`).all() as Array<{ summary_json: string }>).map((r) =>
      JSON.parse(r.summary_json),
    );

  it('two inbox peers on first.last: auto-applied, To filled, the waiting Gmail draft queued; only address + format kept', async () => {
    open();
    fullName();
    const out = ok(await find({ evidence: [peer('lee.park@linear.example', 'Lee Park'), peer('Sam.Ortiz@linear.example', 'Sam Ortiz')] }));
    expect(out).toMatchObject({ email: 'maya.rivera@linear.example', confirmed: true, outcome: 'auto', confidence: PROVEN_P });
    expect(out.candidates[0].check).toEqual({ domain: 'ok', risk: 'none', pattern_peers: 2, public_match: false });
    expect(pending('ct_0001')).toEqual([]);
    const got = ok(await engine().runOp('outreach.get', { outreach_id: 'or_0001' }, human()));
    expect(got.to).toMatchObject({ email: 'maya.rivera@linear.example', decision_id: null });
    expect(connectRuns()).toEqual([expect.objectContaining({ outreach_id: 'or_0001', step: 'gmail_draft' })]);
    const d = engine().db.prepare('SELECT question_json FROM decision WHERE id = ?').get(out.decision_id) as { question_json: string };
    expect(JSON.parse(d.question_json).evidence).toEqual([
      { kind: 'inbox_peer', address: 'lee.park@linear.example', pattern: 'first.last' },
      { kind: 'inbox_peer', address: 'sam.ortiz@linear.example', pattern: 'first.last' },
    ]);
    // The display names inferred the format; they are not kept.
    expect(d.question_json).not.toContain('Lee Park');
  });

  it('conflicting peers: the guess goes to Needs you, no Gmail draft', async () => {
    open();
    fullName();
    const out = ok(
      await find({
        evidence: [
          peer('lee.park@linear.example', 'Lee Park'),
          peer('sam.ortiz@linear.example', 'Sam Ortiz'),
          peer('kdunn@linear.example', 'Kai Dunn'),
        ],
      }),
    );
    expect(out).toMatchObject({ email: 'maya.rivera@linear.example', confirmed: false, outcome: 'human' });
    expect(out.confidence).toBeLessThan(0.7);
    expect(out.candidates[0].check.pattern_peers).toBe(2);
    expect(out.candidates.find((c: { email: string }) => c.email === 'mrivera@linear.example').check.pattern_peers).toBe(1);
    expect(pending('ct_0001')).toHaveLength(1);
    expect(connectRuns()).toEqual([]);
  });

  it('an exact public mention of a candidate: auto-applied', async () => {
    open();
    fullName();
    const mention = { kind: 'public_mention', address: 'mrivera@linear.example', source: 'team page', url: 'https://linear.example/team' };
    const out = ok(await find({ evidence: [mention] }));
    expect(out).toMatchObject({ email: 'mrivera@linear.example', confirmed: true, outcome: 'auto' });
    expect(out.candidates[0].check).toMatchObject({ public_match: true, domain: 'ok' });
    const d = engine().db.prepare('SELECT question_json FROM decision WHERE id = ?').get(out.decision_id) as { question_json: string };
    expect(JSON.parse(d.question_json).evidence).toEqual([
      { kind: 'public_mention', address: 'mrivera@linear.example', pattern: 'flast', url: 'https://linear.example/team' },
    ]);
  });

  it('no evidence: unproven, Needs you; a domain with no MX or A record drops every candidate', async () => {
    open();
    expect(ok(await find())).toMatchObject({ confirmed: false, outcome: 'human' });
    v?.cleanup();
    open({ mx: async () => false });
    const out = ok(await find());
    expect(out).toMatchObject({ email: null, candidates: [], decision_id: null, reason: NO_CANDIDATE });
    expect(out.dropped).toEqual(['maya@linear.example', 'mayar@linear.example']);
    expect(pending('ct_0001')).toEqual([]);
  });
});

describe('people.email_checked: the user checks by hand (#99)', () => {
  const check = (address: string, result: 'valid' | 'invalid', ctx = human()) =>
    engine().runOp('people.email_checked', { contact_id: 'ct_0001', address, result }, ctx);
  const decisionRow = (id: string) =>
    engine().db.prepare('SELECT status, human_choice, question_json, answer_json FROM decision WHERE id = ?').get(id) as Record<
      string,
      string
    >;

  it('human only', async () => {
    open();
    ok(await engine().runOp('people.find_email', { contact_id: 'ct_0001', role_id: ROLE }, ctxAt('agent')));
    expect(await check('maya@linear.example', 'valid', ctxAt('agent'))).toMatchObject({ status: 'error', code: 'human_only' });
  });

  it('Invalid drops the candidate and keeps the decision open; Valid confirms, fills To and queues the Gmail draft', async () => {
    open();
    ok(await engine().runOp('people.find_email', { contact_id: 'ct_0001', role_id: ROLE }, ctxAt('agent')));
    const id = pending('ct_0001')[0]?.id as string;
    expect(JSON.parse(decisionRow(id).question_json as string).options).toEqual(['maya@linear.example', 'mayar@linear.example', 'other']);

    const bad = ok(await check('maya@linear.example', 'invalid'));
    expect(bad).toMatchObject({
      source: 'manual_check',
      decision_id: id,
      open: true,
      remaining: ['mayar@linear.example'],
      confirmed: false,
    });
    expect(contact('ct_0001')).toMatchObject({ email: 'mayar@linear.example' });
    const q = JSON.parse(decisionRow(id).question_json as string);
    expect(q.options).toEqual(['mayar@linear.example', 'other']);
    expect(q.dropped).toEqual(['maya@linear.example']);
    expect(q.manual_checks).toEqual([
      expect.objectContaining({ address: 'maya@linear.example', result: 'invalid', source: 'manual_check' }),
    ]);
    expect(JSON.parse(decisionRow(id).answer_json as string).value).toBe('mayar@linear.example');
    expect(pending('ct_0001')).toHaveLength(1);

    const good = ok(await check('mayar@linear.example', 'valid'));
    expect(good).toMatchObject({ source: 'manual_check', decision_id: id, open: false, confirmed: true });
    expect(decisionRow(id)).toMatchObject({ status: 'applied', human_choice: 'mayar@linear.example' });
    expect(contact('ct_0001')).toMatchObject({ email: 'mayar@linear.example', email_confidence: 1 });
    const runs = engine().db.prepare(`SELECT summary_json FROM run WHERE op = 'connect'`).all() as Array<{ summary_json: string }>;
    expect(runs.map((x) => JSON.parse(x.summary_json))).toEqual([expect.objectContaining({ outreach_id: 'or_0001', step: 'gmail_draft' })]);
    expect(ok(await engine().runOp('outreach.get', { outreach_id: 'or_0001' }, human())).to).toMatchObject({
      email: 'mayar@linear.example',
    });
  });

  it('Invalid on the last candidate closes the decision and clears the guess', async () => {
    open();
    ok(await engine().runOp('people.find_email', { contact_id: 'ct_0001', role_id: ROLE }, ctxAt('agent')));
    const id = pending('ct_0001')[0]?.id as string;
    ok(await check('maya@linear.example', 'invalid'));
    const last = ok(await check('mayar@linear.example', 'invalid'));
    expect(last).toMatchObject({ open: false, remaining: [], confirmed: false });
    expect(decisionRow(id).status).toBe('rejected');
    expect(contact('ct_0001')).toMatchObject({ email: null });
    expect(engine().launcher.specs).toHaveLength(0);
  });
});
