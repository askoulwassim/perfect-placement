import {
  type Application,
  ARCHIVE_REASONS,
  type ArchiveReason,
  CRITERIA,
  type Criterion,
  type Decision,
  FRESHNESS_SCOPE,
  MANUAL_MOVES,
  OPS,
  type OpName,
  type OpOutcome,
  type Outreach,
  type PolicyConfig,
  type ProfileComponent,
  type ProfileComponentKey,
  type Role,
  type RoleStatus,
  type Run,
  type Score,
  vaultPath,
} from '@perfect-placement/contracts';
import * as fx from '@perfect-placement/fixtures';
import { bestPath, type Person } from '../lib/people';
import type { AnyOpName, CalibrationSample, In, OpClient, Out, ShimName, ShimOps } from './types';
import { isShim } from './types';

/*
 * Fixtures-backed mock of the ops the UI calls. In-memory, per client instance.
 * It validates inputs against the contract schemas so the UI cannot drift from the registry.
 * Mechanics here are deliberately thin stand-ins for lanes B, E, H, I; Wave 2 swaps in the
 * HTTP client and this file goes away from the runtime path.
 */

type Outcome<N extends AnyOpName> = OpOutcome<Out<N>>;
const ok = <T>(output: T): OpOutcome<T> => ({ status: 'ok', output, eventIds: [] });
const err = (code: Extract<OpOutcome<unknown>, { status: 'error' }>['code'], message: string): OpOutcome<never> => ({
  status: 'error',
  code,
  message,
});

interface OutreachBody {
  subject: string | null;
  hook: string;
  proof: string;
  ask: string;
}

const ONBOARD_QUESTIONS = [
  { id: 'q_work_mode', component: 'work_mode', label: 'Work mode', answer_type: 'chips', options: ['Remote', 'Hybrid', 'Onsite'] },
  { id: 'q_terms', component: 'terms', label: 'Comp floor', answer_type: 'slider', min: 100, max: 400 },
  {
    id: 'q_company',
    component: 'company',
    label: 'Company stage',
    answer_type: 'multi_chips',
    options: ['Seed', 'Series A', 'Series B', 'Series C', 'Public'],
  },
  {
    id: 'q_dealbreakers',
    component: 'dealbreakers',
    label: 'Hard nos',
    answer_type: 'multi_chips',
    options: ['Onsite only', 'Ad tech', 'Below floor', 'Crypto', 'Agency'],
  },
] as const satisfies ReadonlyArray<{
  id: string;
  component: ProfileComponentKey;
  label: string;
  answer_type: 'chips' | 'multi_chips' | 'slider' | 'text';
  options?: readonly string[];
  min?: number;
  max?: number;
}>;

function parseBlocks(md: string): OutreachBody {
  const section = (name: string) => md.match(new RegExp(`## ${name}\\s*\\n+([\\s\\S]*?)(?=\\n## |$)`))?.[1]?.trim() ?? '';
  return { subject: null, hook: section('Hook'), proof: section('Proof'), ask: section('Ask') };
}

const stripFrontmatter = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n+/, '');

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, v] of Object.entries(patch)) {
    const b = out[key];
    out[key] =
      v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)
        ? deepMerge(b as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out;
}

export interface MockOptions {
  /** Clock. Defaults to the fixture "now" so relative times match the design. */
  now?: () => Date;
  /** Artificial latency in ms (dev only). */
  latencyMs?: number;
}

