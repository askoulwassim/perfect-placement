import { z } from 'zod';
import {
  Actor,
  ArchiveReason,
  AtsType,
  Backend,
  Band,
  ComponentKind,
  ConnectPath,
  ContactDegree,
  ContactSource,
  ContactTier,
  CRITERIA,
  DecisionKind,
  DecisionStatus,
  EmailSource,
  Freshness,
  HeldReason,
  Impact,
  OutreachStatus,
  PolicyOutcome,
  ProfileComponentKey,
  ProfileDiffStatus,
  RoleSource,
  RoleStatus,
  RunStatus,
  ScoreDecision,
  SubjectType,
  Workplace,
} from './enums.js';
import { EventType } from './events.js';
import { RUNNER_COMMANDS } from './policy.js';
import { CriterionScore, Id, IsoTimestamp, Probability, Slug, VaultPath } from './primitives.js';

/*
 * Row schemas. One per table in migrations 001 + 002 + 003.
 * Rules:
 * - Keys equal column names exactly (tested against PRAGMA table_info).
 * - Columns ending in `_json` hold JSON TEXT in SQLite; here they are the parsed value.
 * - Boolean columns are INTEGER 0/1 in SQLite; here they are booleans.
 * - Timestamps are ISO 8601 UTC TEXT.
 * - `md_path` is vault-relative; the markdown's frontmatter carries the same `id`.
 */

const Json = z.record(z.string(), z.unknown());

export const ProfileVersion = z.object({
  id: Id,
  created_at: IsoTimestamp,
  parent_id: Id.nullable(),
  reason: z.string(),
  event_id: Id.nullable(),
});
export type ProfileVersion = z.infer<typeof ProfileVersion>;

export const ProfileComponent = z.object({
  id: Id,
  version_id: Id,
  key: ProfileComponentKey,
  kind: ComponentKind,
  confidence: Probability,
  /** Rubric weight contribution for weighted components; null for filters and assets. */
  weight: z.number().nullable(),
  data_json: Json,
  md_path: VaultPath.nullable(),
});
export type ProfileComponent = z.infer<typeof ProfileComponent>;

/** Added in Wave 0 (not in the sketch): pending profile diffs for the Learn loop and the You screen. */
export const ProfileDiff = z.object({
  id: Id,
  created_at: IsoTimestamp,
  component_key: ProfileComponentKey,
  base_version_id: Id,
  /** `{ before: {...}, after: {...} }` over the component's data_json. */
  diff_json: Json,
  evidence_json: z.array(z.string()),
  impact: Impact,
  status: ProfileDiffStatus,
  decision_id: Id.nullable(),
  /** The event that caused the diff; the proposal event when there is no cause. Applied versions copy it to `profile_version.event_id`. */
  event_id: Id.nullable(),
  applied_version_id: Id.nullable(),
});
export type ProfileDiff = z.infer<typeof ProfileDiff>;

export const Company = z.object({
  id: Id,
  slug: Slug,
  name: z.string(),
  domain: z.string().nullable(),
  ats_type: AtsType,
  ats_board: z.string().nullable(),
  /** -5..+5 affinity modifier (decisions.md #5). */
  affinity: z.number().int().min(-5).max(5),
  md_path: VaultPath.nullable(),
});
export type Company = z.infer<typeof Company>;

export const Role = z.object({
  id: Id,
  company_id: Id,
  title: z.string(),
  url: z.string().url().nullable(),
  ats_job_id: z.string().nullable(),
  source: RoleSource,
  found_at: IsoTimestamp,
  posted_at: IsoTimestamp.nullable(),
  workplace: Workplace,
  remote_ok: z.boolean().nullable(),
  location: z.string().nullable(),
  comp_min: z.number().int().nullable(),
  comp_max: z.number().int().nullable(),
  comp_currency: z.string().length(3).nullable(),
  facing: z.enum(['internal', 'external', 'mixed']).nullable(),
  seniority: z.string().nullable(),
  status: RoleStatus,
  archive_reason: ArchiveReason.nullable(),
  held_reason: HeldReason.nullable(),
  last_checked_at: IsoTimestamp.nullable(),
  freshness: Freshness,
  /** Free-form flags. Known keys: ROLE_FLAG_KEYS (e.g. `dealbreaker`). */
  flags_json: Json,
  md_path: VaultPath.nullable(),
  created_at: IsoTimestamp,
  updated_at: IsoTimestamp,
});
export type Role = z.infer<typeof Role>;

