import {
  type ArchiveReason,
  type Band,
  CRITERIA,
  DEFAULT_CONFIG,
  type PolicyConfig,
  type ProfileComponent,
  type RoleStatus,
} from '@perfect-placement/contracts';
import { allocateCompanySlots } from './cap.js';
import { type Criteria, computeScore, type ScoreFacts } from './math.js';
import { normalizeWeights, type Rubric, readWeights } from './rubric.js';

/*
 * Read-only backtest: replay v1 judgments (the stored C1..C9) through the v2 mechanics
 * (capped affinity, no dream-company dealbreaker bypass, per-company cap, no-downgrade) and compare.
 * Nothing here writes anywhere; the CLI writes the report to a directory outside the repo.
 *
 * Limitation: blind scoring changes the *judgment* (C1, C2, C3, C4, C9 without the brand). A replay of
 * stored criteria cannot show that part; the report says so.
 */

export interface BacktestRole {
  id: string;
  company: string;
  title: string;
  v1_status: RoleStatus;
  v1_total: number;
  v1_band: Band;
  criteria: Criteria;
  dream: boolean;
  /** Workplace facts as v2 would see them. */
  facts: ScoreFacts;
  /** v1 archive reason, inferred. Only below_threshold and dealbreaker are revivable. */
  v1_archive_reason: ArchiveReason | null;
  found: string;
}

// ------------------------------------------------------------- v1 import

interface V1Score {
  id: string;
  company: string;
  role: string;
  scored?: string;
  criteria: Record<string, number>;
  total: number;
  band: Band;
}
interface V1Role {
  id: string;
  company: string;
  role: string;
  status: string;
  band?: Band;
  fit_score?: number;
  workplace?: string | null;
  remote_ok?: unknown;
  flags?: string[] | null;
  reason?: string | null;
  comp_min?: number | null;
  comp_max?: number | null;
}
export interface V1Data {
  pipeline: { roles: V1Role[] };
  scores: { scores: V1Score[] };
  rubric: { weights: Record<string, number>; bands: { green_min: number; yellow_min: number }; dream_companies?: string[] };
}

const V1_STATUS: Record<string, RoleStatus> = {
  active: 'active',
  'on-deck': 'on-deck',
  'draft-ready': 'draft-ready',
  applied: 'applied',
  interviews: 'interviews',
  offers: 'offers',
  archived: 'archived',
  inbox: 'inbox',
};

/** Workplace facts from v1 fields. `dream-exception` means v1 let a non-remote role through: v2 sees it as not remote. */
export function v1WorkplaceFacts(r: Pick<V1Role, 'remote_ok' | 'workplace' | 'reason' | 'comp_min' | 'comp_max'>): ScoreFacts {
  const comp = { comp_min: r.comp_min ?? null, comp_max: r.comp_max ?? null };
  const reason = (r.reason ?? '').toLowerCase();
  if (r.remote_ok === 'dream-exception' || r.remote_ok === false) return { workplace: 'hybrid', remote_ok: false, ...comp };
  if (/dealbreaker|forced archive|not a dream-co|not on dream-co/.test(reason)) return { workplace: 'hybrid', remote_ok: false, ...comp };
  if (r.remote_ok === true || r.remote_ok === 'remote') return { workplace: 'remote', remote_ok: true, ...comp };
  const wp = (r.workplace ?? '').toLowerCase();
  if (/\bremote\b/.test(wp)) return { workplace: 'remote', remote_ok: true, ...comp };
  if (/onsite|on-site|in-person/.test(wp)) return { workplace: 'onsite', remote_ok: false, ...comp };
  if (/hybrid/.test(wp)) return { workplace: 'hybrid', remote_ok: null, ...comp };
  return { workplace: 'unspecified', remote_ok: null, ...comp };
}

export function v1ArchiveReason(r: Pick<V1Role, 'status' | 'band' | 'flags' | 'reason'>): ArchiveReason | null {
  if (r.status !== 'archived') return null;
  const reason = (r.reason ?? '').toLowerCase();
  if ((r.flags ?? []).includes('closed')) return 'closed';
  if (/duplicate/.test(reason)) return 'legacy';
  if (/dealbreaker|forced archive|not a dream-co|not on dream-co/.test(reason)) return 'dealbreaker';
  if (r.band && r.band !== 'green') return 'below_threshold';
  return 'legacy';
}

