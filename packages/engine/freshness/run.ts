import type { AskFn, AskRequest, OpContext, OpOutput, PolicyConfig, PolicyOutcome } from '@perfect-placement/contracts';
import { vaultPath } from '@perfect-placement/contracts';
import { createAtsClient, type FetchLike } from '../integrations/ats/index.js';
import { assess, type Evidence } from './ladder.js';
import { renderRunLog } from './report.js';
import type { FreshnessStore, ScopeRole } from './store.js';

export type CheckFreshnessInput = { role_ids?: string[]; all_in_scope?: boolean };
export type CheckFreshnessOutput = OpOutput<'roles.check_freshness'>;
export type FreshnessResult = CheckFreshnessOutput['results'][number];

/** Run-log op name (matches fixture runs: `runs/<date>_freshness.md`). */
export const RUN_OP = 'freshness';
/** The resolver question. Same id + wording as the fixture decisions. */
export const OPEN_QUESTION = { id: 'open', type: 'noulli', instructions: 'Is this posting still accepting applications?' } as const;

export interface FreshnessDeps {
  store: FreshnessStore;
  fetch: FetchLike;
  /** Resolver `ask` (lane I). Not called in dry-run. */
  ask: AskFn;
  config: Pick<PolicyConfig, 'freshness'>;
  /** Politeness gap between roles that hit the network. Default 750 ms. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Writes `runs/<date>_freshness.md` into the vault (vault-relative path). Optional. Returns the path
   * actually written when it differs (e.g. a second run on the same day).
   */
  writeRunLog?: (relPath: string, markdown: string) => string | undefined | Promise<string | undefined>;
  /** Cap on page/JD text sent as resolver state. */
  maxText?: number;
}

/** One row of the run report (richer than the op output; used for run logs and dry-run reports). */
export interface FreshnessRow extends FreshnessResult {
  title: string;
  company: string;
  status: string;
  evidence: string;
  ats: string | null;
  http_status: number;
  age_days: number | null;
  /** What a non-dry run would do / did: `touch`, `archive`, `queue`, `none`. */
  action: 'touch' | 'archive' | 'queue' | 'none';
  p: number | null;
  error?: string;
}

export interface FreshnessRun {
  output: CheckFreshnessOutput;
  rows: FreshnessRow[];
  /** Requested ids that were not in scope (applied or later, archived, inbox, unknown). Never touched. */
  skipped: string[];
  summary: FreshnessSummary;
  runId: string | null;
}

export interface FreshnessSummary {
  checked: number;
  open: number;
  closed: number;
  unsure: number;
  stale: number;
  skipped: number;
  errors: number;
  by_method: Record<FreshnessResult['method'], number>;
  dry_run: boolean;
}

const APPLIED: readonly PolicyOutcome[] = ['auto', 'auto_second', 'auto_undo'];

export function ageDays(role: Pick<ScopeRole, 'posted_at' | 'found_at'>, now: Date): number | null {
  const ref = role.posted_at ?? role.found_at;
  if (!ref) return null;
  const t = Date.parse(ref);
  return Number.isNaN(t) ? null : Math.floor((now.getTime() - t) / 86_400_000);
}

function resolverState(role: ScopeRole, ev: Evidence): Record<string, string> {
  return {
    role: role.title,
    company: role.company_name,
    url: role.url ?? '',
    ats: ev.ats ?? 'none',
    checked_via: ev.method,
    signal: ev.verdict,
    evidence: ev.reason,
    http_status: String(ev.status),
    final_url: ev.finalUrl ?? '',
    page_text: ev.text,
  };
}

function isYes(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    if (s === 'yes' || s === 'true') return true;
    if (s === 'no' || s === 'false') return false;
  }
  return null;
}

