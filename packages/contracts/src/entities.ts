import { z } from 'zod';
import {
  Actor,
  ArchiveReason,
  AtsType,
  Backend,
  Band,
  ComponentKind,
  ContactDegree,
  ContactSource,
  ContactTier,
  DecisionKind,
  DecisionStatus,
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
import { CriterionScore, Id, IsoTimestamp, Probability, Slug, VaultPath } from './primitives.js';

/*
 * Row schemas. One per table in migration 001.
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
  /** Free-form flags (v1 carried flags like `closed`, `dream_company`). */
  flags_json: Json,
  md_path: VaultPath.nullable(),
  created_at: IsoTimestamp,
  updated_at: IsoTimestamp,
});
export type Role = z.infer<typeof Role>;

/** Append-only. A rescore adds a row. */
export const Score = z.object({
  id: Id,
  role_id: Id,
  /** Null only for v1 legacy scores imported by migration. */
  profile_version_id: Id.nullable(),
  /** Snapshot of the rubric used: `{ version, weights, bands, ... }`. */
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

export const Application = z.object({
  id: Id,
  role_id: Id,
  stage: z.enum(['research', 'tailor', 'connect', 'fill', 'submit', 'done']),
  applied_at: IsoTimestamp.nullable(),
  portal_url: z.string().url().nullable(),
  /** `{ dossier?, resume?, cover_letter?, fit_map?, answers? }` vault paths. */
  package_paths_json: z.record(z.string(), VaultPath),
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
});
export type Contact = z.infer<typeof Contact>;

export const ContactLink = z.object({
  id: Id,
  contact_id: Id,
  company_id: Id.nullable(),
  role_id: Id.nullable(),
  degree: ContactDegree,
  tier: ContactTier,
  via_contact_id: Id.nullable(),
  is_hiring_team: z.boolean(),
});
export type ContactLink = z.infer<typeof ContactLink>;

export const Outreach = z.object({
  id: Id,
  contact_id: Id,
  role_id: Id,
  tier: ContactTier,
  gmail_draft_id: z.string().nullable(),
  status: OutreachStatus,
  md_path: VaultPath.nullable(),
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
  /** The op to run when this decision is applied: `{ op, input }`. */
  action_json: Json.nullable(),
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

/** Table name -> row schema. Migration 001 must match this exactly. */
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
} as const;
export type TableName = keyof typeof TABLES;

/** INTEGER 0/1 columns that are booleans in the contract. Repository layers convert on read/write. */
export const BOOLEAN_COLUMNS: Partial<Record<TableName, readonly string[]>> = {
  role: ['remote_ok'],
  contact_link: ['is_hiring_team'],
  decision: ['overridden'],
};
