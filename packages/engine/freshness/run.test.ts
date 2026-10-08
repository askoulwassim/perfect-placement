import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AskFn,
  type AskRequest,
  DEFAULT_CONFIG,
  FRESHNESS_SCOPE,
  OPS,
  type OpContext,
  type PolicyOutcome,
} from '@perfect-placement/contracts';
import { FIXTURE_NOW, FIXTURE_SEED_SQL, roles as fixtureRoles } from '@perfect-placement/fixtures';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listMigrations, MIGRATIONS_DIR } from '../db/index.js';
import { fakeFetch, page, recorded } from '../integrations/ats/__fixtures__/fake-fetch.js';
import {
  backfillDryRun,
  checkFreshness,
  type FreshnessDeps,
  memoryStore,
  rolesCheckFreshnessHandler,
  rolesFromV1Pipeline,
  sqliteStore,
} from './index.js';

/*
 * WAVE 2 SHIM TEST: temp better-sqlite3 db from migrations + fixture seed, fake resolver, recorded HTTP.
 * Lanes A/B/I replace the store and resolver; the scenarios stay.
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

interface Scripted {
  value: boolean;
  p: number;
  outcome: PolicyOutcome;
}

/** Fake resolver: writes a decision row like lane I will, returns scripted answers per role. */
function fakeAsk(db: Database.Database, script: Record<string, Scripted | 'throw'>, now: string): AskFn & { calls: AskRequest[] } {
  const calls: AskRequest[] = [];
  let n = 0;
  const fn = (async (req: AskRequest) => {
    calls.push(req);
    const s = script[req.subject?.id ?? ''] ?? { value: true, p: 0.95, outcome: 'auto_undo' };
    if (s === 'throw') throw new Error('backend_unavailable');
    const decisionId = `dc_test${String(++n).padStart(3, '0')}`;
    const q = req.questions[0];
    db.prepare(
      `INSERT INTO decision (id, ts, kind, subject_type, subject_id, question_json, backend, answer_json, p, impact, policy_outcome, status, latency_ms)
       VALUES (?, ?, ?, 'role', ?, ?, 'jev', ?, ?, ?, ?, ?, 120)`,
    ).run(
      decisionId,
      now,
      req.decision,
      req.subject?.id,
      JSON.stringify(q),
      JSON.stringify({ id: q?.id, value: s.value, p: s.p }),
      s.p,
      req.impact,
      s.outcome,
      s.outcome === 'human' ? 'pending' : 'applied',
    );
    return {
      answers: [{ id: 'open', value: s.value, p: s.p }],
      backend: 'jev',
      latencyMs: 120,
      decisionIds: [decisionId],
      outcomes: [s.outcome],
    };
  }) as AskFn & { calls: AskRequest[] };
  fn.calls = calls;
  return fn;
}

const SCRIPT: Record<string, Scripted | 'throw'> = {
  [R.ddCost.id]: { value: false, p: 0.97, outcome: 'auto_undo' },
  [R.airtableOnDeck.id]: { value: false, p: 0.8, outcome: 'human' },
  [R.vercelDraft.id]: { value: true, p: 0.95, outcome: 'auto_undo' },
  [R.linearAi.id]: { value: true, p: 0.95, outcome: 'auto_undo' },
  [R.rampActive.id]: { value: false, p: 0.96, outcome: 'auto_undo' },
  [R.retoolActive.id]: 'throw',
  [R.plaidOnDeck.id]: { value: false, p: 0.99, outcome: 'auto_undo' },
  [R.linearDraft.id]: { value: true, p: 0.6, outcome: 'human' },
};

let dir: string;
let db: Database.Database;
const ctx: OpContext = { actor: 'schedule', now: () => new Date(FIXTURE_NOW) };

function freshDb() {
  dir = mkdtempSync(join(tmpdir(), 'pp-lane-g-'));
  db = new Database(join(dir, 'pp.db'));
  for (const f of listMigrations()) db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  db.exec(readFileSync(FIXTURE_SEED_SQL, 'utf8'));
}

const role = (rid: string) =>
  db.prepare('SELECT * FROM role WHERE id = ?').get(rid) as {
    status: string;
    freshness: string;
    archive_reason: string | null;
    last_checked_at: string | null;
    flags_json: string;
  };
const protectedSnapshot = () =>
  db.prepare(`SELECT * FROM role WHERE status NOT IN (${FRESHNESS_SCOPE.map((s) => `'${s}'`).join(',')}) ORDER BY id`).all();
const eventsFor = (rid: string) =>
  db
    .prepare(`SELECT type, decision_id, payload_json, actor FROM event WHERE subject_id = ? AND ts = ? ORDER BY rowid`)
    .all(rid, FIXTURE_NOW) as Array<{
    type: string;
    decision_id: string | null;
    payload_json: string;
    actor: string;
  }>;