export function createMockClient(opts: MockOptions = {}): OpClient & { state: MockState } {
  const now = opts.now ?? (() => new Date(fx.FIXTURE_NOW));
  const state = createState();
  return {
    state,
    async run<N extends AnyOpName>(name: N, input: In<N>): Promise<Outcome<N>> {
      if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
      if (isShim(name)) {
        try {
          return ok(runShim(state, name, input as ShimOps[typeof name]['input'])) as Outcome<N>;
        } catch (e) {
          return err('not_found', e instanceof Error ? e.message : String(e)) as Outcome<N>;
        }
      }
      const def = OPS[name as OpName];
      if (!def) return err('not_found', name) as Outcome<N>;
      const parsed = def.input.safeParse(input ?? {});
      if (!parsed.success) return { status: 'error', code: 'invalid_input', message: name, issues: parsed.error.issues } as Outcome<N>;
      if (def.unimplemented) return err('unimplemented', name) as Outcome<N>;
      try {
        return runOp(state, name as OpName, parsed.data as never, now) as Outcome<N>;
      } catch (e) {
        return err('internal', e instanceof Error ? e.message : String(e)) as Outcome<N>;
      }
    },
  };
}

export type MockState = ReturnType<typeof createState>;

function createState() {
  const clone = <T>(v: T): T => structuredClone(v);
  const files = new Map<string, string>(fx.vaultFiles());
  const outreachBodies = new Map<string, OutreachBody>();
  for (const o of fx.outreach) if (o.md_path) outreachBodies.set(o.id, parseBlocks(stripFrontmatter(files.get(o.md_path) ?? '')));
  return {
    profileVersions: clone(fx.profileVersions),
    profileComponents: clone(fx.profileComponents),
    profileDiffs: clone(fx.profileDiffs),
    companies: clone(fx.companies),
    roles: clone(fx.roles),
    scores: clone(fx.scores),
    applications: clone(fx.applications),
    contacts: clone(fx.contacts),
    contactLinks: clone(fx.contactLinks),
    outreach: clone(fx.outreach),
    decisions: clone(fx.decisions),
    runs: clone(fx.runs),
    config: clone(fx.FIXTURE_CONFIG) as PolicyConfig,
    files,
    outreachBodies,
    onboard: {
      step: 'resume' as 'resume' | 'interview' | 'calibrate' | 'confirm' | 'done',
      filled: [] as ProfileComponentKey[],
      q: 0,
      weights: { ...fx.RUBRIC.weights } as Record<Criterion, number>,
      calibrated: new Set<string>(),
    },
    seq: 100,
  };
}

// ------------------------------------------------------------------ helpers

const latestVersion = (s: MockState) => s.profileVersions[s.profileVersions.length - 1] as MockState['profileVersions'][number];
const latestScore = (s: MockState, roleId: string): Score | null =>
  s.scores.filter((x) => x.role_id === roleId).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
const companyOf = (s: MockState, role: Role) => {
  const c = s.companies.find((x) => x.id === role.company_id);
  if (!c) throw new Error(`company ${role.company_id}`);
  return c;
};
const summary = (s: MockState, role: Role) => ({ role, company: companyOf(s, role), latest_score: latestScore(s, role.id) });
const findRole = (s: MockState, id: string) => s.roles.find((r) => r.id === id);
const nextId = (s: MockState, prefix: string) => `${prefix}_m${++s.seq}`;
const peopleFor = (s: MockState, role: Role): Person[] => {
  const seen = new Set<string>();
  const out: Person[] = [];
  for (const link of s.contactLinks) {
    if (link.role_id !== role.id && !(link.role_id === null && link.company_id === role.company_id)) continue;
    const contact = s.contacts.find((c) => c.id === link.contact_id);
    if (!contact || seen.has(contact.id)) continue;
    seen.add(contact.id);
    out.push({ contact, link });
  }
  return out;
};

function ensureApplication(s: MockState, roleId: string): Application {
  let app = s.applications.find((a) => a.role_id === roleId);
  if (!app) {
    app = { id: nextId(s, 'ap'), role_id: roleId, stage: 'research', applied_at: null, portal_url: null, package_paths_json: {} };
    s.applications.push(app);
  }
  return app;
}

