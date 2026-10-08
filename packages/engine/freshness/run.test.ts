import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG, FRESHNESS_SCOPE, type OpContext } from '@perfect-placement/contracts';
import { FIXTURE_NOW, roles as fixtureRoles } from '@perfect-placement/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeFetch, page, recorded } from '../integrations/ats/__fixtures__/fake-fetch.js';
import { ctxAt, type FixtureEngine, okOut, openFixtureEngine } from '../testing/index.js';
import { backfillDryRun, checkFreshness, memoryStore, rolesFromDb, rolesFromV1Pipeline } from './index.js';

/*
 * roles.check_freshness through runOp on a temp fixture vault: lane A repos, runOp's emitter, the
 * real resolver + policy with a scripted fake Kev, recorded HTTP. Nothing touches the network.
 */

const id = (co: string, title: string) => {
  const r = fixtureRoles.find((x) => x.company_id === co && x.title === title);
  if (!r) throw new Error(`no fixture role ${co} ${title}`);
  return r;
};
const R = {
  ddCost: id('datadog', 'Group PM, Cloud Cost'), // gh 404 job -> resolver closed auto_undo -> archived
  airtableOnDeck: id('airtable', 'Principal PM, AI Platform'), // gh board 404 -> page redirect -> resolver human -> unsure
  vercelDraft: id('vercel', 'Principal PM, Data'), // gh 404 job, resolver says open -> conflict -> unsure
  linearAi: id('linear', 'Product Lead, AI'), // page inconclusive -> resolver open auto -> open
  rampActive: id('ramp', 'Senior PM, Data Intelligence'), // page closed phrase -> resolver closed -> archived
  retoolActive: id('retool', 'Principal PM, Workflows'), // stale (50d), resolver throws -> unsure + error
  plaidOnDeck: id('plaid', 'Principal PM, Identity'), // page 404 -> resolver closed auto -> archived
  linearDraft: id('linear', 'Product Lead, Insights'), // resolver human -> unsure
  stripeApplied: id('stripe', 'Principal PM, Revenue Data'),
  figmaIv: id('figma', 'Staff PM, Data Platform'),
  retoolOffer: id('retool', 'Head of Data Product'),
};

function route(url: string) {
  // Greenhouse API
  const gh = /^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([^/]+)\/jobs\/(\d+)$/.exec(url);
  if (gh) {
    const jobId = gh[2];
    if (jobId === R.ddCost.ats_job_id || jobId === R.vercelDraft.ats_job_id)
      return { status: 404, body: recorded('greenhouse_job_404.json') };
    if (jobId === R.airtableOnDeck.ats_job_id) return { status: 404, body: recorded('greenhouse_board_404.json') };
    const body = JSON.parse(recorded('greenhouse_job_200.json')) as Record<string, unknown>;
    return { status: 200, body: JSON.stringify({ ...body, id: Number(jobId) }) };
  }
  if (url === R.airtableOnDeck.url)
    return { status: 200, body: page('<h1>Jobs</h1>'), finalUrl: 'https://boards.greenhouse.io/airtable?error=true' };
  if (url === R.rampActive.url) return { status: 200, body: page('<p>This job is no longer available.</p>') };
  if (url === R.plaidOnDeck.url) return { status: 404 };
  if (url.startsWith('https://'))
    return { status: 200, body: page('<h1>Role</h1><p>About the team.</p><button>Apply for this job</button>') };
  return undefined;
}

/** Scripted Kev answers per role (the real policy decides the outcome). */
const SCRIPT: Record<string, { value: boolean; p: number } | 'down'> = {
  [R.ddCost.id]: { value: false, p: 0.97 }, // confident (>= 0.92) -> auto -> archived
  [R.airtableOnDeck.id]: { value: false, p: 0.8 }, // middle, no second opinion (schedule) -> human
  [R.vercelDraft.id]: { value: true, p: 0.95 },
  [R.linearAi.id]: { value: true, p: 0.95 },
  [R.rampActive.id]: { value: false, p: 0.96 },
  [R.retoolActive.id]: 'down', // Kev down, no agent attached -> human
  [R.plaidOnDeck.id]: { value: false, p: 0.99 },
  [R.linearDraft.id]: { value: true, p: 0.6 }, // low band -> human
};

