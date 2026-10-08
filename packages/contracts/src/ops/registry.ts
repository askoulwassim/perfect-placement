import { z } from 'zod';
import {
  Application,
  Company,
  Contact,
  ContactLink,
  Decision,
  Outreach,
  ProfileComponent,
  ProfileDiff,
  ProfileVersion,
  Role,
  Run,
  Score,
} from '../entities.js';
import {
  ArchiveReason,
  Band,
  ContactRole,
  ContactTier,
  Criterion,
  DecisionStatus,
  Freshness,
  InboxClass,
  ProfileComponentKey,
  RoleSource,
  RoleStatus,
  Skill,
  Workplace,
} from '../enums.js';
import { PolicyConfig } from '../policy.js';
import { CriterionScore, Id, IsoTimestamp, VaultPath } from '../primitives.js';
import { Ack, defineOp, Page } from './define.js';

/*
 * The ops registry (contracts.md "Ops"). Every write in the system is one of these.
 * UI buttons, MCP tools, CLI commands and skills all call `runOp(name, input, ctx)`.
 * Handlers live in packages/engine/ops (lane B) or the owning lane's folder.
 */

// ---------------------------------------------------------------- profile (E)

const ProfileCard = z.object({
  version: ProfileVersion,
  components: z.array(ProfileComponent),
  pending_diffs: z.array(ProfileDiff),
});

export const profileGet = defineOp({
  name: 'profile.get',
  description: 'Current profile version with its 11 components and pending diffs.',
  input: z.object({ version_id: Id.optional() }),
  output: ProfileCard,
  impact: 'low',
  readOnly: true,
  emits: [],
  owner: 'E',
});

export const profileHistory = defineOp({
  name: 'profile.history',
  description: 'Version timeline, optionally for one component.',
  input: z.object({ component: ProfileComponentKey.optional() }),
  output: z.object({ versions: z.array(ProfileVersion) }),
  impact: 'low',
  readOnly: true,
  emits: [],
  owner: 'E',
});

export const profileProposeDiff = defineOp({
  name: 'profile.propose_diff',
  description: 'Create a pending diff on one component with evidence.',
  input: z.object({
    component: ProfileComponentKey,
    before: z.record(z.string(), z.unknown()),
    after: z.record(z.string(), z.unknown()),
    evidence: z.array(z.string()).min(1),
    event_id: Id.optional(),
  }),
  output: z.object({ diff: ProfileDiff }),
  impact: 'low',
  emits: ['profile_diff_proposed'],
  owner: 'E',
});

export const profileApplyDiff = defineOp({
  name: 'profile.apply_diff',
  description: 'Apply a pending diff, creating profile v+1. Weights medium; filters and dealbreakers high.',
  input: z.object({ diff_id: Id }),
  output: z.object({ version: ProfileVersion, rescored_role_ids: z.array(Id) }),
  impact: 'high',
  dynamicImpact: true,
  emits: ['profile_diff_applied'],
  owner: 'E',
});

/** Added in Wave 0: the You screen and Needs-you need a reject path for profile_diff_rejected. */
export const profileRejectDiff = defineOp({
  name: 'profile.reject_diff',
  description: 'Reject a pending diff.',
  input: z.object({ diff_id: Id, reason: z.string().optional() }),
  output: Ack,
  impact: 'low',
  emits: ['profile_diff_rejected'],
  owner: 'E',
});

// --------------------------------------------------------------- onboard (E)

const OnboardState = z.object({
  step: z.enum(['resume', 'interview', 'calibrate', 'confirm', 'done']),
  components_filled: z.array(ProfileComponentKey),
  next_question: z
    .object({
      id: z.string(),
      component: ProfileComponentKey,
      label: z.string(),
      answer_type: z.enum(['chips', 'multi_chips', 'slider', 'text']),
      options: z.array(z.string()).optional(),
      min: z.number().optional(),
      max: z.number().optional(),
    })
    .nullable(),
});

export const onboardIngestResume = defineOp({
  name: 'onboard.ingest_resume',
  description: 'Parse a resume into Story and Craft drafts.',
  input: z.object({ file_path: VaultPath.optional(), text: z.string().optional() }),
  output: OnboardState,
  impact: 'low',
  emits: [],
  owner: 'E',
});