/**
 * `roles.check_freshness` (lane G). Daily over FRESHNESS_SCOPE, or over `role_ids`.
 * Ladder: ATS API -> page -> resolver Noulli "still accepting applications?".
 * - open (ATS live, or resolver yes + auto): touch last_checked_at.
 * - closed (resolver no + auto/auto_second/auto_undo): archive reason `closed` (medium, undo window is the resolver's).
 * - unsure (resolver routed to human, conflict, or error): freshness `unsure`, decision waits in Needs you.
 * - stale (age > config.freshness.stale_after_days): flag only.
 * Never touches applied-or-later roles: the store only lists and writes FRESHNESS_SCOPE.
 */
export async function checkFreshness(input: CheckFreshnessInput, ctx: OpContext, deps: FreshnessDeps): Promise<FreshnessRun> {
  const dry = ctx.dryRun === true;
  const startedAt = ctx.now();
  const roleIds = input.role_ids && !input.all_in_scope ? [...new Set(input.role_ids)] : undefined;
  const roles = await deps.store.listInScope(roleIds);
  const skipped = roleIds ? roleIds.filter((id) => !roles.some((r) => r.id === id)) : [];
  const runId = dry ? null : (ctx.runId ?? (await deps.store.startRun(RUN_OP, startedAt.toISOString())));
  const ats = createAtsClient(deps.fetch);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delay = deps.delayMs ?? 750;
  const staleAfter = deps.config.freshness.stale_after_days;
  const rows: FreshnessRow[] = [];

  for (const [i, role] of roles.entries()) {
    if (i > 0 && delay > 0) await sleep(delay);
    const now = ctx.now();
    const at = now.toISOString();
    const age = ageDays(role, now);
    const stale = age !== null && age > staleAfter;
    let ev: Evidence;
    try {
      ev = await assess({ url: role.url, hint: { ats_type: role.ats_type, ats_board: role.ats_board } }, ats, deps.fetch, deps.maxText);
    } catch (e) {
      ev = {
        method: 'page',
        verdict: 'inconclusive',
        reason: `ladder error: ${e instanceof Error ? e.message : String(e)}`,
        ats: null,
        status: 0,
        finalUrl: null,
        text: '',
        blocked: true,
      };
    }

    const row: FreshnessRow = {
      role_id: role.id,
      freshness: 'unsure',
      method: ev.verdict === 'inconclusive' ? 'resolver' : ev.method,
      stale,
      decision_id: null,
      title: role.title,
      company: role.company_name,
      status: role.status,
      evidence: ev.reason,
      ats: ev.ats,
      http_status: ev.status,
      age_days: age,
      action: 'queue',
      p: null,
    };

    if (ev.verdict === 'open') {
      row.freshness = 'open';
      row.action = 'touch';
    } else if (dry) {
      // Dry run: no resolver call, no writes. Hard closed evidence reads as closed; the rest would be asked.
      row.freshness = ev.verdict === 'closed' ? 'closed' : 'unsure';
      row.action = ev.verdict === 'closed' ? 'archive' : 'queue';
    } else {
      const req: AskRequest = {
        decision: 'freshness.closed',
        impact: 'medium',
        state: resolverState(role, ev),
        questions: [OPEN_QUESTION],
        subject: { type: 'role', id: role.id },
        // A human accept of "not open" archives it; undo restores the prior status.
        action: {
          op: 'roles.archive',
          input: { role_id: role.id, reason: 'closed' },
          when: false,
          undo: { op: 'roles.move', input: { role_id: role.id, to: role.status } },
        },
      };
      try {
        const res = await deps.ask(req);
        const idx = res.answers.findIndex((a) => a.id === OPEN_QUESTION.id);
        const ans = res.answers[idx];
        const outcome = res.outcomes[idx];
        row.decision_id = res.decisionIds[idx] ?? null;
        row.p = ans?.p ?? null;
        const accepting = isYes(ans?.value);
        const applied = outcome !== undefined && APPLIED.includes(outcome);
        if (accepting === false && applied) {
          row.freshness = 'closed';
          row.action = 'archive';
        } else if (accepting === true && applied && ev.verdict !== 'closed') {
          row.freshness = 'open';
          row.action = 'touch';
        } else {
          // Human outcome, unparseable answer, or the resolver contradicts hard closed evidence.
          row.freshness = 'unsure';
          row.action = 'queue';
          if (accepting === true && ev.verdict === 'closed') row.evidence += '; resolver says open: conflict';
        }
      } catch (e) {
        row.freshness = 'unsure';
        row.action = 'none';
        row.error = `resolver: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    if (!dry) await persist(role, row, at, ctx, deps.store);
    rows.push(row);
  }

  const summary = summarize(rows, skipped.length, dry);
  if (!dry && runId && !ctx.runId) {
    const date = startedAt.toISOString().slice(0, 10);
    let logPath = deps.writeRunLog ? vaultPath.runLog(date, RUN_OP) : null;
    if (deps.writeRunLog && logPath) {
      const written = await deps.writeRunLog(logPath, renderRunLog(rows, summary, { runId, startedAt: startedAt.toISOString() }));
      if (typeof written === 'string') logPath = written;
    }
    await deps.store.finishRun(runId, {
      at: ctx.now().toISOString(),
      status: summary.errors > 0 ? 'partial' : 'ok',
      summary: { ...summary },
      logPath,
    });
  }

  const output: CheckFreshnessOutput = {
    results: rows.map(({ role_id, freshness, method, stale, decision_id }) => ({ role_id, freshness, method, stale, decision_id })),
    skipped,
  };
  return { output, rows, skipped, summary, runId };
}

async function persist(role: ScopeRole, row: FreshnessRow, at: string, ctx: OpContext, store: FreshnessStore): Promise<void> {
  const flags: Record<string, unknown> = { ...role.flags_json };
  if (row.stale) flags.stale = true;
  else delete flags.stale;
  const payload = {
    freshness: row.freshness,
    method: row.method,
    evidence: row.evidence,
    stale: row.stale,
    ...(row.p === null ? {} : { p: row.p }),
    ...(row.error ? { error: row.error } : {}),
  };
  const emit = (type: 'freshness_checked' | 'role_closed' | 'role_archived', extra: Record<string, unknown> = {}) =>
    store.emit({ type, subjectId: role.id, payload: { ...payload, ...extra }, actor: ctx.actor, decisionId: row.decision_id, ts: at });

  if (row.action === 'archive') {
    flags.closed = { reason: row.evidence, at };
    const ok = await store.archiveClosed({ roleId: role.id, at, flags, decisionId: row.decision_id });
    if (!ok) {
      // Status changed under us (e.g. applied meanwhile): leave it alone.
      row.freshness = 'unsure';
      row.action = 'none';
      row.error = 'archive refused: role left freshness scope';
      await emit('freshness_checked');
      return;
    }
    await emit('freshness_checked');
    await emit('role_closed');
    // `from` lets decisions.undo restore the prior status inside the undo window.
    await emit('role_archived', { reason: 'closed', from: role.status });
    return;
  }

  await store.recordCheck({ roleId: role.id, freshness: row.freshness === 'open' ? 'open' : 'unsure', at, flags });
  await emit('freshness_checked');
}

export function summarize(rows: FreshnessRow[], skipped: number, dryRun: boolean): FreshnessSummary {
  const count = (f: (r: FreshnessRow) => boolean) => rows.filter(f).length;
  return {
    checked: rows.length,
    open: count((r) => r.freshness === 'open'),
    closed: count((r) => r.freshness === 'closed'),
    unsure: count((r) => r.freshness === 'unsure'),
    stale: count((r) => r.stale),
    skipped,
    errors: count((r) => r.error !== undefined),
    by_method: {
      ats_api: count((r) => r.method === 'ats_api'),
      page: count((r) => r.method === 'page'),
      resolver: count((r) => r.method === 'resolver'),
    },
    dry_run: dryRun,
  };
}
