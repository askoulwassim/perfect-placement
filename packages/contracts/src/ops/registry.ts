import { z } from 'zod';
import {
  Application,
  Company,
  Contact,
  ContactLink,
  Decision,
  OnboardStep,
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
  PolicyOutcome,
  ProfileComponentKey,
  RoleSource,
  RoleStatus,
  RunStatus,
  Skill,
  Workplace,
} from '../enums.js';
import { PolicyConfig, ROUTABLE_BACKENDS } from '../policy.js';
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

/** Added in Wave 2 (lane E): undo an applied diff inside its window; `decisions.undo` dispatches here via DecisionAction.undo. */
export const profileUndoDiff = defineOp({
  name: 'profile.undo_diff',
  description: 'Undo an applied diff: new version restoring the prior data; the diff becomes undone.',
  input: z.object({ diff_id: Id }),
  output: z.object({ version: ProfileVersion }),
  impact: 'low',
  emits: [],
  owner: 'E',
});

/** Added in Wave 2 (lane E): run the Learn loop for one event (schedules, inbox monitor, MCP). */
export const profileLearn = defineOp({
  name: 'profile.learn',
  description: 'Learn from one event: propose diffs, apply or queue them through the policy.',
  input: z.object({ event_id: Id }),
  output: z.object({
    proposed: z.array(ProfileDiff),
    applied: z.array(z.object({ diff_id: Id, version_id: Id })),
    queued: z.array(z.object({ diff_id: Id, decision_id: Id })),
  }),
  impact: 'low',
  emits: ['profile_diff_proposed', 'profile_diff_applied'],
  owner: 'E',
});

// --------------------------------------------------------------- onboard (E)

const OnboardState = z.object({
  step: OnboardStep,
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
      /** Slider step (Wave 2, lane D request). */
      step: z.number().optional(),
    })
    .nullable(),
});

/** Added in Wave 2 (lane E): start full onboarding, or re-interview only some components. */
export const onboardStart = defineOp({
  name: 'onboard.start',
  description: 'Start onboarding; with components, re-interview only those.',
  input: z.object({ components: z.array(ProfileComponentKey).optional() }),
  output: OnboardState,
  impact: 'low',
  emits: [],
  owner: 'E',
});

/** Added in Wave 2 (lane E): resume mid-flow. */
export const onboardState = defineOp({
  name: 'onboard.state',
  description: 'Current onboarding state.',
  input: z.object({}),
  output: OnboardState,
  impact: 'low',
  readOnly: true,
  emits: [],
  owner: 'E',
});

const CalibrationSample = z.object({
  id: z.string(),
  company: z.string(),
  letter: z.string(),
  title: z.string(),
  comp: z.string(),
  mode: z.string(),
  criteria: z.record(Criterion, CriterionScore),
});

/** Added in Wave 2 (lanes D + E): the calibration cards plus the baseline weights the bars start from. */
export const onboardSamples = defineOp({
  name: 'onboard.samples',
  description: 'Calibration sample roles and baseline criterion weights.',
  input: z.object({}),
  output: z.object({ items: z.array(CalibrationSample), weights: z.record(Criterion, z.number()) }),
  impact: 'low',
  readOnly: true,
  emits: [],
  owner: 'E',
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
  output: z.object({
    version: ProfileVersion,
    /** Filter changes held back as pending high-impact diffs when re-onboarding over an existing profile. */
    proposed_diffs: z.array(ProfileDiff).default([]),
  }),
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
    /** Near matches that were added and queued as `roles.dedupe` decisions. */
    possible_duplicates: z.array(z.object({ index: z.number().int(), role_id: Id, existing_id: Id, decision_id: Id })).default([]),
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
    notes: z.partialRecord(Criterion, z.string()).optional(),
    /** Score under this profile version (Learn loop rescoring). Default: latest. */
    profile_version_id: Id.optional(),
  }),
  output: z.object({
    score: Score,
    status: RoleStatus,
    held: z.boolean(),
    /** Other roles the per-company cap moved. */
    cap: z.array(z.object({ role_id: Id, from: z.enum(['active', 'held']), to: z.enum(['active', 'held']) })).default([]),
  }),
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
    /** Requested ids not checked: outside FRESHNESS_SCOPE or unknown. */
    skipped: z.array(Id).default([]),
  }),
  impact: 'medium',
  dynamicImpact: true,
  emits: ['freshness_checked', 'role_closed', 'role_archived', 'role_promoted'],
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

