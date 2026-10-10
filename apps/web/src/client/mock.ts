import {
  ARCHIVE_REASONS,
  CRITERIA,
  type Criterion,
  type Decision,
  formatMoneyRange,
  groupAutoDecisions,
  nextFire,
  OPS,
  type OpName,
  type OpOutcome,
  OUTREACH_TONES,
  type QueuedDecision,
  ROLE_STATUSES,
  type Role,
  SCHEDULE_KEYS,
  SCHEDULE_SKILL,
  type Score,
} from '@perfect-placement/contracts';
import * as fx from '@perfect-placement/fixtures';
import { composeReply } from '../../genui/src/compose';
import { scriptedStream } from '../../genui/src/stream';
import type { In, OpClient, Out } from './types';

/*
 * Read-only fixtures preview (`vite --mode mock`, and unit tests of screens that only read).
 * It answers registry READ ops from the synthetic fixtures and refuses every write with
 * `unimplemented`: the mechanics (moves, decisions, runs, diffs) live in the engine only.
 * Run against `pp up` for anything interactive. Ask has no agent here: it answers a few intents from
 * fixture reads (genui/src/compose.ts), streamed at a model-like pace.
 */

type Outcome<N extends OpName> = OpOutcome<Out<N>>;
const ok = <T>(output: T): OpOutcome<T> => ({ status: 'ok', output, eventIds: [] });
const err = (code: Extract<OpOutcome<unknown>, { status: 'error' }>['code'], message: string): OpOutcome<never> => ({
  status: 'error',
  code,
  message,
});

export interface MockOptions {
  /** Clock. Defaults to the fixture "now" so relative times match the design. */
  now?: () => Date;
}

const stripFrontmatter = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n+/, '');
const section = (md: string, name: string) => md.match(new RegExp(`## ${name}\\s*\\n+([\\s\\S]*?)(?=\\n## |$)`))?.[1]?.trim() ?? '';

export function createMockClient(opts: MockOptions = {}): OpClient {
  const now = opts.now ?? (() => new Date(fx.FIXTURE_NOW));
  const files = new Map<string, string>(fx.vaultFiles());
  const read = (p: string | null | undefined) => (p && files.has(p) ? stripFrontmatter(files.get(p) as string) : null);
  const client: OpClient = {
    async *ask(req, signal) {
      yield { type: 'thread', thread_id: req.thread_id ?? 'mock', runner: 'mock' };
      const text = await composeReply(req.message, { client, now: now(), roleId: req.context?.role_id ?? null });
      for await (const delta of scriptedStream(text, { tokensPerSecond: 240, chunkTokens: 3, ...(signal ? { signal } : {}) }))
        yield { type: 'text', delta };
      yield { type: 'done' };
    },
    async run<N extends OpName>(name: N, input: In<N>): Promise<Outcome<N>> {
      const def = OPS[name];
      if (!def) return err('not_found', name) as Outcome<N>;
      const parsed = def.input.safeParse(input ?? {});
      if (!parsed.success) return { status: 'error', code: 'invalid_input', message: name, issues: parsed.error.issues } as Outcome<N>;
      if (!def.readOnly) return err('unimplemented', `${name}: mock is read-only`) as Outcome<N>;
      try {
        return readOp(name, parsed.data as Record<string, unknown>, now(), read) as Outcome<N>;
      } catch (e) {
        return err('not_found', e instanceof Error ? e.message : String(e)) as Outcome<N>;
      }
    },
  };
  return client;
}

/** #103: a roles.criterion group's total: the role's first score at or after the group's first decision. */
const mockTotal = (g: { kind: string; subject_id: string | null; first_ts: string }) => {
  if (g.kind !== 'roles.criterion' || !g.subject_id) return null;
  const s = fx.scores
    .filter((x) => x.role_id === g.subject_id && x.created_at >= g.first_ts)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  return s ? s.total : null;
};

/** #102: the engine's subject_role on role decisions (url, last check, freshness evidence). */
function withSubjectRole(d: Decision): QueuedDecision {
  if (d.subject_type !== 'role') return d;
  const r = fx.roles.find((x) => x.id === d.subject_id);
  if (!r) return d;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const own = d.kind === 'freshness.closed' ? str((d.question_json as { state?: { evidence?: unknown } }).state?.evidence) : null;
  const check = fx.events
    .filter((e) => e.type === 'freshness_checked' && e.subject_type === 'role' && e.subject_id === r.id)
    .sort((a, b) => b.ts.localeCompare(a.ts))[0];
  const last = check ? str((check.payload_json as { evidence?: unknown }).evidence) : null;
  return { ...d, subject_role: { id: r.id, url: r.url, last_checked_at: r.last_checked_at, freshness_evidence: own ?? last } };
}