export const onboardAnswer = defineOp({
  name: 'onboard.answer',
  description: 'Answer one interview question for a component.',
  input: z.object({ question_id: z.string(), value: z.union([z.string(), z.number(), z.array(z.string())]) }),
  output: OnboardState,
  impact: 'low',
  emits: [],
  owner: 'E',
});

export const onboardCalibrate = defineOp({
  name: 'onboard.calibrate',
  description: 'Record yes/no/maybe on a calibration sample role.',
  input: z.object({ sample_id: z.string(), choice: z.enum(['yes', 'no', 'maybe']) }),
  output: z.object({ weights: z.record(Criterion, z.number()), remaining: z.number().int() }),
  impact: 'low',
  emits: [],
  owner: 'E',
});

export const onboardConfirm = defineOp({
  name: 'onboard.confirm',
  description: 'Save the onboarded profile as a new version.',
  input: z.object({}),
  output: z.object({ version: ProfileVersion }),
  impact: 'low',
  emits: [],
  owner: 'E',
});

// ----------------------------------------------------------------- roles (B/F/G)

const RoleCandidate = z.object({
  company_name: z.string(),
  company_domain: z.string().optional(),
  title: z.string(),
  url: z.string().url().optional(),
  ats_job_id: z.string().optional(),
  source: RoleSource,
  posted_at: IsoTimestamp.optional(),
  workplace: Workplace.optional(),
  location: z.string().optional(),
  comp_min: z.number().int().optional(),
  comp_max: z.number().int().optional(),
  comp_currency: z.string().length(3).optional(),
  jd_markdown: z.string().optional(),
});

export const rolesAdd = defineOp({
  name: 'roles.add',
  description: 'Add candidate roles to inbox. Dedupes on url, ATS job id, company + title (fuzzy).',
  input: z.object({ candidates: z.array(RoleCandidate).min(1) }),
  output: z.object({
    added: z.array(Id),
    duplicates: z.array(z.object({ index: z.number().int(), existing_id: Id, match: z.enum(['url', 'ats_job_id', 'company_title']) })),
  }),
  impact: 'low',
  emits: ['role_added'],
  owner: 'B',
});

export const rolesScore = defineOp({
  name: 'roles.score',
  description: 'Write a score row from judged criteria; set active, held or archived.',
  input: z.object({
    role_id: Id,
    criteria: z.record(Criterion, CriterionScore),
    facts: z.record(z.string(), z.unknown()),
    /** Rationale per criterion, kept in the role markdown, not the db. */
    notes: z.record(Criterion, z.string()).optional(),
  }),
  output: z.object({ score: Score, status: RoleStatus, held: z.boolean() }),
  impact: 'low',
  emits: ['role_scored', 'role_archived', 'role_held', 'role_promoted'],
  owner: 'F',
});

export const rolesMove = defineOp({
  name: 'roles.move',
  description: 'Change status with the no-downgrade guard.',
  input: z.object({ role_id: Id, to: RoleStatus, reason: z.string().optional() }),
  output: z.object({ role: Role, from: RoleStatus }),
  impact: 'medium',
  emits: ['role_moved', 'role_picked', 'role_skipped', 'role_promoted'],
  owner: 'B',
});

export const rolesArchive = defineOp({
  name: 'roles.archive',
  description: 'Archive a role with a reason.',
  input: z.object({ role_id: Id, reason: ArchiveReason, note: z.string().optional() }),
  output: z.object({ role: Role }),
  impact: 'medium',
  emits: ['role_archived', 'role_skipped', 'role_promoted'],
  owner: 'B',
});

export const rolesCheckFreshness = defineOp({
  name: 'roles.check_freshness',
  description: 'Check if postings are still open. Medium impact when it closes a role.',
  input: z.object({ role_ids: z.array(Id).optional(), all_in_scope: z.boolean().optional() }),
  output: z.object({
    results: z.array(
      z.object({
        role_id: Id,
        freshness: Freshness,
        method: z.enum(['ats_api', 'page', 'resolver']),
        stale: z.boolean(),
        decision_id: Id.nullable(),
      }),
    ),
  }),
  impact: 'medium',
  dynamicImpact: true,
  emits: ['freshness_checked', 'role_closed', 'role_archived'],
  owner: 'G',
});