function setStatus(role: Role, to: RoleStatus, at: string, reason?: ArchiveReason) {
  role.status = to;
  role.archive_reason = to === 'archived' ? (reason ?? 'passed') : null;
  role.held_reason = to === 'held' ? 'company_cap' : null;
  role.updated_at = at;
}

function applyDiff(s: MockState, diffId: string, at: string) {
  const diff = s.profileDiffs.find((d) => d.id === diffId && d.status === 'pending');
  if (!diff) throw new Error(`diff ${diffId}`);
  const base = latestVersion(s);
  const version = { id: nextId(s, 'pv'), created_at: at, parent_id: base.id, reason: `${diff.component_key} diff`, event_id: null };
  const after = (diff.diff_json as { after?: Record<string, unknown> }).after ?? {};
  const comps: ProfileComponent[] = s.profileComponents
    .filter((c) => c.version_id === base.id)
    .map((c) => ({
      ...c,
      id: nextId(s, 'pc'),
      version_id: version.id,
      data_json: c.key === diff.component_key ? { ...c.data_json, ...after } : c.data_json,
      confidence: c.key === diff.component_key ? Math.min(1, c.confidence + 0.05) : c.confidence,
    }));
  s.profileVersions.push(version);
  s.profileComponents.push(...comps);
  diff.status = 'applied';
  diff.applied_version_id = version.id;
  // Resolving in one place clears both (handoff §4).
  const d = s.decisions.find((x) => x.id === diff.decision_id);
  if (d && d.status === 'pending') Object.assign(d, { status: 'applied', resolved_at: at });
  return version;
}

function rejectDiff(s: MockState, diffId: string, at: string) {
  const diff = s.profileDiffs.find((d) => d.id === diffId && d.status === 'pending');
  if (!diff) throw new Error(`diff ${diffId}`);
  diff.status = 'rejected';
  const d = s.decisions.find((x) => x.id === diff.decision_id);
  if (d && d.status === 'pending') Object.assign(d, { status: 'rejected', resolved_at: at });
}

/** Connect: ensure a vault draft exists for the best-path person. */
function draftOutreach(s: MockState, role: Role): Outreach | null {
  const target = bestPath(peopleFor(s, role))?.target;
  if (!target) return null;
  const existing = s.outreach.find((o) => o.contact_id === target.contact.id && o.role_id === role.id);
  if (existing) return existing;
  const o: Outreach = {
    id: nextId(s, 'or'),
    contact_id: target.contact.id,
    role_id: role.id,
    tier: target.link.tier,
    gmail_draft_id: null,
    status: 'drafted',
    md_path: vaultPath.outreach(target.contact.id, role.id),
  };
  s.outreach.push(o);
  const co = companyOf(s, role);
  s.outreachBodies.set(o.id, {
    subject: null,
    hook: `${co.name} is building the thing I have shipped twice.`,
    proof: 'I launched a self-serve analytics product 400 teams use.',
    ask: '20 minutes next week?',
  });
  return o;
}

/** Side effects of accepting or changing a queued decision, keyed by kind. */
function applyDecision(s: MockState, d: Decision, value: unknown, at: string) {
  const role = d.subject_type === 'role' ? findRole(s, d.subject_id) : undefined;
  switch (d.kind) {
    case 'freshness.closed':
      if (!role) break;
      role.last_checked_at = at;
      if (value === false) {
        role.freshness = 'closed';
        setStatus(role, 'archived', at, 'closed');
      } else role.freshness = 'open';
      break;
    case 'inbox.classify': {
      if (!role) break;
      const to: Partial<Record<string, RoleStatus>> = { confirmation: 'applied', interview_request: 'interviews', offer: 'offers' };
      if (value === 'rejection') setStatus(role, 'archived', at, 'rejected');
      else if (typeof value === 'string' && to[value]) setStatus(role, to[value] as RoleStatus, at);
      break;
    }
    case 'profile.apply_diff':
      if (value === true) applyDiff(s, d.subject_id, at);
      else rejectDiff(s, d.subject_id, at);
      break;
    case 'outreach.to_gmail': {
      const o = s.outreach.find((x) => x.id === d.subject_id);
      if (o && value === true) toGmail(s, o);
      break;
    }
    case 'roles.dedupe':
      if (role && value === true) setStatus(role, 'archived', at, 'passed');
      break;
    default:
      break;
  }
}