let e: FixtureEngine;
let f: ReturnType<typeof fakeFetch>;
const ctx: OpContext = { actor: 'schedule', now: () => new Date(FIXTURE_NOW) };

function engine(config?: Record<string, unknown>) {
  f = fakeFetch(route);
  return openFixtureEngine({
    services: { fetch: f },
    ...(config ? { config } : {}),
    kev: (_q, req) => {
      const s = SCRIPT[req.subject?.id ?? ''] ?? { value: true, p: 0.95 };
      return s === 'down' ? undefined : s;
    },
  });
}

const role = (rid: string) =>
  e.db.prepare('SELECT * FROM role WHERE id = ?').get(rid) as {
    status: string;
    freshness: string;
    archive_reason: string | null;
    last_checked_at: string | null;
    flags_json: string;
  };
const decisionFor = (rid: string) =>
  e.db.prepare('SELECT * FROM decision WHERE subject_id = ? AND ts = ?').get(rid, FIXTURE_NOW) as Record<string, string> | undefined;
const protectedSnapshot = () =>
  e.db.prepare(`SELECT * FROM role WHERE status NOT IN (${FRESHNESS_SCOPE.map((s) => `'${s}'`).join(',')}) ORDER BY id`).all();
const eventsFor = (rid: string) =>
  e.db
    .prepare(`SELECT type, decision_id, payload_json, actor FROM event WHERE subject_id = ? AND ts = ? ORDER BY rowid`)
    .all(rid, FIXTURE_NOW) as Array<{ type: string; decision_id: string | null; payload_json: string; actor: string }>;
const kevAsked = (rid: string) => e.kev.calls.some((c) => c.subject?.id === rid);

beforeEach(() => {
  e = engine();
});
afterEach(() => e.cleanup());

