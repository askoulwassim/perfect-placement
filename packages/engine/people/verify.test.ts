import type { OpOutcome } from '@perfect-placement/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../integrations/ats/http.js';
import { createDryRunGmail, type DryRunGmail } from '../integrations/gmail/index.js';
import { GMAIL_DRAFT_TOOL, GMAIL_GET_DRAFT_TOOL, GMAIL_PREFIX, GMAIL_UPDATE_TOOL } from '../ops/runner.js';
import type { EngineServices } from '../ops/services.js';
import { ctxAt, type FixtureEngine, openFixtureEngine } from '../testing/index.js';
import { createEmailVerifier, DELIVERABLE_P, type EmailVerifier, hunter, neverBounce, verifyCandidates, zeroBounce } from './verify.js';

/*
 * #99: email verification before Needs you, and the Gmail draft waiting for a confirmed address.
 * Synthetic data on a temp fixture vault; a fake MX resolver, fake providers and a fake fetch (never the
 * network, never DNS, never a mail server); the runner launcher is the fixture fake (nothing spawns).
 */

// biome-ignore lint/suspicious/noExplicitAny: test helper returns loosely typed output
const ok = (o: OpOutcome<unknown>): any => {
  if (o.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(o)}`);
  return o.output;
};

/** A fetch that answers one JSON body per URL prefix and records the URLs it saw. */
function fakeFetch(routes: Record<string, unknown>, status = 200): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    const hit = Object.entries(routes).find(([p]) => url.startsWith(p));
    if (!hit) throw new Error(`unexpected url ${url}`);
    return { status, url, redirected: false, headers: { get: () => null }, text: async () => JSON.stringify(hit[1]) };
  }) as FetchLike & { urls: string[] };
  f.urls = urls;
  return f;
}

/** A provider double: a status per address (default `unknown`). */
const fakeVerifier = (answers: Record<string, string>, calls: string[] = []): EmailVerifier => ({
  name: 'fake',
  async verify(email) {
    calls.push(email);
    return (answers[email] ?? 'unknown') as never;
  },
});

describe('provider adapters (injected fetch, no network)', () => {
  it('NeverBounce, ZeroBounce and Hunter map their answers to the five statuses', async () => {
    const nb = fakeFetch({ 'https://api.neverbounce.com/v4/single/check': { status: 'success', result: 'catchall' } });
    expect(await neverBounce('k1', nb).verify('a@acme.example')).toBe('catch_all');
    expect(nb.urls[0]).toContain('email=a%40acme.example');
    expect(await zeroBounce('k2', fakeFetch({ 'https://api.zerobounce.net/v2/validate': { status: 'valid' } })).verify('a@x.example')).toBe(
      'deliverable',
    );
    expect(
      await zeroBounce('k2', fakeFetch({ 'https://api.zerobounce.net/v2/validate': { status: 'spamtrap' } })).verify('a@x.example'),
    ).toBe('risky');
    const hu = fakeFetch({ 'https://api.hunter.io/v2/email-verifier': { data: { status: 'invalid', result: 'undeliverable' } } });
    expect(await hunter('k3', hu).verify('a@x.example')).toBe('undeliverable');
    expect(
      await hunter('k3', fakeFetch({ 'https://api.hunter.io/v2/email-verifier': { data: { status: 'accept_all' } } })).verify(
        'a@x.example',
      ),
    ).toBe('catch_all');
  });

  it('an HTTP error throws without the key in the message', async () => {
    const f = fakeFetch({ 'https://api.hunter.io': {} }, 401);
    await expect(hunter('secret-key', f).verify('a@x.example')).rejects.toThrow(/HTTP 401/);
    await expect(hunter('secret-key', f).verify('a@x.example')).rejects.not.toThrow(/secret-key/);
  });

  it('built from config: the key comes from the named environment variable; none or no key = MX only', () => {
    const f = fakeFetch({});
    expect(createEmailVerifier(undefined, {}, f)).toBeNull();
    expect(createEmailVerifier({ provider: 'none' }, { X: 'k' }, f)).toBeNull();
    expect(createEmailVerifier({ provider: 'hunter' }, {}, f)).toBeNull();
    expect(createEmailVerifier({ provider: 'hunter' }, { HUNTER_API_KEY: 'k' }, f)?.name).toBe('hunter');
    expect(createEmailVerifier({ provider: 'zerobounce', keyEnv: 'MY_ZB' }, { MY_ZB: 'k' }, f)?.name).toBe('zerobounce');
    expect(createEmailVerifier({ provider: 'zerobounce', keyEnv: 'MY_ZB' }, { ZEROBOUNCE_API_KEY: 'k' }, f)).toBeNull();
  });
});

describe('verifyCandidates', () => {
  const ranked = [
    { email: 'a@acme.example', pattern: 'first.last', p: 0.45 },
    { email: 'b@acme.example', pattern: 'flast', p: 0.2 },
    { email: 'c@acme.example', pattern: 'first', p: 0.15 },
  ];

  it('MX only: every candidate is unknown with the MX result, p unchanged', async () => {
    const r = await verifyCandidates(ranked, true, null);
    expect(r.dropped).toEqual([]);
    expect(r.candidates.map((c) => [c.p, c.verify])).toEqual(ranked.map((c) => [c.p, { status: 'unknown', mx: true, provider: null }]));
  });

  it('undeliverable is dropped, deliverable is raised to the top and stops further checks', async () => {
    const calls: string[] = [];
    const v = fakeVerifier({ 'a@acme.example': 'undeliverable', 'b@acme.example': 'deliverable' }, calls);
    const r = await verifyCandidates(ranked, true, v);
    expect(r.dropped).toEqual(['a@acme.example']);
    expect(r.candidates[0]).toMatchObject({
      email: 'b@acme.example',
      p: DELIVERABLE_P,
      verify: { status: 'deliverable', provider: 'fake' },
    });
    expect(calls).toEqual(['a@acme.example', 'b@acme.example']);
    expect(r.candidates[1]?.verify).toEqual({ status: 'unknown', mx: true, provider: null });
  });

  it('no MX record: the provider is not asked; a provider failure is unknown', async () => {
    const calls: string[] = [];
    await verifyCandidates(ranked, false, fakeVerifier({}, calls));
    expect(calls).toEqual([]);
    const failing: EmailVerifier = { name: 'down', verify: async () => Promise.reject(new Error('down')) };
    const r = await verifyCandidates(ranked.slice(0, 1), true, failing);
    expect(r.candidates[0]?.verify).toEqual({ status: 'unknown', mx: true, provider: 'down' });
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

describe('people.find_email with a verifier (#99)', () => {
  it('a deliverable address skips Needs you: auto-applied and confirmed', async () => {
    open({ emailVerifier: fakeVerifier({ 'maya@linear.app': 'deliverable' }) });
    const out = ok(await engine().runOp('people.find_email', { contact_id: 'ct_0001', role_id: ROLE }, ctxAt('agent')));
    expect(out).toMatchObject({ email: 'maya@linear.app', confirmed: true, outcome: 'auto' });
    expect(out.confidence).toBe(DELIVERABLE_P);
    expect(out.candidates[0].verify).toEqual({ status: 'deliverable', mx: true, provider: 'fake' });
    expect(pending('ct_0001')).toEqual([]);
  });

  it('configured provider + key in the environment, through the injected fetch', async () => {
    const f = fakeFetch({ 'https://api.hunter.io/v2/email-verifier': { data: { status: 'valid' } } });
    open({ fetch: f, env: { MY_HUNTER: 'k' } }, { email_verifier: { provider: 'hunter', keyEnv: 'MY_HUNTER' } });
    const out = ok(await engine().runOp('people.find_email', { contact_id: 'ct_0001', role_id: ROLE }, ctxAt('agent')));
    expect(out).toMatchObject({ confirmed: true, outcome: 'auto' });
    expect(f.urls).toHaveLength(1);
    // The key is never stored.
    expect(JSON.stringify(engine().db.prepare('SELECT * FROM decision').all())).not.toContain('MY_HUNTER');
  });

  it('undeliverable drops the candidate; catch-all goes to Needs you with the result per candidate', async () => {
    open({ emailVerifier: fakeVerifier({ 'maya@linear.app': 'undeliverable', 'mayar@linear.app': 'catch_all' }) });
    const out = ok(await engine().runOp('people.find_email', { contact_id: 'ct_0001', role_id: ROLE }, ctxAt('agent')));
    expect(out.dropped).toEqual(['maya@linear.app']);
    expect(out.candidates.map((c: { email: string }) => c.email)).not.toContain('maya@linear.app');
    expect(out).toMatchObject({ email: 'mayar@linear.app', confirmed: false, outcome: 'human' });
    const q = JSON.parse(pending('ct_0001')[0]?.question_json as string);
    expect(q.options).toEqual(['mayar@linear.app', 'other']);
    expect(q.candidates[0].verify).toEqual({ status: 'catch_all', mx: true, provider: 'fake' });
    expect(q.dropped).toEqual(['maya@linear.app']);
  });

  it('every candidate undeliverable: no guess, nothing asked', async () => {
    open({ emailVerifier: fakeVerifier({ 'maya@linear.app': 'undeliverable', 'mayar@linear.app': 'undeliverable' }) });
    const out = ok(await engine().runOp('people.find_email', { contact_id: 'ct_0001', role_id: ROLE }, ctxAt('agent')));
    expect(out).toMatchObject({ email: null, candidates: [], decision_id: null, reason: 'every candidate is undeliverable' });
    expect(pending('ct_0001')).toEqual([]);
  });
});

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
    expect(got.to).toMatchObject({ email: null, guess: 'maya@linear.app', decision_id: decision });

    // The human confirms in Needs you: the Gmail draft step is queued and launched for that draft.
    const r = ok(await engine().runOp('decisions.resolve', { decision_id: decision, action: 'accept' }, human()));
    expect(r.op_status).toBe('ok');
    expect(contact('ct_0001')).toMatchObject({ email: 'maya@linear.app', email_confidence: 1 });
    const runs = engine().db.prepare(`SELECT summary_json FROM run WHERE op = 'connect'`).all() as Array<{ summary_json: string }>;
    expect(runs.map((x) => JSON.parse(x.summary_json))).toEqual([expect.objectContaining({ outreach_id: 'or_0001', step: 'gmail_draft' })]);
    await new Promise((ok) => setTimeout(ok, 0));
    const spec = engine().launcher.specs[0];
    expect(flag(spec?.args ?? [], '--allowedTools')).toBe(`mcp__pp,${GMAIL_DRAFT_TOOL}`);
    expect(ok(await engine().runOp('outreach.get', { outreach_id: 'or_0001' }, human())).to).toMatchObject({
      email: 'maya@linear.app',
      decision_id: null,
    });

    // The engine client now creates the draft with To, and records it.
    const made = ok(await engine().runOp('outreach.to_gmail', { outreach_id: 'or_0001' }, human()));
    expect(made).toMatchObject({ to: 'maya@linear.app' });
    expect(gmail.drafts[0]?.to).toBe('maya@linear.app');
    expect(outreachRow('or_0001')).toMatchObject({ status: 'in_gmail', gmail_to: 'maya@linear.app' });
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
    expect(rec).toMatchObject({ to: 'dev@linear.app' });
    expect(outreachRow('or_0002')).toMatchObject({ status: 'in_gmail', gmail_to: 'dev@linear.app' });
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

  it('a verified deliverable address queues the waiting draft without Needs you', async () => {
    open({ emailVerifier: fakeVerifier({ 'maya@linear.app': 'deliverable' }) });
    ok(await engine().runOp('people.find_email', { contact_id: 'ct_0001', role_id: ROLE }, ctxAt('agent')));
    const run = engine().db.prepare(`SELECT summary_json FROM run WHERE op = 'connect'`).get() as { summary_json: string };
    expect(JSON.parse(run.summary_json)).toMatchObject({ outreach_id: 'or_0001', step: 'gmail_draft', actor: 'schedule' });
    // Asking again (already confirmed) queues nothing new.
    ok(await engine().runOp('people.find_email', { contact_id: 'ct_0001', role_id: ROLE }, ctxAt('agent')));
    expect(engine().db.prepare(`SELECT count(*) n FROM run WHERE op = 'connect'`).get()).toEqual({ n: 1 });
  });
});