const RoleSummary = z.object({
  role: Role,
  company: Company,
  latest_score: Score.nullable(),
});

export const rolesGet = defineOp({
  name: 'roles.get',
  description: 'One role with company, latest score, application and people.',
  input: z.object({ role_id: Id }),
  output: RoleSummary.extend({
    application: Application.nullable(),
    contacts: z.array(z.object({ contact: Contact, link: ContactLink })),
    md_body: z.string().nullable(),
  }),
  impact: 'low',
  readOnly: true,
  emits: [],
  owner: 'B',
});

export const rolesList = defineOp({
  name: 'roles.list',
  description: 'List roles by status, band, freshness, company.',
  input: Page.extend({
    status: z.array(RoleStatus).optional(),
    band: z.array(Band).optional(),
    freshness: z.array(Freshness).optional(),
    company_id: Id.optional(),
    workplace: z.array(Workplace).optional(),
    sort: z.enum(['fit', 'found_at', 'last_checked_at']).optional(),
  }),
  output: z.object({ items: z.array(RoleSummary), next_cursor: z.string().nullable() }),
  impact: 'low',
  readOnly: true,
  emits: [],
  owner: 'B',
});

export const pipelineSummary = defineOp({
  name: 'pipeline.summary',
  description: 'Counts by status and archive reason; Now screen numbers.',
  input: z.object({}),
  output: z.object({
    counts: z.record(RoleStatus, z.number().int()),
    archived_by_reason: z.record(ArchiveReason, z.number().int()),
    needs_you: z.number().int(),
    auto_share_24h: z.number().min(0).max(1),
    closed_today: z.number().int(),
    drafts_ready: z.number().int(),
    replies: z.number().int(),
  }),
  impact: 'low',
  readOnly: true,
  emits: [],
  owner: 'B',
});

// --------------------------------------------------------------- companies (B)

export const companiesDossierWrite = defineOp({
  name: 'companies.dossier.write',
  description: 'Write or refresh a company dossier.',
  input: z.object({ company_id: Id, markdown: z.string().min(1) }),
  output: z.object({ md_path: VaultPath }),
  impact: 'low',
  emits: [],
  owner: 'B',
});

// ------------------------------------------------------------------- apply (B)

export const applyTailor = defineOp({
  name: 'apply.tailor',
  description: 'Write the tailored package and move the role to draft-ready.',
  input: z.object({
    role_id: Id,
    resume_md: z.string().min(1),
    cover_letter_md: z.string().min(1),
    fit_map_md: z.string().min(1),
  }),
  output: z.object({ application: Application }),
  impact: 'low',
  emits: ['application_tailored', 'role_moved'],
  owner: 'B',
});

export const applyFill = defineOp({
  name: 'apply.fill',
  description: 'Write answers to the real portal questions.',
  input: z.object({
    role_id: Id,
    portal_url: z.string().url().optional(),
    answers: z.array(z.object({ question: z.string(), answer: z.string(), needs_human: z.boolean().default(false) })),
  }),
  output: z.object({ application: Application }),
  impact: 'low',
  emits: [],
  owner: 'B',
});

export const applyMarkSubmitted = defineOp({
  name: 'apply.mark_submitted',
  description: 'Human confirms they submitted. The app never submits.',
  input: z.object({ role_id: Id, applied_at: IsoTimestamp.optional() }),
  output: z.object({ role: Role, application: Application }),
  impact: 'high',
  humanOnly: true,
  emits: ['application_submitted', 'role_moved'],
  owner: 'B',
});

// ------------------------------------------------------------------ people (H)

export const peopleFind = defineOp({
  name: 'people.find',
  description: 'Find people for a picked role via LinkedIn (read-only, rate-limited), Gmail and the JD.',
  input: z.object({ role_id: Id, dry_run: z.boolean().optional() }),
  output: z.object({ found: z.array(z.object({ contact: Contact, link: ContactLink })), capped: z.boolean() }),
  impact: 'low',
  emits: ['contact_found'],
  owner: 'H',
});

export const peopleLink = defineOp({
  name: 'people.link',
  description: 'Link a contact to a company or role.',
  input: ContactLink.omit({ id: true }),
  output: z.object({ link: ContactLink }),
  impact: 'low',
  emits: [],
  owner: 'H',
});