export const SCORE_SCALES = ['v1', 'zero_based'] as const;
export const ScoreScale = z.enum(SCORE_SCALES);
export type ScoreScale = z.infer<typeof ScoreScale>;

/**
 * What the scorer writes to `score.rubric_json` (Wave 2, lane F request).
 * - `scale: 'v1'` (default, wave1-decisions #11): total = round(sum(c_i * w_i) / 5), range 20..100;
 *   bands 75 / 55 were calibrated on it.
 * - `scale: 'zero_based'`: total = round(sum(w_i * (c_i - 1) / 4)), range 0..100. Not comparable with v1.
 * Then total = clamp(base + affinity_mod, 0, 100). Weights are c1..c9, summing to 100.
 * Loose: the scorer may add `formula`, `blind`, etc.
 */
export const RubricSnapshot = z.looseObject({
  version: z.string(),
  scale: ScoreScale.default('v1'),
  weights: z
    .record(z.enum(CRITERIA), z.number().min(0).max(100))
    .refine((w) => Math.abs(Object.values(w).reduce((s, v) => s + v, 0) - 100) < 0.05, 'weights must sum to 100'),
  bands: z.object({ green_min: z.number(), yellow_min: z.number() }),
  affinity_cap: z.number().int().min(0),
  company_active_cap: z.number().int().min(1),
  profile_version_id: Id.nullable(),
  weights_source: z.enum(['profile', 'default']),
});
export type RubricSnapshot = z.infer<typeof RubricSnapshot>;

/** Append-only. A rescore adds a row. */
export const Score = z.object({
  id: Id,
  role_id: Id,
  /** Null when no profile version existed at scoring time (weights_source `default`). */
  profile_version_id: Id.nullable(),
  /** Snapshot of the rubric used. Rows match RubricSnapshot. */
  rubric_json: Json,
  c1: CriterionScore,
  c2: CriterionScore,
  c3: CriterionScore,
  c4: CriterionScore,
  c5: CriterionScore,
  c6: CriterionScore,
  c7: CriterionScore,
  c8: CriterionScore,
  c9: CriterionScore,
  /** Company affinity modifier, capped at config.scoring.affinity_cap. */
  affinity_mod: z.number(),
  total: z.number().min(0).max(100),
  band: Band,
  decision: ScoreDecision,
  /** Extracted facts the scorer used (workplace, comp, dealbreaker hits). */
  facts_json: Json,
  created_at: IsoTimestamp,
});
export type Score = z.infer<typeof Score>;

export const EventRow = z.object({
  id: Id,
  ts: IsoTimestamp,
  type: EventType,
  subject_type: SubjectType,
  subject_id: z.string(),
  payload_json: Json,
  actor: Actor,
  decision_id: Id.nullable(),
});
export type EventRow = z.infer<typeof EventRow>;

/** Added (#106): what a fill assist did in the portal, as the fill run reported it (`apply.fill_done`). */
export const FillAssist = z.object({
  at: IsoTimestamp,
  run_id: Id.nullable(),
  /** Labels of the fields it filled. */
  filled: z.array(z.string()),
  /** Documents it uploaded. */
  uploaded: z.array(z.enum(['resume', 'cover_letter'])),
  /** Fields it left for the human, each with a one-line reason. */
  skipped: z.array(z.object({ label: z.string(), reason: z.string() })),
});
export type FillAssist = z.infer<typeof FillAssist>;

export const Application = z.object({
  id: Id,
  role_id: Id,
  stage: z.enum(['research', 'tailor', 'connect', 'fill', 'submit', 'done']),
  applied_at: IsoTimestamp.nullable(),
  portal_url: z.string().url().nullable(),
  /**
   * `{ dossier?, resume?, cover_letter?, fit_map?, answers? }` vault paths. #106 adds the rendered files
   * (`resume_pdf`, `resume_docx`, `cover_letter_pdf`, `cover_letter_docx`, under `files/<role_id>/`).
   */
  package_paths_json: z.record(z.string(), VaultPath),
  /**
   * Added (#106, migration 011): the last fill assist (`apply.fill_done`): the portal was opened, the documents
   * uploaded and the answers filled, stopped before Submit. Null until then. The human submits.
   */
  fill_assist_json: FillAssist.nullable().default(null),
});
export type Application = z.infer<typeof Application>;