describe('roles.check_freshness over fixtures (runOp)', () => {
  it('daily run: scope only, ladder outcomes, events, run log', async () => {
    const before = protectedSnapshot();
    const out = okOut(await e.runOp('roles.check_freshness', { all_in_scope: true }, ctx));
    expect(out.results).toHaveLength(16);

    // Applied-or-later and archived/inbox roles: untouched and never fetched.
    const after = protectedSnapshot() as Array<{ id: string }>;
    expect(after).toHaveLength(before.length + 3);
    expect(after.filter((r) => ![R.ddCost.id, R.rampActive.id, R.plaidOnDeck.id].includes(r.id))).toEqual(before);
    for (const r of [R.stripeApplied, R.figmaIv, R.retoolOffer]) {
      expect(role(r.id)).toMatchObject({ status: r.status, freshness: r.freshness, last_checked_at: r.last_checked_at });
      expect(f.calls.some((u) => u === r.url || (r.ats_job_id !== null && u.includes(r.ats_job_id)))).toBe(false);
      expect(kevAsked(r.id)).toBe(false);
    }
    const byId = new Map((out.results as Array<{ role_id: string }>).map((r) => [r.role_id, r]));

    // ATS live -> open, no resolver call.
    const figma = id('figma', 'Principal PM, Developer Platform');
    expect(byId.get(figma.id)).toEqual({ role_id: figma.id, freshness: 'open', method: 'ats_api', stale: false, decision_id: null });
    expect(role(figma.id)).toMatchObject({ freshness: 'open', last_checked_at: FIXTURE_NOW, status: 'active' });
    expect(kevAsked(figma.id)).toBe(false);

    // ATS 404 + Kev "not open" p 0.97 -> plain auto (#24 grid, #18) -> archived closed.
    const dd = decisionFor(R.ddCost.id);
    expect(dd).toMatchObject({ kind: 'freshness.closed', backend: 'kev', policy_outcome: 'auto', status: 'applied', undo_until: null });
    expect(byId.get(R.ddCost.id)).toMatchObject({ freshness: 'closed', method: 'ats_api', decision_id: dd?.id });
    expect(role(R.ddCost.id)).toMatchObject({ status: 'archived', archive_reason: 'closed', freshness: 'closed' });
    expect(JSON.parse(role(R.ddCost.id).flags_json).closed.reason).toBe('greenhouse api: job not found');
    expect(eventsFor(R.ddCost.id).map((x) => x.type)).toEqual(['freshness_checked', 'role_closed', 'role_archived']);
    expect(eventsFor(R.ddCost.id).every((x) => x.decision_id === dd?.id && x.actor === 'schedule')).toBe(true);
    expect(JSON.parse(eventsFor(R.ddCost.id)[2]?.payload_json ?? '{}')).toMatchObject({ reason: 'closed', from: 'active' });

    // Board missing -> page redirect -> middle band, no second opinion -> Needs you; the decision carries the archive action.
    expect(byId.get(R.airtableOnDeck.id)).toMatchObject({ freshness: 'unsure', method: 'page' });
    expect(role(R.airtableOnDeck.id)).toMatchObject({ status: 'on-deck', freshness: 'unsure', last_checked_at: FIXTURE_NOW });
    expect(JSON.parse(decisionFor(R.airtableOnDeck.id)?.action_json ?? '{}')).toEqual({
      op: 'roles.archive',
      input: { role_id: R.airtableOnDeck.id, reason: 'closed' },
      when: false,
      undo: { op: 'roles.move', input: { role_id: R.airtableOnDeck.id, to: 'on-deck' } },
    });
    expect(decisionFor(R.airtableOnDeck.id)).toMatchObject({ policy_outcome: 'human', status: 'pending' });

    // Hard 404 but Kev says open -> conflict -> unsure, draft-ready kept.
    expect(byId.get(R.vercelDraft.id)).toMatchObject({ freshness: 'unsure', method: 'ats_api' });
    expect(role(R.vercelDraft.id).status).toBe('draft-ready');

    // Page inconclusive -> Kev yes -> open via resolver; page text is in the state.
    expect(byId.get(R.linearAi.id)).toMatchObject({ freshness: 'open', method: 'resolver' });
    const linearReq = e.kev.calls.find((c) => c.subject?.id === R.linearAi.id);
    expect(linearReq).toMatchObject({ decision: 'freshness.closed', impact: 'medium', questions: [{ id: 'open', type: 'noulli' }] });
    expect((linearReq?.state as Record<string, string> | undefined)?.page_text).toContain('Apply for this job');

    // Closed phrase / page 404 -> Kev no -> archived via page.
    expect(byId.get(R.rampActive.id)).toMatchObject({ freshness: 'closed', method: 'page' });
    expect(byId.get(R.plaidOnDeck.id)).toMatchObject({ freshness: 'closed', method: 'page' });
    expect(role(R.plaidOnDeck.id)).toMatchObject({ status: 'archived', archive_reason: 'closed' });

    // Kev down, no agent attached (schedule) -> human queue; stale flag (found 50 days ago).
    expect(byId.get(R.retoolActive.id)).toMatchObject({ freshness: 'unsure', stale: true });
    expect(decisionFor(R.retoolActive.id)).toMatchObject({ backend: 'human', policy_outcome: 'human', status: 'pending' });
    expect(JSON.parse(role(R.retoolActive.id).flags_json)).toMatchObject({ stale: true });
    expect(role(R.retoolActive.id).status).toBe('active');

    // Low confidence on a draft-ready role -> Needs you, never archived.
    expect(role(R.linearDraft.id)).toMatchObject({ status: 'draft-ready', freshness: 'unsure' });

    // Run row + log (the fixture vault already has today's freshness log, so this one is -2).
    const runRow = e.db.prepare(`SELECT * FROM run WHERE op = 'freshness' AND started_at = ?`).get(FIXTURE_NOW) as Record<string, string>;
    expect(runRow).toMatchObject({ status: 'ok', log_path: 'runs/2026-10-08_freshness-2.md' });
    expect(JSON.parse(runRow.summary_json as string)).toMatchObject({ checked: 16, closed: 3, unsure: 4, open: 9, stale: 1, errors: 0 });
    expect(readFileSync(join(e.home, 'runs/2026-10-08_freshness-2.md'), 'utf8')).toMatch(/^---\nid: rn_[0-9A-Z]{26}\ntype: run\n---/);
  });

  it('role_ids outside scope are skipped and never touched', async () => {
    const out = okOut(
      await e.runOp(
        'roles.check_freshness',
        { role_ids: [R.stripeApplied.id, R.figmaIv.id, R.retoolOffer.id, R.linearAi.id, 'nope_x'] },
        ctx,
      ),
    );
    expect(out.results.map((r: { role_id: string }) => r.role_id)).toEqual([R.linearAi.id]);
    expect(out.skipped).toEqual([R.stripeApplied.id, R.figmaIv.id, R.retoolOffer.id, 'nope_x']);
    expect(f.calls).toEqual([R.linearAi.url]);
    expect(e.kev.calls).toHaveLength(1);
  });

  it('a draft-ready close follows the grid (#18) and a close is undoable when config says auto + undo', async () => {
    e.cleanup();
    // freshness.closed confident -> auto + undo (a Settings override on top of the plain grid).
    e = engine({ overrides: { 'freshness.closed': { confident_outcome: 'auto_undo' } } });
    SCRIPT[R.vercelDraft.id] = { value: false, p: 0.97 };
    try {
      okOut(await e.runOp('roles.check_freshness', { role_ids: [R.vercelDraft.id] }, ctx));
    } finally {
      SCRIPT[R.vercelDraft.id] = { value: true, p: 0.95 };
    }
    expect(role(R.vercelDraft.id)).toMatchObject({ status: 'archived', archive_reason: 'closed', freshness: 'closed' });
    const d = decisionFor(R.vercelDraft.id) as Record<string, string>;
    expect(d).toMatchObject({ policy_outcome: 'auto_undo', status: 'applied', undo_until: '2026-10-09T12:00:00.000Z' });

    // One tap undo (decisions.undo -> DecisionAction.undo -> roles.move, exact prior status).
    const undone = okOut(await e.runOp('decisions.undo', { decision_id: d.id }, ctxAt('human', {}, '2026-10-08T15:00:00.000Z')));
    expect(undone.decision.status).toBe('undone');
    expect(role(R.vercelDraft.id)).toMatchObject({ status: 'draft-ready', archive_reason: null, freshness: 'unknown' });
    expect(JSON.parse(role(R.vercelDraft.id).flags_json).closed).toBeUndefined();
    // Past the window: refused.
    const again = await e.runOp('decisions.undo', { decision_id: d.id }, ctxAt('human', {}, '2026-10-10T15:00:00.000Z'));
    expect(again).toMatchObject({ status: 'error', code: 'conflict' });
  });

  it('a Needs-you close accepted by the human archives; "still open" does not', async () => {
    okOut(await e.runOp('roles.check_freshness', { role_ids: [R.airtableOnDeck.id, R.linearDraft.id] }, ctx));
    const a = decisionFor(R.airtableOnDeck.id) as Record<string, string>;
    okOut(await e.runOp('decisions.resolve', { decision_id: a.id, action: 'accept' }, ctxAt('human')));
    expect(role(R.airtableOnDeck.id)).toMatchObject({ status: 'archived', archive_reason: 'closed' });
    const l = decisionFor(R.linearDraft.id) as Record<string, string>;
    const r = okOut(await e.runOp('decisions.resolve', { decision_id: l.id, action: 'accept' }, ctxAt('human')));
    expect(r.op_status).toBe('skipped');
    expect(role(R.linearDraft.id).status).toBe('draft-ready');
  });

  it('the run refuses to archive a role that left scope mid-run', async () => {
    const roles = rolesFromDb(e.db).filter((r) => r.id === R.plaidOnDeck.id);
    const refused = { ...memoryStore(roles), recordCheck: () => true, archiveClosed: () => false, emit: () => 'ev_x' };
    const run = await checkFreshness(
      { role_ids: [R.plaidOnDeck.id] },
      { ...ctx, runId: 'rn_x' },
      {
        store: refused,
        fetch: f,
        ask: async () => ({
          answers: [{ id: 'open', value: false, p: 0.99 }],
          backend: 'kev',
          latencyMs: 1,
          decisionIds: ['dc_x'],
          outcomes: ['auto'],
        }),
        config: DEFAULT_CONFIG,
        delayMs: 0,
      },
    );
    expect(run.rows[0]).toMatchObject({ freshness: 'unsure', action: 'none', error: 'archive refused: role left freshness scope' });
  });

  it('dry run writes nothing and never calls the resolver', async () => {
    const count = () =>
      e.db.prepare('SELECT (SELECT count(*) FROM event) e, (SELECT count(*) FROM run) r, (SELECT count(*) FROM decision) d').get();
    const snapshot = () => e.db.prepare('SELECT * FROM role ORDER BY id').all();
    const [c0, s0] = [count(), snapshot()];
    const out = okOut(await e.runOp('roles.check_freshness', { all_in_scope: true }, { ...ctx, dryRun: true }));
    expect(e.kev.calls).toHaveLength(0);
    expect(count()).toEqual(c0);
    expect(snapshot()).toEqual(s0);
    expect(out.results).toHaveLength(16);
    expect(out.results.filter((r: { freshness: string }) => r.freshness === 'closed')).toHaveLength(5);
  });

  it('validates input against the contract', async () => {
    expect(await e.runOp('roles.check_freshness', { role_ids: 'x' }, ctx)).toMatchObject({ status: 'error', code: 'invalid_input' });
  });
});

