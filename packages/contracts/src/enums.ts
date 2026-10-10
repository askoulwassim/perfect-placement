import { z } from 'zod';

// ---------------------------------------------------------------------------
// Role status machine (docs/architecture.md "Flow")
// ---------------------------------------------------------------------------

/** Pipeline order. Index = funnel rank. */
export const ROLE_STATUSES = ['inbox', 'active', 'held', 'on-deck', 'draft-ready', 'applied', 'interviews', 'offers', 'archived'] as const;
export const RoleStatus = z.enum(ROLE_STATUSES);
export type RoleStatus = z.infer<typeof RoleStatus>;

/**
 * No-downgrade rule: an automated actor (agent | schedule) never moves a role
 * out of one of these statuses to an earlier one. Archiving is allowed only with
 * a reason from the inbox monitor (rejected) or a human.
 */
export const PROTECTED_STATUSES = ['draft-ready', 'applied', 'interviews', 'offers'] as const satisfies readonly RoleStatus[];

/** Statuses the freshness check covers (docs/architecture.md "Freshness"; inbox since #77). */
export const FRESHNESS_SCOPE = ['inbox', 'active', 'held', 'on-deck', 'draft-ready'] as const satisfies readonly RoleStatus[];

/**
 * Manual moves a human may make by dragging in River (design handoff §4).
 * Held is never a drop target (set by the company cap only).
 * draft-ready -> applied is never manual: applied comes from the confirmation email
 * or `apply.mark_submitted`.
 */
export const MANUAL_MOVES: ReadonlyArray<readonly [RoleStatus, RoleStatus]> = [
  ['inbox', 'active'],
  ['active', 'inbox'],
  ['active', 'on-deck'],
  ['on-deck', 'active'],
  ['on-deck', 'draft-ready'],
  ['draft-ready', 'on-deck'],
  ['applied', 'interviews'],
  ['interviews', 'applied'],
  ['interviews', 'offers'],
  ['offers', 'interviews'],
];

export const ARCHIVE_REASONS = [
  'below_threshold',
  'dealbreaker',
  'closed',
  'rejected',
  'passed',
  'withdrawn',
  /** Accepting a `roles.dedupe` decision archives the newer copy (Wave 2; not a skip signal for Learn). */
  'duplicate',
] as const;
export const ArchiveReason = z.enum(ARCHIVE_REASONS);
export type ArchiveReason = z.infer<typeof ArchiveReason>;

/**
 * Statuses an automated rescore may move a role out of (Wave 2, lane F request).
 * `on-deck` is a human pick: protected from automated rescoring (wave1-decisions #13).
 */
export const RESCORE_MOVABLE = ['inbox', 'active', 'held'] as const satisfies readonly RoleStatus[];

/** Archive reasons a rescore may revive (a better score can bring the role back). */
export const RESCORE_REVIVABLE_ARCHIVE = ['below_threshold', 'dealbreaker'] as const satisfies readonly ArchiveReason[];

/** Known keys of `role.flags_json` (free-form, these are conventions). */
export const ROLE_FLAG_KEYS = ['closed', 'dream_company', 'dealbreaker'] as const;

export const HELD_REASONS = ['company_cap'] as const;
export const HeldReason = z.enum(HELD_REASONS);
export type HeldReason = z.infer<typeof HeldReason>;

export const FRESHNESS_STATES = ['open', 'closed', 'unsure', 'unknown'] as const;
export const Freshness = z.enum(FRESHNESS_STATES);
export type Freshness = z.infer<typeof Freshness>;

export const WORKPLACES = ['remote', 'hybrid', 'onsite', 'flexible', 'unspecified'] as const;
export const Workplace = z.enum(WORKPLACES);
export type Workplace = z.infer<typeof Workplace>;

export const ROLE_SOURCES = ['scout', 'link', 'watchlist', 'referral', 'manual'] as const;
export const RoleSource = z.enum(ROLE_SOURCES);
export type RoleSource = z.infer<typeof RoleSource>;

export const ATS_TYPES = ['greenhouse', 'lever', 'ashby', 'workday', 'other', 'unknown'] as const;
export const AtsType = z.enum(ATS_TYPES);
export type AtsType = z.infer<typeof AtsType>;

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export const CRITERIA = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'] as const;
export const Criterion = z.enum(CRITERIA);
export type Criterion = z.infer<typeof Criterion>;