/** Never more than name, headline, URL, relationship (lane H "Never"). */
export const Contact = z.object({
  id: Id,
  name: z.string(),
  headline: z.string().nullable(),
  linkedin_url: z.string().url().nullable(),
  email: z.string().email().nullable(),
  source: ContactSource,
  notes: z.string().nullable(),
  /** Added (#37): where `email` came from; null when there is no email. */
  email_source: EmailSource.nullable(),
  /** Added (#37): 0..1, how sure the address is right (1 = confirmed by the user or seen in mail). */
  email_confidence: z.number().min(0).max(1).nullable(),
});
export type Contact = z.infer<typeof Contact>;

/**
 * Added (#98): the tie between the user's 1st-degree mutual and a 2nd-degree target (judgment from the
 * connect skill's read). `same_company`: the mutual works where the target works; `same_industry`: same
 * industry; `history`: the mutual and the target have worked or talked together.
 */
export const BridgeTie = z.object({
  same_company: z.boolean().default(false),
  same_industry: z.boolean().default(false),
  history: z.boolean().default(false),
});
export type BridgeTie = z.infer<typeof BridgeTie>;

export const ContactLink = z.object({
  id: Id,
  contact_id: Id,
  company_id: Id.nullable(),
  role_id: Id.nullable(),
  degree: ContactDegree,
  tier: ContactTier,
  via_contact_id: Id.nullable(),
  is_hiring_team: z.boolean(),
  /** Added (#98): the path the user picked for a 2nd-degree hiring target; null = the ranked default. */
  path: ConnectPath.nullable().default(null),
  /** Added (#98): the mutual's tie to the target (degree 2 with a via only). */
  via_tie_json: BridgeTie.nullable().default(null),
});
export type ContactLink = z.infer<typeof ContactLink>;

/**
 * One outreach draft, filed under the person it is addressed to (`contact_id`, the recipient). #98: a role
 * can have several, one per recipient; a bridge intro is filed under the mutual with `about_contact_id`
 * naming the target it is about (null for a note to the target itself).
 */
export const Outreach = z.object({
  id: Id,
  contact_id: Id,
  role_id: Id,
  tier: ContactTier,
  gmail_draft_id: z.string().nullable(),
  status: OutreachStatus,
  md_path: VaultPath.nullable(),
  /** Added (#98): the target a bridge intro is about; null when the note is to the recipient's own role. */
  about_contact_id: Id.nullable().default(null),
  /** Added (#99): the To the Gmail draft was created or updated with; null = no To (or not in Gmail yet). */
  gmail_to: z.string().nullable().default(null),
});
export type Outreach = z.infer<typeof Outreach>;

export const Interview = z.object({
  id: Id,
  role_id: Id,
  round: z.number().int().min(1),
  at: IsoTimestamp.nullable(),
  prep_path: VaultPath.nullable(),
  retro_path: VaultPath.nullable(),
  outcome: z.enum(['pending', 'advanced', 'rejected', 'offer', 'withdrawn']).nullable(),
});
export type Interview = z.infer<typeof Interview>;

const OpCall = z.object({ op: z.string(), input: z.unknown() });

/**
 * What a decision runs when applied (Wave 2, lane I request): `decision.action_json`.
 * - `input` may contain the string `"$value"` anywhere; it is replaced by the final value
 *   (the model's pick, or the human's change).
 * - `when`: run only if the final value equals it (e.g. archive only when "open?" is false). Absent = always.
 * - `undo`: the inverse op `decisions.undo` runs for an auto + undo decision.
 */
export const DecisionAction = z.object({
  op: z.string(),
  input: z.unknown(),
  when: z.union([z.string(), z.boolean(), z.number()]).optional(),
  undo: OpCall.optional(),
});
export type DecisionAction = z.infer<typeof DecisionAction>;

/** One row per resolver question. The Needs-you queue = status 'pending' and policy_outcome 'human'. */
export const Decision = z.object({
  id: Id,
  ts: IsoTimestamp,
  kind: DecisionKind,
  subject_type: SubjectType,
  subject_id: z.string(),
  /** The Question (see resolver.ts) plus the state sent. */
  question_json: Json,
  backend: Backend,
  /** The Answer `{ id, value, p }` plus alternatives when the backend gives them. */
  answer_json: Json,
  p: Probability,
  impact: Impact,
  policy_outcome: PolicyOutcome,
  status: DecisionStatus,
  human_choice: z.string().nullable(),
  overridden: z.boolean(),
  undo_until: IsoTimestamp.nullable(),
  resolved_at: IsoTimestamp.nullable(),
  latency_ms: z.number().int().nonnegative(),
  /** The op to run when this decision is applied. */
  action_json: DecisionAction.nullable(),
});
export type Decision = z.infer<typeof Decision>;