export function fromV1(v1: V1Data): BacktestRole[] {
  const latest = new Map<string, V1Score>();
  for (const s of v1.scores.scores) {
    const prev = latest.get(s.id);
    if (!prev || (s.scored ?? '') >= (prev.scored ?? '')) latest.set(s.id, s);
  }
  const dreamList = new Set((v1.rubric.dream_companies ?? []).map((d) => d.toLowerCase()));
  const out: BacktestRole[] = [];
  for (const r of v1.pipeline.roles) {
    const s = latest.get(r.id);
    if (!s) continue;
    const criteria = {} as Criteria;
    for (const k of CRITERIA) criteria[k] = Number(s.criteria[k.toUpperCase()] ?? s.criteria[k]);
    out.push({
      id: r.id,
      company: r.company,
      title: r.role,
      v1_status: V1_STATUS[r.status] ?? 'archived',
      v1_total: s.total,
      v1_band: s.band,
      criteria,
      dream: (r.flags ?? []).includes('dream-co') || dreamList.has(r.company.toLowerCase()) || r.remote_ok === 'dream-exception',
      facts: v1WorkplaceFacts(r),
      v1_archive_reason: v1ArchiveReason({ ...r, band: r.band ?? s.band }),
      found: s.scored ?? '',
    });
  }
  return out;
}

/** v1 rubric as a v2 rubric + the v1 filters as profile components (remote required, comp not a gate). */
export function v1Profile(v1: V1Data, config: PolicyConfig = DEFAULT_CONFIG): { rubric: Rubric; components: ProfileComponent[] } {
  const rubric: Rubric = {
    version: 'v1-replay',
    weights: normalizeWeights(readWeights(v1.rubric.weights)),
    scale: 'v1',
    green_min: v1.rubric.bands.green_min,
    yellow_min: v1.rubric.bands.yellow_min,
    affinity_cap: config.scoring.affinity_cap,
    company_active_cap: config.scoring.company_active_cap,
    weights_source: 'default',
    profile_version_id: null,
  };
  const comp = (key: ProfileComponent['key'], kind: ProfileComponent['kind'], data: Record<string, unknown>): ProfileComponent => ({
    id: `pc_backtest_${key}`,
    version_id: 'pv_backtest',
    key,
    kind,
    confidence: 1,
    weight: null,
    data_json: data,
    md_path: null,
  });
  return { rubric, components: [comp('work_mode', 'filter', { modes: ['remote'] })] };
}

// ------------------------------------------------------------- replay

export interface BacktestOptions {
  rubric: Rubric;
  components: readonly ProfileComponent[];
  /** Affinity given to dream companies (before the cap). Others get 0. */
  dreamAffinity: number;
}

export interface BacktestRow {
  id: string;
  company: string;
  title: string;
  dream: boolean;
  v1_status: RoleStatus;
  v2_status: RoleStatus;
  v1_total: number;
  v2_total: number;
  v1_band: Band;
  v2_band: Band;
  /** Facts v2 would flag for checking (remote, comp unknown). */
  verify: string[];
  why: string;
}

const MOVABLE = new Set<RoleStatus>(['inbox', 'active', 'held']);
const REVIVABLE = new Set<ArchiveReason>(['below_threshold', 'dealbreaker']);