export const peopleClassify = defineOp({
  name: 'people.classify',
  description: 'Classify a contact relative to a role and set the tier.',
  input: z.object({ contact_id: Id, role_id: Id }),
  output: z.object({ role: ContactRole, tier: ContactTier, p: z.number(), decision_id: Id }),
  impact: 'low',
  emits: [],
  owner: 'H',
});

// ---------------------------------------------------------------- outreach (H)

export const outreachDraft = defineOp({
  name: 'outreach.draft',
  description: 'Write an outreach draft (Hook, Proof, Ask) to the vault.',
  input: z.object({
    contact_id: Id,
    role_id: Id,
    tier: ContactTier,
    hook: z.string().min(1),
    proof: z.string().min(1),
    ask: z.string().min(1),
    subject: z.string().optional(),
  }),
  output: z.object({ outreach: Outreach }),
  impact: 'low',
  emits: ['outreach_drafted'],
  owner: 'H',
});

export const outreachToGmail = defineOp({
  name: 'outreach.to_gmail',
  description: 'Create a Gmail draft from a vault draft. Never sends.',
  input: z.object({ outreach_id: Id }),
  output: z.object({ outreach: Outreach, gmail_draft_id: z.string() }),
  impact: 'medium',
  emits: [],
  owner: 'H',
});

export const outreachSend = defineOp({
  name: 'outreach.send',
  description: 'Not implemented in v2. The human sends from Gmail.',
  input: z.object({ outreach_id: Id }),
  output: Ack,
  impact: 'high',
  humanOnly: true,
  unimplemented: true,
  emits: [],
  owner: 'H',
});

// ------------------------------------------------------------------- inbox (B)

export const inboxIngest = defineOp({
  name: 'inbox.ingest',
  description: 'Apply classified Gmail messages: confirmation, interview, offer, rejection, outreach reply.',
  input: z.object({
    messages: z.array(
      z.object({
        message_id: z.string(),
        thread_id: z.string().optional(),
        received_at: IsoTimestamp,
        role_id: Id.nullable(),
        outreach_id: Id.optional(),
        class: InboxClass,
        p: z.number().min(0).max(1),
        interview_at: IsoTimestamp.optional(),
      }),
    ),
  }),
  output: z.object({
    applied: z.array(z.object({ message_id: z.string(), role_id: Id.nullable(), to: RoleStatus.nullable() })),
    queued: z.array(z.object({ message_id: z.string(), decision_id: Id })),
    ignored: z.array(z.string()),
  }),
  impact: 'medium',
  emits: ['inbox_classified', 'role_moved', 'role_archived', 'interview_scheduled', 'rejection', 'offer', 'outreach_replied'],
  owner: 'B',
});

// --------------------------------------------------------------- decisions (I/B)

export const decisionsQueue = defineOp({
  name: 'decisions.queue',
  description: 'The Needs-you queue plus recent auto decisions.',
  input: z.object({
    status: z.array(DecisionStatus).optional(),
    include_auto_since: IsoTimestamp.optional(),
  }),
  output: z.object({ pending: z.array(Decision), recent_auto: z.array(Decision) }),
  impact: 'low',
  readOnly: true,
  emits: [],
  owner: 'I',
});

export const decisionsResolve = defineOp({
  name: 'decisions.resolve',
  description: 'Accept the pick, change it, or skip. Runs the queued action with the chosen value.',
  input: z.object({
    decision_id: Id,
    action: z.enum(['accept', 'change', 'skip']),
    value: z.union([z.string(), z.boolean(), z.number()]).optional(),
  }),
  output: z.object({ decision: Decision, op_status: z.enum(['ok', 'requires_human', 'error', 'skipped']) }),
  impact: 'low',
  dynamicImpact: true,
  emits: ['decision_made', 'decision_overridden'],
  owner: 'I',
});

export const decisionsUndo = defineOp({
  name: 'decisions.undo',
  description: 'Undo an auto + undo decision inside its window.',
  input: z.object({ decision_id: Id }),
  output: z.object({ decision: Decision }),
  impact: 'low',
  dynamicImpact: true,
  emits: ['decision_undone'],
  owner: 'I',
});

// -------------------------------------------------------------------- runs (B)