export const CRITERION_LABELS: Record<Criterion, string> = {
  c1: 'Decisions',
  c2: '0-to-1',
  c3: 'External',
  c4: 'Data',
  c5: 'Domain',
  c6: 'Comp',
  c7: 'Team',
  c8: 'Growth',
  c9: 'Shape',
};

/** Criteria scored blind (company name and brand terms masked). */
export const BLIND_CRITERIA = ['c1', 'c2', 'c3', 'c4', 'c9'] as const satisfies readonly Criterion[];

export const BANDS = ['green', 'yellow', 'red'] as const;
export const Band = z.enum(BANDS);
export type Band = z.infer<typeof Band>;

/** What a score row decided for the role. */
export const SCORE_DECISIONS = ['active', 'held', 'archived'] as const;
export const ScoreDecision = z.enum(SCORE_DECISIONS);
export type ScoreDecision = z.infer<typeof ScoreDecision>;

// ---------------------------------------------------------------------------
// Profile (docs/architecture.md "Profile: 11 components")
// ---------------------------------------------------------------------------

export const PROFILE_COMPONENT_KEYS = [
  'story',
  'craft',
  'domain',
  'work_mode',
  'terms',
  'company',
  'team',
  'growth',
  'dealbreakers',
  'voice',
  'network',
] as const;
export const ProfileComponentKey = z.enum(PROFILE_COMPONENT_KEYS);
export type ProfileComponentKey = z.infer<typeof ProfileComponentKey>;

export const COMPONENT_KINDS = ['filter', 'weighted', 'asset'] as const;
export const ComponentKind = z.enum(COMPONENT_KINDS);
export type ComponentKind = z.infer<typeof ComponentKind>;

export const PROFILE_COMPONENT_KIND: Record<ProfileComponentKey, ComponentKind> = {
  story: 'asset',
  craft: 'weighted',
  domain: 'weighted',
  work_mode: 'filter',
  terms: 'filter',
  company: 'weighted',
  team: 'weighted',
  growth: 'weighted',
  dealbreakers: 'filter',
  voice: 'asset',
  network: 'asset',
};

/**
 * Which component owns each rubric criterion's weight (Wave 2; lanes E + F, amended).
 * The owner stores `data_json.criterion_weights: { cN: points }` (points of 100).
 * C2 is scored blind, so it is role-intrinsic and sits with Craft.
 * A weighted component's `weight` column = sum of its owned weights / 100; Terms (filter) keeps
 * `weight` null but carries `criterion_weights.c6`.
 */
export const CRITERION_OWNER: Record<Criterion, ProfileComponentKey> = {
  c1: 'team',
  c2: 'craft',
  c3: 'craft',
  c4: 'domain',
  c5: 'domain',
  c6: 'terms',
  c7: 'team',
  c8: 'growth',
  c9: 'craft',
};

/** Criteria a component owns, in C1..C9 order. */
export function criteriaOwnedBy(key: ProfileComponentKey): Criterion[] {
  return CRITERIA.filter((c) => CRITERION_OWNER[c] === key);
}

/**
 * Impact of a profile diff by component kind (wave1-decisions #14): filters high (never auto),
 * weighted and asset medium (auto + 24h undo when confident).
 */
export const COMPONENT_DIFF_IMPACT: Record<ComponentKind, Impact> = { filter: 'high', weighted: 'medium', asset: 'medium' };

/** Default affinity for a dream company (wave1-decisions #10). Still capped by `config.scoring.affinity_cap`; never bypasses a dealbreaker. */
export const DREAM_AFFINITY = 3;

export const PROFILE_DIFF_STATUSES = ['pending', 'applied', 'rejected', 'undone'] as const;
export const ProfileDiffStatus = z.enum(PROFILE_DIFF_STATUSES);
export type ProfileDiffStatus = z.infer<typeof ProfileDiffStatus>;

// ---------------------------------------------------------------------------
// People + outreach (docs/architecture.md "Connect")
// ---------------------------------------------------------------------------

export const CONTACT_DEGREES = ['1', '2', 'cold'] as const;
export const ContactDegree = z.enum(CONTACT_DEGREES);
export type ContactDegree = z.infer<typeof ContactDegree>;

/** Five avatar tiers from the design (ContactAvatar). */
export const CONTACT_TIERS = ['warm_hiring', 'warm_other', 'bridge', 'cold_hiring', 'cold_other'] as const;
export const ContactTier = z.enum(CONTACT_TIERS);
export type ContactTier = z.infer<typeof ContactTier>;