export function replay(roles: readonly BacktestRole[], opt: BacktestOptions): BacktestRow[] {
  const rows: BacktestRow[] = [];
  const candidates: Array<{ role_id: string; total: number; found_at: string; company: string }> = [];
  for (const r of roles) {
    const c = computeScore(r.criteria, r.facts, opt.rubric, opt.components, r.dream ? opt.dreamAffinity : 0);
    const movable =
      MOVABLE.has(r.v1_status) || (r.v1_status === 'archived' && r.v1_archive_reason !== null && REVIVABLE.has(r.v1_archive_reason));
    let v2: RoleStatus = r.v1_status;
    let why = movable ? '' : `kept at ${r.v1_status}${r.v1_archive_reason ? ` (${r.v1_archive_reason})` : ''}`;
    if (movable) {
      if (c.verdict === 'active') {
        v2 = 'active';
        candidates.push({ role_id: r.id, total: c.total, found_at: r.found, company: r.company });
      } else {
        v2 = 'archived';
        why = c.archive_reason === 'dealbreaker' ? `dealbreaker: ${c.dealbreakers.hits.join(', ')}` : `below threshold (${c.total})`;
      }
    }
    rows.push({
      id: r.id,
      company: r.company,
      title: r.title,
      dream: r.dream,
      v1_status: r.v1_status,
      v2_status: v2,
      v1_total: r.v1_total,
      v2_total: c.total,
      v1_band: r.v1_band,
      v2_band: c.band,
      verify: c.dealbreakers.verify,
      why,
    });
  }
  // Per-company cap over the v2 active candidates.
  const byCo = new Map<string, typeof candidates>();
  for (const c of candidates) byCo.set(c.company, [...(byCo.get(c.company) ?? []), c]);
  const held = new Set<string>();
  for (const list of byCo.values()) for (const id of allocateCompanySlots(list, opt.rubric.company_active_cap).held) held.add(id);
  for (const row of rows) {
    if (held.has(row.id)) {
      row.v2_status = 'held';
      row.why = 'company cap';
    } else if (row.v2_status === 'active' && row.v1_status !== 'active') row.why = `revived (${row.v2_total})`;
  }
  return rows;
}

// ------------------------------------------------------------- aggregates

export interface MixStats {
  roles: number;
  companies: number;
  top5_share: number;
  max_per_company: number;
  dream_share: number;
}

export function mixStats(rows: readonly { company: string; dream: boolean }[]): MixStats {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.company, (counts.get(r.company) ?? 0) + 1);
  const sorted = [...counts.values()].sort((a, b) => b - a);
  const n = rows.length;
  const share = (x: number) => (n ? Math.round((x / n) * 1000) / 10 : 0);
  return {
    roles: n,
    companies: counts.size,
    top5_share: share(sorted.slice(0, 5).reduce((s, v) => s + v, 0)),
    max_per_company: sorted[0] ?? 0,
    dream_share: share(rows.filter((r) => r.dream).length),
  };
}

export interface BacktestSummary {
  scenario: string;
  roles: number;
  before: MixStats;
  after: MixStats;
  transitions: Record<string, number>;
  changed: number;
  band_shift: Record<string, number>;
  /** v2 active roles whose remote status is unverified (flagged, not archived). */
  after_verify_remote: number;
  dream_avg_v1: number;
  dream_avg_v2: number;
  all_avg_v1: number;
  all_avg_v2: number;
}

const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, v) => s + v, 0) / xs.length) * 10) / 10 : 0);

export function summarize(scenario: string, rows: readonly BacktestRow[]): BacktestSummary {
  const transitions: Record<string, number> = {};
  const band_shift: Record<string, number> = {};
  for (const r of rows) {
    const t = `${r.v1_status} -> ${r.v2_status}`;
    transitions[t] = (transitions[t] ?? 0) + 1;
    const b = `${r.v1_band} -> ${r.v2_band}`;
    band_shift[b] = (band_shift[b] ?? 0) + 1;
  }
  const dream = rows.filter((r) => r.dream);
  return {
    scenario,
    roles: rows.length,
    before: mixStats(rows.filter((r) => r.v1_status === 'active')),
    after: mixStats(rows.filter((r) => r.v2_status === 'active')),
    transitions,
    changed: rows.filter((r) => r.v1_status !== r.v2_status).length,
    band_shift,
    after_verify_remote: rows.filter((r) => r.v2_status === 'active' && r.verify.includes('remote')).length,
    dream_avg_v1: avg(dream.map((r) => r.v1_total)),
    dream_avg_v2: avg(dream.map((r) => r.v2_total)),
    all_avg_v1: avg(rows.map((r) => r.v1_total)),
    all_avg_v2: avg(rows.map((r) => r.v2_total)),
  };
}

// ------------------------------------------------------------- report