function toGmail(s: MockState, o: Outreach) {
  o.status = 'in_gmail';
  o.gmail_draft_id = o.gmail_draft_id ?? `mock-draft-${++s.seq}`;
  const app = s.applications.find((a) => a.role_id === o.role_id);
  if (app && (app.stage === 'research' || app.stage === 'tailor' || app.stage === 'connect')) app.stage = 'fill';
  // Clear a queued "ready for Gmail?" decision for the same draft.
  for (const d of s.decisions) if (d.kind === 'outreach.to_gmail' && d.subject_id === o.id && d.status === 'pending') d.status = 'applied';
}

// ---------------------------------------------------------------------- ops

function runOp(s: MockState, name: OpName, input: never, clock: () => Date): OpOutcome<unknown> {
  const at = clock().toISOString();
  const i = input as Record<string, unknown>;
  switch (name) {
    case 'profile.get': {
      const v = latestVersion(s);
      return ok({
        version: v,
        components: s.profileComponents.filter((c) => c.version_id === v.id),
        pending_diffs: s.profileDiffs.filter((d) => d.status === 'pending'),
      });
    }
    case 'profile.history':
      return ok({ versions: [...s.profileVersions] });
    case 'profile.apply_diff': {
      const version = applyDiff(s, i.diff_id as string, at);
      return ok({ version, rescored_role_ids: [] });
    }
    case 'profile.reject_diff':
      rejectDiff(s, i.diff_id as string, at);
      return ok({ ok: true });

    case 'onboard.ingest_resume':
      s.onboard.step = 'interview';
      s.onboard.filled = ['story', 'craft'];
      return ok(onboardState(s));
    case 'onboard.answer': {
      const q = ONBOARD_QUESTIONS[s.onboard.q];
      if (!q || q.id !== i.question_id) return err('conflict', 'question');
      if (!s.onboard.filled.includes(q.component)) s.onboard.filled.push(q.component);
      s.onboard.q += 1;
      if (s.onboard.q >= ONBOARD_QUESTIONS.length) s.onboard.step = 'calibrate';
      return ok(onboardState(s));
    }
    case 'onboard.calibrate': {
      const sample = calibrationSamples(s).find((x) => x.id === i.sample_id);
      if (!sample) return err('not_found', 'sample');
      const sign = i.choice === 'yes' ? 1 : i.choice === 'no' ? -1 : 0;
      for (const c of CRITERIA) s.onboard.weights[c] = Math.max(1, s.onboard.weights[c] + sign * (sample.criteria[c] - 3) * 0.6);
      s.onboard.calibrated.add(sample.id);
      for (const k of ['domain', 'team', 'growth'] as const) if (!s.onboard.filled.includes(k)) s.onboard.filled.push(k);
      const remaining = calibrationSamples(s).length - s.onboard.calibrated.size;
      if (remaining <= 0) s.onboard.step = 'confirm';
      return ok({ weights: { ...s.onboard.weights }, remaining });
    }
    case 'onboard.confirm': {
      const base = latestVersion(s);
      const version = { id: nextId(s, 'pv'), created_at: at, parent_id: base.id, reason: 'onboard', event_id: null };
      s.profileVersions.push(version);
      s.profileComponents.push(
        ...s.profileComponents.filter((c) => c.version_id === base.id).map((c) => ({ ...c, id: nextId(s, 'pc'), version_id: version.id })),
      );
      s.onboard.step = 'done';
      return ok({ version });
    }

    case 'roles.list': {
      const f = i as {
        status?: RoleStatus[];
        band?: string[];
        freshness?: string[];
        company_id?: string;
        workplace?: string[];
        limit: number;
      };
      const items = s.roles
        .filter((r) => !f.status || f.status.includes(r.status))
        .filter((r) => !f.freshness || f.freshness.includes(r.freshness))
        .filter((r) => !f.company_id || r.company_id === f.company_id)
        .filter((r) => !f.workplace || f.workplace.includes(r.workplace))
        .map((r) => summary(s, r))
        .filter((x) => !f.band || (x.latest_score && f.band.includes(x.latest_score.band)))
        .sort((a, b) => (b.latest_score?.total ?? -1) - (a.latest_score?.total ?? -1));
      return ok({ items: items.slice(0, f.limit), next_cursor: null });
    }
    case 'roles.get': {
      const role = findRole(s, i.role_id as string);
      if (!role) return err('not_found', 'role');
      const md = role.md_path ? s.files.get(role.md_path) : undefined;
      return ok({
        ...summary(s, role),
        application: s.applications.find((a) => a.role_id === role.id) ?? null,
        contacts: peopleFor(s, role),
        md_body: md ? stripFrontmatter(md) : null,
      });
    }
    case 'roles.move': {
      const role = findRole(s, i.role_id as string);
      if (!role) return err('not_found', 'role');
      const from = role.status;
      const to = i.to as RoleStatus;
      if (!MANUAL_MOVES.some(([a, b]) => a === from && b === to)) return err('forbidden_transition', `${from} -> ${to}`);
      setStatus(role, to, at);
      return ok({ role, from });
    }
    case 'roles.archive': {
      const role = findRole(s, i.role_id as string);
      if (!role) return err('not_found', 'role');
      setStatus(role, 'archived', at, i.reason as ArchiveReason);
      return ok({ role });
    }
    case 'roles.check_freshness': {
      const ids =
        (i.role_ids as string[] | undefined) ??
        s.roles.filter((r) => (FRESHNESS_SCOPE as readonly string[]).includes(r.status)).map((r) => r.id);
      const results = ids.flatMap((id) => {
        const role = findRole(s, id);
        if (!role) return [];
        role.last_checked_at = at;
        if (role.freshness !== 'closed') role.freshness = 'open';
        return [{ role_id: id, freshness: role.freshness, method: 'ats_api' as const, stale: false, decision_id: null }];
      });
      return ok({ results });
    }
    case 'pipeline.summary': {
      const counts = Object.fromEntries(
        (['inbox', 'active', 'held', 'on-deck', 'draft-ready', 'applied', 'interviews', 'offers', 'archived'] as const).map((st) => [
          st,
          s.roles.filter((r) => r.status === st).length,
        ]),
      );
      const archived_by_reason: Record<string, number> = Object.fromEntries(ARCHIVE_REASONS.map((r) => [r, 0]));
      for (const r of s.roles)
        if (r.status === 'archived' && r.archive_reason)
          archived_by_reason[r.archive_reason] = (archived_by_reason[r.archive_reason] ?? 0) + 1;
      const since = Date.parse(at) - 86_400_000;
      const recent = s.decisions.filter((d) => Date.parse(d.ts) >= since);
      const auto = recent.filter((d) => d.policy_outcome !== 'human').length;
      return ok({
        counts,
        archived_by_reason,
        needs_you: s.decisions.filter((d) => d.status === 'pending' && d.policy_outcome === 'human').length,
        auto_share_24h: recent.length ? auto / recent.length : 1,
        closed_today: s.roles.filter((r) => r.freshness === 'closed' && r.last_checked_at && Date.parse(r.last_checked_at) >= since).length,
        drafts_ready: s.roles.filter((r) => r.status === 'draft-ready').length,
        replies: s.outreach.filter((o) => o.status === 'replied').length,
      });
    }

    case 'apply.mark_submitted':
      return err('human_only', 'apply.mark_submitted');

    case 'people.find': {
      const role = findRole(s, i.role_id as string);
      if (!role) return err('not_found', 'role');
      return ok({ found: peopleFor(s, role), capped: false });
    }

    case 'outreach.to_gmail': {
      const o = s.outreach.find((x) => x.id === i.outreach_id);
      if (!o) return err('not_found', 'outreach');
      toGmail(s, o);
      return ok({ outreach: o, gmail_draft_id: o.gmail_draft_id as string });
    }

    case 'decisions.queue': {
      const since = (i.include_auto_since as string | undefined) ?? new Date(Date.parse(at) - 86_400_000).toISOString();
      return ok({
        pending: s.decisions.filter((d) => d.status === 'pending' && d.policy_outcome === 'human'),
        recent_auto: s.decisions.filter((d) => d.policy_outcome !== 'human' && d.ts >= since).sort((a, b) => b.ts.localeCompare(a.ts)),
      });
    }
    case 'decisions.resolve': {
      const d = s.decisions.find((x) => x.id === i.decision_id);
      if (d?.status !== 'pending') return err('not_found', 'decision');
      if (i.action === 'skip') return ok({ decision: d, op_status: 'skipped' });
      const pick = (d.answer_json as { value?: unknown }).value;
      const value = i.action === 'change' ? i.value : pick;
      // The app never submits: "ready" stays with the human (Open portal); "not yet" just clears it.
      if (d.kind === 'apply.submit' && value !== false) return err('human_only', 'apply.submit');
      applyDecision(s, d, value, at);
      Object.assign(d, {
        status: value === false && (d.kind === 'profile.apply_diff' || d.kind === 'apply.submit') ? 'rejected' : 'applied',
        human_choice: String(value),
        overridden: i.action === 'change' && value !== pick,
        resolved_at: at,
      });
      return ok({ decision: d, op_status: 'ok' });
    }
    case 'decisions.undo': {
      const d = s.decisions.find((x) => x.id === i.decision_id);
      if (d?.policy_outcome !== 'auto_undo' || d.status !== 'applied') return err('not_found', 'decision');
      if (d.undo_until && d.undo_until < at) return err('conflict', 'undo window');
      d.status = 'undone';
      const role = d.subject_type === 'role' ? findRole(s, d.subject_id) : undefined;
      if (role && d.kind === 'freshness.closed') {
        role.freshness = 'unsure';
        setStatus(role, 'active', at);
      }
      return ok({ decision: d });
    }

    case 'runs.list':
      return ok({ items: [...s.runs].sort((a, b) => b.started_at.localeCompare(a.started_at)), next_cursor: null });
    case 'runs.start': {
      const run: Run = {
        id: nextId(s, 'rn'),
        op: i.skill as string,
        started_at: at,
        finished_at: at,
        status: 'ok',
        summary_json: {},
        log_path: null,
      };
      s.runs.push(run);
      const role = i.role_id ? findRole(s, i.role_id as string) : undefined;
      if (i.role_id && !role) return err('not_found', 'role');
      runSkill(s, i.skill as string, role, at, run);
      return ok({ run });
    }

    case 'config.get':
      return ok(s.config);
    case 'config.update': {
      const merged = deepMerge(s.config as unknown as Record<string, unknown>, i.patch as Record<string, unknown>);
      s.config = merged as unknown as PolicyConfig;
      return ok(s.config);
    }

    default:
      return err('unimplemented', name);
  }
}