/** Resolver choice options for people.classify. */
export const CONTACT_ROLES = ['hiring_manager', 'hiring_team', 'recruiter', 'peer', 'unrelated', 'other'] as const;
export const ContactRole = z.enum(CONTACT_ROLES);
export type ContactRole = z.infer<typeof ContactRole>;

export const CONTACT_SOURCES = ['linkedin', 'gmail', 'jd', 'company_site', 'manual'] as const;
export const ContactSource = z.enum(CONTACT_SOURCES);
export type ContactSource = z.infer<typeof ContactSource>;

/**
 * Added (#37): where a contact's email came from. Known: `gmail` (a thread or signature), `linkedin`
 * (1st-degree contact info), `public` (JD, team page, talk, GitHub, personal site), `manual` (the user).
 * Estimated: `pattern` (the company's address format), `provider` (a finder service; pinned, no adapter yet).
 */
export const EMAIL_SOURCES = ['gmail', 'linkedin', 'public', 'pattern', 'provider', 'manual'] as const;
export const EmailSource = z.enum(EMAIL_SOURCES);
export type EmailSource = z.infer<typeof EmailSource>;

/**
 * Added (#99): the passive domain check on a candidate address (DNS only, never a mail server). `ok` (MX,
 * or an A record as the implicit MX), `no_mx` (no mail records: the candidate is dropped), `invalid` (the
 * address fails the syntax check: dropped), `unknown` (the DNS lookup failed or was off: kept).
 */
export const EMAIL_DOMAIN_CHECKS = ['ok', 'no_mx', 'invalid', 'unknown'] as const;
export const EmailDomainCheck = z.enum(EMAIL_DOMAIN_CHECKS);
export type EmailDomainCheck = z.infer<typeof EmailDomainCheck>;

/** Added (#99): list-based risk of an address (vendored AfterShip/email-verifier lists): a label only. */
export const EMAIL_RISKS = ['disposable', 'role', 'free', 'none'] as const;
export const EmailRisk = z.enum(EMAIL_RISKS);
export type EmailRisk = z.infer<typeof EmailRisk>;

/**
 * Added (#99): pattern evidence the connect skill gathers, read-only. `inbox_peer`: a real address at the
 * company domain in the user's own mail (from / to / cc; address only); `public_mention`: an address seen
 * on a public page.
 */
export const EMAIL_EVIDENCE_KINDS = ['inbox_peer', 'public_mention'] as const;
export const EmailEvidenceKind = z.enum(EMAIL_EVIDENCE_KINDS);
export type EmailEvidenceKind = z.infer<typeof EmailEvidenceKind>;

/** Added (#99): the user's own manual check of a candidate (Needs you **Valid** / **Invalid**). */
export const EMAIL_CHECK_RESULTS = ['valid', 'invalid'] as const;
export const EmailCheckResult = z.enum(EMAIL_CHECK_RESULTS);
export type EmailCheckResult = z.infer<typeof EmailCheckResult>;

/**
 * Added (#78): the no-contact fallback Connect used for a role, in the order it tries them: a hiring-team
 * or recruiting address (`team_inbox`), a cold note to the likely hiring leader (`cold_leader`), else
 * Connect is skipped (`skipped`) and the application moves to Fill.
 */
export const CONNECT_FALLBACKS = ['team_inbox', 'cold_leader', 'skipped'] as const;
export const ConnectFallback = z.enum(CONNECT_FALLBACKS);
export type ConnectFallback = z.infer<typeof ConnectFallback>;

/**
 * Added (#98): how to reach a 2nd-degree hiring-team target: a `direct` note to them, or a `bridge`
 * intro through the 1st-degree mutual. Code ranks the two (engine people/path.ts); the user can switch.
 */
export const CONNECT_PATHS = ['direct', 'bridge'] as const;
export const ConnectPath = z.enum(CONNECT_PATHS);
export type ConnectPath = z.infer<typeof ConnectPath>;

export const OUTREACH_STATUSES = ['drafted', 'in_gmail', 'replied', 'ignored'] as const;
export const OutreachStatus = z.enum(OUTREACH_STATUSES);
export type OutreachStatus = z.infer<typeof OutreachStatus>;

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