/** Added in Wave 2 (lane C): one company with its roles and dossier (MCP company resource). */
export const companiesGet = defineOp({
  name: 'companies.get',
  description: 'One company with its roles and dossier.',
  input: z.object({ company_id: Id }),
  output: z.object({ company: Company, roles: z.array(RoleSummary), dossier_md: z.string().nullable() }),
  impact: 'low',
  readOnly: true,
  emits: [],
  owner: 'B',
});

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
  emits: ['application_tailored', 'role_moved', 'role_promoted'],
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
  emits: ['application_submitted', 'role_moved', 'role_promoted'],
  owner: 'B',
});

// ------------------------------------------------------------------ people (H)

export const peopleFind = defineOp({
  name: 'people.find',
  description: 'Find people for a picked role via LinkedIn (read-only, rate-limited), Gmail and the JD.',
  input: z.object({
    role_id: Id,
    dry_run: z.boolean().optional(),
    /** People the skill found in the JD, on the company site, or that the user named. */
    hints: z
      .array(
        z.object({
          name: z.string().min(1),
          headline: z.string().nullable().optional(),
          linkedin_url: z.string().url().nullable().optional(),
          email: z.string().email().nullable().optional(),
          source: z.enum(['jd', 'company_site', 'manual']),
        }),
      )
      .max(20)
      .optional(),
    /** LinkedIn vanity slug when it differs from the company slug. */
    linkedin_company_slug: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional(),
  }),
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
  input: z.object({
    contact_id: Id,
    role_id: Id,
    /** Set the classification directly (a human's pick from Needs you, via DecisionAction `$value`); skips the resolver. */
    role: ContactRole.optional(),
  }),
  /** `outcome`: whether the tier was applied (auto*) or waits in Needs you (human). A human accept runs `people.link` via DecisionAction. */
  output: z.object({ role: ContactRole, tier: ContactTier, p: z.number(), decision_id: Id, outcome: PolicyOutcome }),
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

const DraftText = z.object({ hook: z.string(), proof: z.string(), ask: z.string() });

/** Tone variants, in this order (the Outreach screen's tone chips switch between them locally). */
export const OUTREACH_TONES = ['Ask for the conversation', 'Coffee or intro', 'Forwardable blurb', 'Positioning note'] as const;

/** Added in Wave 2 (lane D): draft text for the Outreach screen and the Needs-you card. */
export const outreachGet = defineOp({
  name: 'outreach.get',
  description: 'One outreach draft with its contact, text and one variant per tone.',
  input: z.object({ outreach_id: Id }),
  output: DraftText.extend({
    outreach: Outreach,
    contact: Contact,
    subject: z.string().nullable(),
    /** One per OUTREACH_TONES entry, same order. */
    variants: z.array(DraftText).length(OUTREACH_TONES.length),
  }),
  impact: 'low',
  readOnly: true,
  emits: [],
  owner: 'H',
});

/** Added in Wave 2 (lane D): drafts for a role (DraftStatusChip per person). */
export const outreachList = defineOp({
  name: 'outreach.list',
  description: 'Outreach drafts for a role.',
  input: z.object({ role_id: Id }),
  output: z.object({ items: z.array(Outreach) }),
  impact: 'low',
  readOnly: true,
  emits: [],
  owner: 'H',
});

/** Added in Wave 2 (lane D): one contact with its links (Needs-you people cards). */
export const contactsGet = defineOp({
  name: 'contacts.get',
  description: 'One contact with its links.',
  input: z.object({ contact_id: Id }),
  output: z.object({ contact: Contact, links: z.array(ContactLink) }),
  impact: 'low',
  readOnly: true,
  emits: [],
  owner: 'H',
});

export const outreachToGmail = defineOp({
  name: 'outreach.to_gmail',
  description:
    'Create a Gmail draft from a vault draft, or record one the calling agent already created with its own Gmail tool (gmail_draft_id). Never sends.',
  input: z.object({
    outreach_id: Id,
    /**
     * Added (Gmail via agent): the id of a Gmail draft the calling agent already created with its own
     * Gmail draft tool (Claude Code: the Gmail connector). The engine then records it instead of
     * calling its own Gmail client (it has none by default).
     */
    gmail_draft_id: z.string().min(1).optional(),
  }),
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
  emits: [
    'inbox_classified',
    'role_moved',
    'role_archived',
    'role_promoted',
    'interview_scheduled',
    'rejection',
    'offer',
    'outreach_replied',
  ],
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

/**
 * Added in Wave 0: UI buttons (Scout now, Research, Tailor, Connect, Fill, Check all) start skill runs.
 * Launches the configured headless runner (`config.runner`). A `connect` run's
 * `summary_json.outreach_id` names the draft it wrote (or, with `outreach_id`, the draft it puts in Gmail).
 */
export const runsStart = defineOp({
  name: 'runs.start',
  description: 'Start a skill run, optionally for one role, one person, or one outreach draft (connect: the Gmail draft step).',
  input: z.object({
    skill: Skill,
    role_id: Id.optional(),
    contact_id: Id.optional(),
    /**
     * Added (Gmail via agent): `connect` only. Scopes the run to the Gmail draft step for this outreach:
     * the agent creates a Gmail draft with its own Gmail tool and records it with `outreach.to_gmail`.
     */
    outreach_id: Id.optional(),
  }),
  output: z.object({ run: Run }),
  impact: 'low',
  emits: ['run_started'],
  owner: 'B',
});

/** Added in Wave 2 (lane B): close a run started with runs.start. */
export const runsFinish = defineOp({
  name: 'runs.finish',
  description: 'Close a skill run started with runs.start.',
  input: z.object({
    run_id: Id,
    status: RunStatus.exclude(['running']),
    summary: z.record(z.string(), z.unknown()).optional(),
    note: z.string().optional(),
  }),
  output: z.object({ run: Run }),
  impact: 'low',
  emits: ['run_finished'],
  owner: 'B',
});

// -------------------------------------------------------------------- vault (B)

/** Added in Wave 2 (lane D): package previews. Only paths the db references; frontmatter stripped. */
export const vaultRead = defineOp({
  name: 'vault.read',
  description: 'Read a vault markdown file the db references (frontmatter stripped).',
  input: z.object({ path: VaultPath }),
  output: z.object({ markdown: z.string().nullable() }),
  impact: 'low',
  readOnly: true,
  emits: [],
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

/** Added in Wave 2 (lane D, amended): Settings backend cards. */
export const systemBackends = defineOp({
  name: 'system.backends',
  description: 'Decision backends with mode, status and latency.',
  input: z.object({}),
  output: z.object({
    items: z.array(
      z.object({
        name: z.enum(['rule', ...ROUTABLE_BACKENDS]),
        mode: z.enum(['hosted', 'local', 'session']),
        status: z.enum(['ok', 'slow', 'down']),
        latencyMs: z.number().nonnegative().nullable(),
      }),
    ),
  }),
  impact: 'low',
  readOnly: true,
  emits: [],
  owner: 'I',
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
  'profile.undo_diff': profileUndoDiff,
  'profile.learn': profileLearn,
  'onboard.start': onboardStart,
  'onboard.state': onboardState,
  'onboard.samples': onboardSamples,
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
  'companies.get': companiesGet,
  'companies.dossier.write': companiesDossierWrite,
  'apply.tailor': applyTailor,
  'apply.fill': applyFill,
  'apply.mark_submitted': applyMarkSubmitted,
  'people.find': peopleFind,
  'people.link': peopleLink,
  'people.classify': peopleClassify,
  'contacts.get': contactsGet,
  'outreach.get': outreachGet,
  'outreach.list': outreachList,
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
  'runs.finish': runsFinish,
  'vault.read': vaultRead,
  'system.doctor': systemDoctor,
  'system.backends': systemBackends,
  'config.get': configGet,
  'config.update': configUpdate,
} as const;

export type Ops = typeof OPS;
export type OpName = keyof Ops;
export type OpInput<N extends OpName> = z.input<Ops[N]['input']>;
export type OpOutput<N extends OpName> = z.output<Ops[N]['output']>;
export const OP_NAMES = Object.keys(OPS) as OpName[];