function runSkill(s: MockState, skill: string, role: Role | undefined, at: string, run: Run) {
  if (!role) {
    if (skill === 'freshness') runOp(s, 'roles.check_freshness', {} as never, () => new Date(at));
    return;
  }
  const app = ensureApplication(s, role.id);
  switch (skill) {
    case 'research': {
      const co = companyOf(s, role);
      if (!co.md_path) {
        co.md_path = vaultPath.dossier(co.slug);
        s.files.set(co.md_path, `# ${co.name}\n\nSynthetic dossier.`);
      }
      app.stage = 'tailor';
      break;
    }
    case 'tailor':
      if (role.status === 'active' || role.status === 'on-deck' || role.status === 'held') setStatus(role, 'draft-ready', at);
      app.stage = 'connect';
      for (const kind of ['resume', 'cover_letter', 'fit_map'] as const) {
        const p = vaultPath.application(role.id, kind);
        app.package_paths_json[kind] = p;
        if (!s.files.has(p)) s.files.set(p, `# ${kind}\n\nSynthetic ${kind}.`);
      }
      break;
    case 'connect': {
      const o = draftOutreach(s, role);
      run.summary_json = { outreach_id: o?.id ?? null };
      break;
    }
    case 'fill': {
      const p = vaultPath.application(role.id, 'answers');
      app.package_paths_json.answers = p;
      if (!s.files.has(p)) s.files.set(p, '# answers\n\nSynthetic answers.');
      app.portal_url = app.portal_url ?? role.url;
      app.stage = 'submit';
      break;
    }
    default:
      break;
  }
}