function deps(extra: Partial<FreshnessDeps> = {}) {
  const f = fakeFetch(route);
  const ask = fakeAsk(db, SCRIPT, FIXTURE_NOW);
  const logs: Array<[string, string]> = [];
  const d: FreshnessDeps = {
    store: sqliteStore(db),
    fetch: f,
    ask,
    config: DEFAULT_CONFIG,
    delayMs: 0,
    writeRunLog: (p, md) => {
      logs.push([p, md]);
    },
    ...extra,
  };
  return { d, f, ask, logs };
}

beforeEach(freshDb);
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('roles.check_freshness over fixtures', () => {
  it('daily run: scope only, ladder outcomes, events, run log', async () => {
    const before = protectedSnapshot();
    const { d, f, ask, logs } = deps();
    const run = await checkFreshness({ all_in_scope: true }, ctx, d);

    const inScope = db.prepare(`SELECT count(*) AS n FROM role WHERE status IN ('active','held','on-deck','draft-ready')`).get() as {
      n: number;
    };
    expect(run.summary.checked).toBe(16);
    expect(inScope.n + run.summary.closed).toBe(16);

    // Applied-or-later and archived/inbox roles: untouched and never fetched.
    // Out-of-scope rows are unchanged apart from the three this run archived.
    const after = protectedSnapshot() as Array<{ id: string }>;
    expect(after).toHaveLength(before.length + 3);
    expect(after.filter((r) => ![R.ddCost.id, R.rampActive.id, R.plaidOnDeck.id].includes(r.id))).toEqual(before);
    for (const r of [R.stripeApplied, R.figmaIv, R.retoolOffer]) {
      expect(role(r.id)).toMatchObject({ status: r.status, freshness: r.freshness, last_checked_at: r.last_checked_at });
      expect(f.calls.some((u) => u === r.url || (r.ats_job_id !== null && u.includes(r.ats_job_id)))).toBe(false);
      expect(ask.calls.some((c) => c.subject?.id === r.id)).toBe(false);
    }

    const byId = new Map(run.output.results.map((r) => [r.role_id, r]));

    // ATS live -> open, no resolver call.
    const figma = id('figma', 'Principal PM, Developer Platform');
    expect(byId.get(figma.id)).toEqual({ role_id: figma.id, freshness: 'open', method: 'ats_api', stale: false, decision_id: null });
    expect(role(figma.id)).toMatchObject({ freshness: 'open', last_checked_at: FIXTURE_NOW, status: 'active' });
    expect(ask.calls.some((c) => c.subject?.id === figma.id)).toBe(false);

    // ATS 404 + resolver no (auto_undo) -> archived closed.
    const ddDecision = ask.calls.findIndex((c) => c.subject?.id === R.ddCost.id);
    const ddDecisionId = `dc_test${String(ddDecision + 1).padStart(3, '0')}`;
    expect(byId.get(R.ddCost.id)).toMatchObject({ freshness: 'closed', method: 'ats_api', decision_id: ddDecisionId });
    expect(role(R.ddCost.id)).toMatchObject({ status: 'archived', archive_reason: 'closed', freshness: 'closed' });
    expect(JSON.parse(role(R.ddCost.id).flags_json).closed.reason).toBe('greenhouse api: job not found');
    expect(eventsFor(R.ddCost.id).map((e) => e.type)).toEqual(['freshness_checked', 'role_closed', 'role_archived']);
    expect(eventsFor(R.ddCost.id).every((e) => e.decision_id === ddDecisionId && e.actor === 'schedule')).toBe(true);
    expect(JSON.parse(eventsFor(R.ddCost.id)[2]?.payload_json ?? '{}')).toMatchObject({ reason: 'closed', from: 'active' });

    // Board missing -> page redirect -> resolver human -> unsure, decision carries the archive action.
    expect(byId.get(R.airtableOnDeck.id)).toMatchObject({ freshness: 'unsure', method: 'page' });
    expect(role(R.airtableOnDeck.id)).toMatchObject({ status: 'on-deck', freshness: 'unsure', last_checked_at: FIXTURE_NOW });
    const dec = db.prepare('SELECT action_json FROM decision WHERE subject_id = ? AND ts = ?').get(R.airtableOnDeck.id, FIXTURE_NOW) as {
      action_json: string;
    };
    expect(JSON.parse(dec.action_json)).toEqual({ op: 'roles.archive', input: { role_id: R.airtableOnDeck.id, reason: 'closed' } });

    // Hard 404 but resolver says open -> conflict -> unsure, draft-ready kept.
    expect(byId.get(R.vercelDraft.id)).toMatchObject({ freshness: 'unsure', method: 'ats_api' });
    expect(role(R.vercelDraft.id).status).toBe('draft-ready');

    // Page inconclusive -> resolver yes -> open via resolver; page text is in the state.
    expect(byId.get(R.linearAi.id)).toMatchObject({ freshness: 'open', method: 'resolver' });
    const linearReq = ask.calls.find((c) => c.subject?.id === R.linearAi.id);
    expect(linearReq).toMatchObject({ decision: 'freshness.closed', impact: 'medium', questions: [{ id: 'open', type: 'noulli' }] });
    expect((linearReq?.state as Record<string, string> | undefined)?.page_text).toContain('Apply for this job');

    // Closed phrase / page 404 -> resolver no -> archived via page.
    expect(byId.get(R.rampActive.id)).toMatchObject({ freshness: 'closed', method: 'page' });
    expect(byId.get(R.plaidOnDeck.id)).toMatchObject({ freshness: 'closed', method: 'page' });
    expect(role(R.plaidOnDeck.id)).toMatchObject({ status: 'archived', archive_reason: 'closed' });

    // Resolver down -> unsure with error; stale flag (found 50 days ago).
    expect(byId.get(R.retoolActive.id)).toMatchObject({ freshness: 'unsure', stale: true, decision_id: null });
    expect(JSON.parse(role(R.retoolActive.id).flags_json)).toMatchObject({ stale: true });
    expect(role(R.retoolActive.id).status).toBe('active');

    // Human pick on a draft-ready role -> unsure, never archived.
    expect(role(R.linearDraft.id)).toMatchObject({ status: 'draft-ready', freshness: 'unsure' });

    expect(run.summary).toMatchObject({ checked: 16, closed: 3, unsure: 4, open: 9, stale: 1, errors: 1, dry_run: false });

    const runRow = db.prepare('SELECT * FROM run WHERE id = ?').get(run.runId) as {
      op: string;
      status: string;
      summary_json: string;
      log_path: string;
    };
    expect(runRow).toMatchObject({ op: 'freshness', status: 'partial', log_path: 'runs/2026-10-08_freshness.md' });
    expect(JSON.parse(runRow.summary_json)).toMatchObject({ checked: 16, closed: 3 });
    expect(logs[0]?.[0]).toBe('runs/2026-10-08_freshness.md');
    expect(logs[0]?.[1]).toMatch(/^---\nid: rn_[0-9A-Z]{26}\ntype: run\n---/);

    // Output matches the contract.
    expect(() => OPS['roles.check_freshness'].output.parse(run.output)).not.toThrow();
  });

  it('role_ids outside scope are skipped and never touched', async () => {
    const { d, f, ask } = deps();
    const run = await checkFreshness({ role_ids: [R.stripeApplied.id, R.figmaIv.id, R.retoolOffer.id, R.linearAi.id, 'nope_x'] }, ctx, d);
    expect(run.output.results.map((r) => r.role_id)).toEqual([R.linearAi.id]);
    expect(run.skipped).toEqual([R.stripeApplied.id, R.figmaIv.id, R.retoolOffer.id, 'nope_x']);
    expect(f.calls).toEqual([R.linearAi.url]);
    expect(ask.calls).toHaveLength(1);
  });

  it('store refuses to archive a role that left scope mid-run', async () => {
    const store = sqliteStore(db);
    const { d } = deps({
      store: {
        ...store,
        listInScope: async (ids) => {
          const rows = await store.listInScope(ids);
          db.prepare(`UPDATE role SET status = 'applied' WHERE id = ?`).run(R.plaidOnDeck.id); // applied meanwhile
          return rows;
        },
      },
    });
    const run = await checkFreshness({ role_ids: [R.plaidOnDeck.id] }, ctx, d);
    expect(run.rows[0]).toMatchObject({ freshness: 'unsure', action: 'none', error: 'archive refused: role left freshness scope' });
    expect(role(R.plaidOnDeck.id)).toMatchObject({ status: 'applied', archive_reason: null });
  });

  it('dry run writes nothing and never calls the resolver', async () => {
    const count = () =>
      db.prepare('SELECT (SELECT count(*) FROM event) e, (SELECT count(*) FROM run) r, (SELECT count(*) FROM decision) d').get();
    const snapshot = () => db.prepare('SELECT * FROM role ORDER BY id').all();
    const [c0, s0] = [count(), snapshot()];
    const { d, ask } = deps();
    const run = await checkFreshness({ all_in_scope: true }, { ...ctx, dryRun: true }, d);
    expect(ask.calls).toHaveLength(0);
    expect(count()).toEqual(c0);
    expect(snapshot()).toEqual(s0);
    expect(run.runId).toBeNull();
    // Hard evidence reads as closed; everything else that is not ATS-open would be asked.
    expect(run.summary).toMatchObject({ checked: 16, closed: 5, dry_run: true });
    expect(run.summary.open + run.summary.closed + run.summary.unsure).toBe(16);
  });

  it('handler validates input and output against the contract', async () => {
    const { d } = deps();
    const handler = rolesCheckFreshnessHandler(d);
    const out = await handler({ role_ids: [R.ddCost.id] }, ctx);
    expect(out.results[0]).toMatchObject({ role_id: R.ddCost.id, freshness: 'closed' });
    await expect(handler({ role_ids: 'x' }, ctx)).rejects.toThrow();
  });
});

describe('backfill dry run', () => {
  it('over the fixture db (read-only store)', async () => {
    const res = await backfillDryRun(sqliteStore(db), 'fixtures', {
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