export const Run = z.object({
  id: Id,
  op: z.string(),
  started_at: IsoTimestamp,
  finished_at: IsoTimestamp.nullable(),
  status: RunStatus,
  summary_json: Json,
  log_path: VaultPath.nullable(),
});
export type Run = z.infer<typeof Run>;

export const ONBOARD_STEPS = ['resume', 'interview', 'calibrate', 'confirm', 'done'] as const;
export const OnboardStep = z.enum(ONBOARD_STEPS);
export type OnboardStep = z.infer<typeof OnboardStep>;

/**
 * In-progress onboarding (Wave 2, migration 002; lane E request). One row per session;
 * the latest unfinished one is resumed by `onboard.state`.
 */
export const OnboardSession = z.object({
  id: Id,
  started_at: IsoTimestamp,
  updated_at: IsoTimestamp,
  step: OnboardStep,
  /** Components being (re-)interviewed; null = full onboarding. */
  scope_json: z.array(ProfileComponentKey).nullable(),
  /** Draft data per component key. */
  draft_json: Json,
  /** Where each component's data came from: key -> ['resume' | 'interview' | 'profile']. */
  sources_json: Json,
  /** Answered question ids. */
  answered_json: z.array(z.string()),
  /** `{ sample_ids, choices }`. */
  calibration_json: Json,
  /** Profile version written by `onboard.confirm`; null until then. */
  version_id: Id.nullable(),
  /**
   * Added (#22, migration 007): the resume-adaptive interview plan `{ hints, questions, skipped }`:
   * per-component resume drafts with a confidence, follow-up questions the agent proposed, skipped ids.
   */
  interview_json: Json,
});
export type OnboardSession = z.infer<typeof OnboardSession>;

/** Most turns an Ask thread keeps (`ask_thread.turns_json`, #69); the newest are kept. */
export const ASK_THREAD_MAX_TURNS = 20;
/** Ask threads not updated for this many days are pruned (#69). */
export const ASK_THREAD_TTL_DAYS = 30;

/** One finished Ask turn: the user's message and the reply text. */
export const AskThreadTurn = z.object({ user: z.string(), reply: z.string() });
export type AskThreadTurn = z.infer<typeof AskThreadTurn>;

/**
 * An Ask (Cmd+K) thread (#69, migration 008), kept so a `pp up` restart resumes it. Engine state, not an
 * op: written by `pp up`'s Ask turn, never by skills or agents.
 */
export const AskThreadRow = z.object({
  id: Id,
  created_at: IsoTimestamp,
  updated_at: IsoTimestamp,
  runner: z.enum(RUNNER_COMMANDS),
  /** The runner's session id (Claude Code `--resume`); null until a turn reported one. */
  session_id: z.string().nullable(),
  /** The last turns, oldest first, at most ASK_THREAD_MAX_TURNS. */
  turns_json: z.array(AskThreadTurn).max(ASK_THREAD_MAX_TURNS),
});
export type AskThreadRow = z.infer<typeof AskThreadRow>;

/** Table name -> row schema. Migrations 001..003 must match this exactly. */
export const TABLES = {
  profile_version: ProfileVersion,
  profile_component: ProfileComponent,
  profile_diff: ProfileDiff,
  company: Company,
  role: Role,
  score: Score,
  event: EventRow,
  application: Application,
  contact: Contact,
  contact_link: ContactLink,
  outreach: Outreach,
  interview: Interview,
  decision: Decision,
  run: Run,
  onboard_session: OnboardSession,
  ask_thread: AskThreadRow,
} as const;
export type TableName = keyof typeof TABLES;

/** INTEGER 0/1 columns that are booleans in the contract. Repository layers convert on read/write. */
export const BOOLEAN_COLUMNS: Partial<Record<TableName, readonly string[]>> = {
  role: ['remote_ok'],
  contact_link: ['is_hiring_team'],
  decision: ['overridden'],
};