const table = (head: string[], body: Array<Array<string | number>>) =>
  [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n');

/** Markdown report. `includeRoles` lists companies and titles: PRIVATE, never commit that output. */
export function renderReport(
  results: Array<{ summary: BacktestSummary; rows: BacktestRow[] }>,
  opts: { includeRoles: boolean; generated: string },
): string {
  const out: string[] = [
    `# Scoring v2 backtest`,
    '',
    `Generated ${opts.generated}. Read-only replay of stored v1 criteria through v2 mechanics.`,
    '',
  ];
  out.push(
    '**Method.** Same C1..C9 judgments and v1 weights. Changes applied: affinity nudge capped at the config cap (dream companies get the scenario value, others 0), no dream-company dealbreaker bypass (remote required), per-company active cap, no-downgrade (on-deck and later kept; archived roles revive only if they were archived by the score). Blind scoring changes judgment and cannot be replayed from stored criteria.',
    '',
  );
  for (const { summary: s, rows } of results) {
    out.push(`## Scenario: ${s.scenario}`, '');
    out.push(
      table(
        ['Active set', 'Roles', 'Companies', 'Top-5 share %', 'Max per company', 'Dream share %'],
        [
          ['v1', s.before.roles, s.before.companies, s.before.top5_share, s.before.max_per_company, s.before.dream_share],
          ['v2', s.after.roles, s.after.companies, s.after.top5_share, s.after.max_per_company, s.after.dream_share],
        ],
      ),
      '',
    );
    out.push(
      `Roles that change state: **${s.changed}** of ${s.roles}. v2 active roles flagged to verify remote: ${s.after_verify_remote}.`,
      '',
    );
    out.push(
      table(
        ['Transition', 'Count'],
        Object.entries(s.transitions)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => [k, v]),
      ),
      '',
    );
    out.push(
      table(
        ['Band shift', 'Count'],
        Object.entries(s.band_shift)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => [k, v]),
      ),
      '',
    );
    out.push(
      table(
        ['Average total', 'v1', 'v2'],
        [
          ['Dream companies', s.dream_avg_v1, s.dream_avg_v2],
          ['All roles', s.all_avg_v1, s.all_avg_v2],
        ],
      ),
      '',
    );
    if (opts.includeRoles) {
      const changed = rows
        .filter((r) => r.v1_status !== r.v2_status)
        .sort((a, b) => a.company.localeCompare(b.company) || b.v2_total - a.v2_total);
      out.push(
        '### Roles that change state',
        '',
        table(
          ['Company', 'Role', 'Dream', 'v1', 'v2', 'v1 total', 'v2 total', 'Why'],
          changed.map((r) => [r.company, r.title, r.dream ? 'yes' : '', r.v1_status, r.v2_status, r.v1_total, r.v2_total, r.why]),
        ),
        '',
      );
      const counts = (pick: (r: BacktestRow) => boolean) => {
        const m = new Map<string, number>();
        for (const r of rows.filter(pick)) m.set(r.company, (m.get(r.company) ?? 0) + 1);
        return m;
      };
      const before = counts((r) => r.v1_status === 'active');
      const after = counts((r) => r.v2_status === 'active');
      const cos = [...new Set([...before.keys(), ...after.keys()])].sort(
        (a, b) => (before.get(b) ?? 0) - (before.get(a) ?? 0) || a.localeCompare(b),
      );
      out.push(
        '### Active roles per company',
        '',
        table(
          ['Company', 'v1 active', 'v2 active'],
          cos
            .filter((c) => (before.get(c) ?? 0) >= 2 || (after.get(c) ?? 0) !== (before.get(c) ?? 0))
            .map((c) => [c, before.get(c) ?? 0, after.get(c) ?? 0]),
        ),
        '',
      );
    }
  }
  return `${out.join('\n')}\n`;
}

export function runBacktest(v1: V1Data, config: PolicyConfig = DEFAULT_CONFIG) {
  const roles = fromV1(v1);
  const { rubric, components } = v1Profile(v1, config);
  return [
    { label: `dream companies at +${config.scoring.affinity_cap} affinity (max nudge)`, dreamAffinity: 99 },
    { label: 'no affinity (neutral)', dreamAffinity: 0 },
  ].map(({ label, dreamAffinity }) => {
    const rows = replay(roles, { rubric, components, dreamAffinity });
    return { summary: summarize(label, rows), rows };
  });
}