describe('backfill dry run', () => {
  it('over the fixture db (read-only store)', async () => {
    const res = await backfillDryRun(memoryStore(rolesFromDb(e.db)), 'fixtures', {
      fetch: fakeFetch(route),
      delayMs: 0,
      now: () => new Date(FIXTURE_NOW),
    });
    expect(res.summary.checked).toBe(16);
    expect(res.report).toContain('# Freshness backfill dry run');
    expect(res.report).toMatch(/## Closed \(5\)/);
  });

  it('over a v1-shaped pipeline.json (synthetic)', async () => {
    const v1 = {
      roles: [
        {
          id: 'acme_staff-pm',
          company: 'Acme',
          role: 'Staff PM',
          status: 'active',
          url: 'https://job-boards.greenhouse.io/acme/jobs/1234567',
        },
        { id: 'acme_pm', company: 'Acme', role: 'PM', status: 'applied', url: 'https://job-boards.greenhouse.io/acme/jobs/7654321' },
        { id: 'beta_lead', company: 'Beta', role: 'Lead', status: 'on-deck', url: 'https://www.linkedin.com/jobs/view/1234567890' },
      ],
    };
    const roles = rolesFromV1Pipeline(v1);
    expect(roles.map((r) => r.id)).toEqual(['acme_staff-pm', 'beta_lead']);
    expect(roles[0]).toMatchObject({ ats_type: 'greenhouse', ats_board: 'acme', company_id: 'acme' });
    const f = fakeFetch((u) => (u.includes('boards-api') ? { status: 404, body: recorded('greenhouse_job_404.json') } : { status: 999 }));
    const res = await backfillDryRun(memoryStore(roles), 'v1', { fetch: f, delayMs: 0 });
    expect(res.rows.map((r) => [r.role_id, r.freshness])).toEqual([
      ['acme_staff-pm', 'closed'],
      ['beta_lead', 'unsure'],
    ]);
    expect(f.calls.some((u) => u.includes('7654321'))).toBe(false);
  });

  it('memoryStore refuses writes', () => {
    expect(() =>
      memoryStore([]).emit({ type: 'freshness_checked', subjectId: 'x', payload: {}, actor: 'agent', decisionId: null, ts: FIXTURE_NOW }),
    ).toThrow(/read-only/);
  });
});
