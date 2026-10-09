import { z } from 'zod';

// ---------------------------------------------------------------------------
// Role status machine (blueprint.md "Flow")
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

/** Statuses the freshness check covers (blueprint.md "Freshness"). */
export const FRESHNESS_SCOPE = ['active', 'held', 'on-deck', 'draft-ready'] as const satisfies readonly RoleStatus[];

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
// Profile (blueprint.md "Profile: 11 components")
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
// People + outreach (blueprint.md "Connect")
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
 * - `jev`, `llm`: optional adapters kept in code, disabled by default.
 */
export const BACKENDS = ['rule', 'jev', 'kev', 'llm', 'agent', 'human'] as const;
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
 * Add new kinds via CONTRACT_CHANGES.md.
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

/** Skills a run can start (`runs.start`). */
export const SKILLS = ['onboard', 'scout', 'score', 'freshness', 'research', 'tailor', 'connect', 'fill', 'inbox', 'learn'] as const;
export const Skill = z.enum(SKILLS);
export type Skill = z.infer<typeof Skill>;