function onboardState(s: MockState) {
  const q = s.onboard.step === 'interview' ? ONBOARD_QUESTIONS[s.onboard.q] : undefined;
  return {
    step: s.onboard.step,
    components_filled: [...s.onboard.filled],
    next_question: q
      ? {
          id: q.id,
          component: q.component,
          label: q.label,
          answer_type: q.answer_type,
          ...('options' in q ? { options: [...q.options] } : {}),
          ...('min' in q ? { min: q.min, max: q.max } : {}),
        }
      : null,
  };
}

function calibrationSamples(s: MockState): CalibrationSample[] {
  return fx.roles
    .filter((r) => r.status !== 'inbox')
    .slice(0, 12)
    .map((r) => {
      const sc = latestScore(s, r.id);
      const co = s.companies.find((c) => c.id === r.company_id);
      return {
        id: `cal_${r.id}`,
        company: co?.name ?? r.company_id,
        title: r.title,
        criteria: Object.fromEntries(CRITERIA.map((c) => [c, sc ? sc[c] : 3])) as Record<Criterion, number>,
      };
    });
}

// -------------------------------------------------------------------- shims

function runShim<N extends ShimName>(s: MockState, name: N, input: ShimOps[N]['input']): ShimOps[N]['output'] {
  const i = input as Record<string, string>;
  switch (name) {
    case 'outreach.get': {
      const o = s.outreach.find((x) => x.id === i.outreach_id);
      const contact = o && s.contacts.find((c) => c.id === o.contact_id);
      if (!o || !contact) throw new Error('outreach');
      const body = s.outreachBodies.get(o.id) ?? { subject: null, hook: '', proof: '', ask: '' };
      return { outreach: o, contact, ...body } as ShimOps[N]['output'];
    }
    case 'outreach.list':
      return { items: s.outreach.filter((o) => o.role_id === i.role_id) } as ShimOps[N]['output'];
    case 'vault.read': {
      const md = s.files.get(i.path as string);
      return { markdown: md ? stripFrontmatter(md) : null } as ShimOps[N]['output'];
    }
    case 'onboard.samples':
      return { items: calibrationSamples(s) } as ShimOps[N]['output'];
    case 'system.backends':
      return {
        items: [
          { name: 'jev', mode: 'hosted', status: 'ok', latencyMs: 140 },
          { name: 'kev', mode: 'local', status: 'slow', latencyMs: 700 },
        ],
      } as ShimOps[N]['output'];
    case 'contacts.get': {
      const contact = s.contacts.find((c) => c.id === i.contact_id);
      if (!contact) throw new Error('contact');
      return { contact, links: s.contactLinks.filter((l) => l.contact_id === contact.id) } as ShimOps[N]['output'];
    }
    default:
      throw new Error(`shim ${name}`);
  }
}