export const INBOX_CLASSES = ['confirmation', 'interview_request', 'offer', 'rejection', 'outreach_reply', 'other'] as const;
export const InboxClass = z.enum(INBOX_CLASSES);
export type InboxClass = z.infer<typeof InboxClass>;

// ---------------------------------------------------------------------------
// Decisions + actors
// ---------------------------------------------------------------------------

export const IMPACTS = ['low', 'medium', 'high'] as const;
export const Impact = z.enum(IMPACTS);
export type Impact = z.infer<typeof Impact>;

export const ACTORS = ['agent', 'human', 'schedule'] as const;
export const Actor = z.enum(ACTORS);
export type Actor = z.infer<typeof Actor>;

/**
 * Decision backends (wave1-decisions #7, #9). Order of use: rule -> kev -> agent -> human.
 * - `kev`: local System One model (default).
 * - `agent`: the calling Claude Code / Codex / Cursor session, answering over MCP.
 * - `llm`: optional direct API adapter, disabled by default.
 */
export const BACKENDS = ['rule', 'kev', 'llm', 'agent', 'human'] as const;
export const Backend = z.enum(BACKENDS);
export type Backend = z.infer<typeof Backend>;

export const POLICY_OUTCOMES = ['auto', 'auto_second', 'auto_undo', 'human'] as const;
export const PolicyOutcome = z.enum(POLICY_OUTCOMES);
export type PolicyOutcome = z.infer<typeof PolicyOutcome>;

export const DECISION_STATUSES = ['pending', 'applied', 'rejected', 'undone', 'expired'] as const;
export const DecisionStatus = z.enum(DECISION_STATUSES);
export type DecisionStatus = z.infer<typeof DecisionStatus>;

/**
 * Decision kinds. `config.json` `overrides` is keyed by these.
 * Add new kinds in a contract-change pull request.
 */
export const DECISION_KINDS = [
  'freshness.closed',
  'inbox.classify',
  'roles.dedupe',
  'roles.criterion',
  'roles.move',
  'roles.archive',
  'profile.learn',
  'profile.apply_diff',
  'people.classify',
  'outreach.to_gmail',
  'apply.submit',
  /** Added (#54): an unsupported claim in a tailored document or a fill answer: keep, remove or edit. */
  'apply.fact_check',
  /** Added (#37): which address to use for a contact (a pattern guess below the policy threshold). */
  'people.email',
  'other',
] as const;
export const DecisionKind = z.enum(DECISION_KINDS);
export type DecisionKind = z.infer<typeof DecisionKind>;

/** `queued`: waiting for its turn (run queue, #30); nothing launches it yet. `running`: launched. The rest are final. */
export const RUN_STATUSES = ['queued', 'running', 'ok', 'partial', 'error'] as const;
/** Statuses a run can still leave (shown as in progress). */
export const RUN_ACTIVE_STATUSES = ['queued', 'running'] as const satisfies readonly (typeof RUN_STATUSES)[number][];
export const RunStatus = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatus>;

/**
 * Added (#122): why a run failed, as a code the engine can act on (`runs.finish { error_code }`, kept as
 * `summary_json.error_code`). `connector_unavailable`: a connector tool the skill is granted (claude.ai Gmail,
 * Claude in Chrome) is not loaded in this session; the engine re-queues the run once after a short delay.
 * Added (#121): `stalled`: the run passed its skill's wall-clock cap (`STALL_LIMIT_MS`, engine); the engine killed
 * the runner and finished it. A scheduled run that ends with a transient code is retried with backoff.
 */
export const RUN_ERROR_CODES = ['connector_unavailable', 'stalled'] as const;
export const RunErrorCode = z.enum(RUN_ERROR_CODES);
export type RunErrorCode = z.infer<typeof RunErrorCode>;

export const SUBJECT_TYPES = [
  'role',
  'company',
  'contact',
  'outreach',
  'application',
  'interview',
  'profile',
  'profile_diff',
  'decision',
  'run',
  'system',
] as const;
export const SubjectType = z.enum(SUBJECT_TYPES);
export type SubjectType = z.infer<typeof SubjectType>;

/** Skills a run can start (`runs.start`). `voice` (#76): learn the Voice component from the user's own writing. */
export const SKILLS = [
  'onboard',
  'scout',
  'score',
  'freshness',
  'research',
  'tailor',
  'connect',
  'fill',
  'inbox',
  'learn',
  'voice',
] as const;
export const Skill = z.enum(SKILLS);
export type Skill = z.infer<typeof Skill>;