export const runsList = defineOp({
  name: 'runs.list',
  description: 'Recent runs.',
  input: Page.extend({ op: z.string().optional() }),
  output: z.object({ items: z.array(Run), next_cursor: z.string().nullable() }),
  impact: 'low',
  readOnly: true,
  emits: [],
  owner: 'B',
});

export const runsGet = defineOp({
  name: 'runs.get',
  description: 'One run with its log.',
  input: z.object({ run_id: Id }),
  output: z.object({ run: Run, log_md: z.string().nullable() }),
  impact: 'low',
  emits: [],
  readOnly: true,
  owner: 'B',
});

/** Added in Wave 0: UI buttons (Scout now, Research, Tailor, Connect, Fill, Check all) start skill runs. */
export const runsStart = defineOp({
  name: 'runs.start',
  description: 'Start a skill run, optionally for one role.',
  input: z.object({ skill: Skill, role_id: Id.optional() }),
  output: z.object({ run: Run }),
  impact: 'low',
  emits: ['run_started'],
  owner: 'B',
});

// ------------------------------------------------------------- system + config

export const systemDoctor = defineOp({
  name: 'system.doctor',
  description: 'Integrity checks: db, vault paths, counts, CLAUDE.md in parent chain, PP_HOME not in a git repo.',
  input: z.object({ fix: z.literal(false).optional() }),
  output: z.object({
    ok: z.boolean(),
    checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string().optional() })),
    counts: z.record(RoleStatus, z.number().int()),
  }),
  impact: 'low',
  readOnly: true,
  emits: [],
  owner: 'A',
});

/** Added in Wave 0: Settings screen reads and saves config.json. */
export const configGet = defineOp({
  name: 'config.get',
  description: 'Read config.json.',
  input: z.object({}),
  output: PolicyConfig,
  impact: 'low',
  readOnly: true,
  emits: [],
  owner: 'B',
});

export const configUpdate = defineOp({
  name: 'config.update',
  description: 'Patch config.json (thresholds, backends, schedules, caps).',
  /** Deep-partial patch; the merged result must parse as PolicyConfig. */
  input: z.object({ patch: z.record(z.string(), z.unknown()) }),
  output: PolicyConfig,
  impact: 'medium',
  emits: [],
  owner: 'B',
});

/** Every op, keyed by name. Order follows contracts.md. */
export const OPS = {
  'profile.get': profileGet,
  'profile.history': profileHistory,
  'profile.propose_diff': profileProposeDiff,
  'profile.apply_diff': profileApplyDiff,
  'profile.reject_diff': profileRejectDiff,
  'onboard.ingest_resume': onboardIngestResume,
  'onboard.answer': onboardAnswer,
  'onboard.calibrate': onboardCalibrate,
  'onboard.confirm': onboardConfirm,
  'roles.add': rolesAdd,
  'roles.score': rolesScore,
  'roles.move': rolesMove,
  'roles.archive': rolesArchive,
  'roles.check_freshness': rolesCheckFreshness,
  'roles.get': rolesGet,
  'roles.list': rolesList,
  'pipeline.summary': pipelineSummary,
  'companies.dossier.write': companiesDossierWrite,
  'apply.tailor': applyTailor,
  'apply.fill': applyFill,
  'apply.mark_submitted': applyMarkSubmitted,
  'people.find': peopleFind,
  'people.link': peopleLink,
  'people.classify': peopleClassify,
  'outreach.draft': outreachDraft,
  'outreach.to_gmail': outreachToGmail,
  'outreach.send': outreachSend,
  'inbox.ingest': inboxIngest,
  'decisions.queue': decisionsQueue,
  'decisions.resolve': decisionsResolve,
  'decisions.undo': decisionsUndo,
  'runs.list': runsList,
  'runs.get': runsGet,
  'runs.start': runsStart,
  'system.doctor': systemDoctor,
  'config.get': configGet,
  'config.update': configUpdate,
} as const;

export type Ops = typeof OPS;
export type OpName = keyof Ops;
export type OpInput<N extends OpName> = z.input<Ops[N]['input']>;
export type OpOutput<N extends OpName> = z.output<Ops[N]['output']>;
export const OP_NAMES = Object.keys(OPS) as OpName[];