const latestVersion = () => fx.profileVersions[fx.profileVersions.length - 1] as (typeof fx.profileVersions)[number];
const latestScore = (roleId: string): Score | null =>
  fx.scores.filter((x) => x.role_id === roleId).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
const companyOf = (role: Role) => {
  const c = fx.companies.find((x) => x.id === role.company_id);
  if (!c) throw new Error(`company ${role.company_id}`);
  return c;
};
const summary = (role: Role) => ({ role, company: companyOf(role), latest_score: latestScore(role.id) });
const must = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new Error(what);
  return v;
};
const peopleFor = (role: Role) => {
  const seen = new Set<string>();
  return fx.contactLinks.flatMap((link) => {
    if (link.role_id !== role.id && !(link.role_id === null && link.company_id === role.company_id)) return [];
    const contact = fx.contacts.find((c) => c.id === link.contact_id);
    if (!contact || seen.has(contact.id)) return [];
    seen.add(contact.id);
    return [{ contact, link }];
  });
};

function readOp(
  name: OpName,
  i: Record<string, unknown>,
  at: Date,
  read: (p: string | null | undefined) => string | null,
): OpOutcome<unknown> {
  const iso = at.toISOString();
  switch (name) {
    case 'profile.get': {
      const v = latestVersion();
      return ok({
        version: v,
        components: fx.profileComponents.filter((c) => c.version_id === v.id),
        pending_diffs: fx.profileDiffs.filter((d) => d.status === 'pending'),
      });
    }
    case 'profile.history':
      return ok({ versions: [...fx.profileVersions] });
    case 'onboard.state':
      return ok({ step: 'resume', components_filled: [], next_question: null });
    case 'onboard.samples':
      return ok({ items: calibrationSamples(), weights: { ...fx.RUBRIC.weights } });

    case 'roles.list': {
      const f = i as { status?: string[]; band?: string[]; freshness?: string[]; company_id?: string; workplace?: string[]; limit: number };
      const items = fx.roles
        .filter((r) => !f.status || f.status.includes(r.status))
        .filter((r) => !f.freshness || f.freshness.includes(r.freshness))
        .filter((r) => !f.company_id || r.company_id === f.company_id)
        .filter((r) => !f.workplace || f.workplace.includes(r.workplace))
        .map(summary)
        .filter((x) => !f.band || (x.latest_score && f.band.includes(x.latest_score.band)))
        .sort((a, b) => (b.latest_score?.total ?? -1) - (a.latest_score?.total ?? -1));
      return ok({ items: items.slice(0, f.limit), next_cursor: null });
    }
    case 'roles.get': {
      const role = must(
        fx.roles.find((r) => r.id === i.role_id),
        'role',
      );
      return ok({
        ...summary(role),
        application: fx.applications.find((a) => a.role_id === role.id) ?? null,
        contacts: peopleFor(role),
        md_body: read(role.md_path),
        connect: null,
      });
    }
    case 'companies.get': {
      const company = must(
        fx.companies.find((c) => c.id === i.company_id),
        'company',
      );
      return ok({ company, roles: fx.roles.filter((r) => r.company_id === company.id).map(summary), dossier_md: read(company.md_path) });
    }
    case 'pipeline.summary': {
      const counts = Object.fromEntries(ROLE_STATUSES.map((st) => [st, fx.roles.filter((r) => r.status === st).length]));
      const archived_by_reason: Record<string, number> = Object.fromEntries(ARCHIVE_REASONS.map((r) => [r, 0]));
      for (const r of fx.roles)
        if (r.status === 'archived' && r.archive_reason)
          archived_by_reason[r.archive_reason] = (archived_by_reason[r.archive_reason] ?? 0) + 1;
      const since = at.getTime() - 86_400_000;
      const recent = fx.decisions.filter((d) => Date.parse(d.ts) >= since);
      return ok({
        counts,
        archived_by_reason,
        needs_you: fx.decisions.filter((d) => d.status === 'pending' && d.policy_outcome === 'human').length,
        auto_share_24h: recent.length ? recent.filter((d) => d.policy_outcome !== 'human').length / recent.length : 1,
        closed_today: fx.roles.filter((r) => r.freshness === 'closed' && r.last_checked_at && Date.parse(r.last_checked_at) >= since)
          .length,
        drafts_ready: fx.roles.filter((r) => r.status === 'draft-ready').length,
        replies: fx.outreach.filter((o) => o.status === 'replied').length,
      });
    }

    case 'decisions.queue': {
      const since = (i.include_auto_since as string | undefined) ?? new Date(at.getTime() - 86_400_000).toISOString();
      const recent = fx.decisions
        .filter((d) => d.policy_outcome !== 'human' && d.ts >= since && d.ts <= iso)
        .sort((a, b) => b.ts.localeCompare(a.ts));
      return ok({
        pending: fx.decisions.filter((d) => d.status === 'pending' && d.policy_outcome === 'human').map(withSubjectRole),
        recent_auto: recent.map(withSubjectRole),
        // #103: the engine's groups (fixtures carry no run ids, so the time window applies).
        auto_groups: groupAutoDecisions(recent, at, { totalOf: mockTotal }),
      });
    }
    case 'runs.list': {
      const all = [...fx.runs].filter((r) => !i.op || r.op === i.op).sort((a, b) => b.started_at.localeCompare(a.started_at));
      const limit = (i.limit as number | undefined) ?? 50;
      return ok({ items: all.slice(0, limit), next_cursor: all.length > limit ? String(limit) : null });
    }
    case 'runs.get': {
      const run = must(
        fx.runs.find((r) => r.id === i.run_id),
        'run',
      );
      return ok({ run, log_md: read(run.log_path) });
    }

    case 'outreach.list':
      return ok({
        items: fx.outreach
          .filter((o) => o.role_id === i.role_id)
          .map((o) => ({
            ...o,
            recipient_name: fx.contacts.find((c) => c.id === o.contact_id)?.name ?? '',
            about_name: o.about_contact_id ? (fx.contacts.find((c) => c.id === o.about_contact_id)?.name ?? null) : null,
          })),
      });
    case 'outreach.get': {
      const outreach = must(
        fx.outreach.find((x) => x.id === i.outreach_id),
        'outreach',
      );
      const contact = must(
        fx.contacts.find((c) => c.id === outreach.contact_id),
        'contact',
      );
      const md = read(outreach.md_path) ?? '';
      const text = { hook: section(md, 'Hook'), proof: section(md, 'Proof'), ask: section(md, 'Ask') };
      const signoff = section(md, 'Sign-off') || 'Thanks,';
      const body = `Hi ${contact.name.split(/\s+/)[0]},\n\n${[text.hook, text.proof, text.ask].join('\n\n')}\n\n${signoff}\n`;
      // #37: To only when the address is known or confident (the engine also checks Needs you).
      const sure = !!contact.email && (contact.email_source === 'manual' || (contact.email_confidence ?? 1) >= 0.9);
      const to = {
        contact_id: contact.id,
        name: contact.name,
        email: sure ? contact.email : null,
        email_source: contact.email_source,
        email_confidence: contact.email_confidence,
        guess: contact.email,
        reason: sure ? null : contact.email ? 'unconfirmed guess' : 'no email found',
      };
      const about = outreach.about_contact_id ? (fx.contacts.find((c) => c.id === outreach.about_contact_id) ?? null) : null;
      return ok({ outreach, contact, subject: null, ...text, signoff, body, variants: OUTREACH_TONES.map(() => text), to, about });
    }
    case 'contacts.get': {
      const contact = must(
        fx.contacts.find((c) => c.id === i.contact_id),
        'contact',
      );
      return ok({ contact, links: fx.contactLinks.filter((l) => l.contact_id === contact.id) });
    }
    case 'vault.read':
      return ok({ markdown: read(i.path as string) });

    case 'system.backends':
      return ok({
        items: [
          { name: 'rule', mode: 'local', status: 'ok', latencyMs: 0 },
          { name: 'kev', mode: 'local', status: 'ok', latencyMs: 120 },
          { name: 'agent', mode: 'session', status: 'ok', latencyMs: null },
        ],
      });
    case 'config.get':
      return ok(fx.FIXTURE_CONFIG);
    case 'schedules.status':
      return ok({
        items: SCHEDULE_KEYS.map((key) => {
          const spec = fx.FIXTURE_CONFIG.schedules[key];
          const next = spec === 'off' ? null : nextFire(spec, at);
          const last = [...fx.runs]
            .filter((r) => (r.summary_json as { schedule?: string } | null)?.schedule === key)
            .sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
          return {
            key,
            skill: SCHEDULE_SKILL[key],
            spec,
            on: spec !== 'off',
            next_run: next ? next.toISOString() : null,
            last_run: last ?? null,
            job: 'unknown' as const,
          };
        }),
      });

    default:
      return err('unimplemented', `${name}: not in the mock`);
  }
}

function calibrationSamples() {
  return fx.roles
    .filter((r) => r.status !== 'inbox')
    .slice(0, 12)
    .map((r) => {
      const sc = latestScore(r.id);
      const name = fx.companies.find((c) => c.id === r.company_id)?.name ?? r.company_id;
      return {
        id: `cal_${r.id}`,
        company: name,
        letter: name.slice(0, 1),
        title: r.title,
        comp: formatMoneyRange(r.comp_min, r.comp_max) ?? 'Not listed',
        mode: r.workplace,
        criteria: Object.fromEntries(CRITERIA.map((c) => [c, sc ? sc[c] : 3])) as Record<Criterion, number>,
      };
    });
}
