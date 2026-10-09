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
  EmailSource,
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
import { PolicyConfig, ROUTABLE_BACKENDS, ScheduleSpec } from '../policy.js';
import { CriterionScore, Id, IsoTimestamp, Probability, VaultPath } from '../primitives.js';
import { ApplicationDefaults, FILL_KINDS } from '../profile-data.js';
import { ScheduleJobState, ScheduleKey } from '../schedules.js';
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

/**
 * Added (#42): save Application defaults (Terms `application_defaults`) from You. A human edit applies at
 * once as profile v+1 (a Terms diff, never rescored); from an agent it queues for the human. A field set to
 * an empty string or empty list is cleared.
 */
export const profileSetDefaults = defineOp({
  name: 'profile.set_defaults',
  description: 'Save the standard application answers (sponsorship, work authorization, relocation, notice, office days, comp, EEO).',
  input: z.object({ defaults: ApplicationDefaults }),
  output: z.object({ version: ProfileVersion.nullable(), defaults: ApplicationDefaults }),
  impact: 'low',
  emits: ['profile_diff_proposed', 'profile_diff_applied'],
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
      /**
       * Added (outreach voice): a text question that keeps a list (voice.sample). A string answer appends
       * one item; a string[] answer replaces the list (removes items). Up to `max_items` of `max_chars`.
       */
      max_items: z.number().int().positive().optional(),
      max_chars: z.number().int().positive().optional(),
      /** The list kept so far (list questions only), so the UI can show and remove items. */
      items: z.array(z.string()).optional(),
      /** Added (#23): an optional one-line example under the question (the label is a full sentence). */
      example: z.string().optional(),
      /**
       * Added (#22): `ask` (the question bank), `confirm` (the resume implies an answer with high
       * confidence: `yes` keeps it, `edit` asks the component's questions), `follow_up` (proposed by the
       * onboard agent run through `onboard.propose_questions`). Every kind can be skipped (`skip: true`).
       */
      kind: z.enum(['ask', 'confirm', 'follow_up']).default('ask'),
      /** Added (#22): the answer the resume suggests (low confidence or after `edit`); the UI pre-fills it. */
      suggested: z.union([z.string(), z.number(), z.array(z.string())]).optional(),
    })
    .nullable(),
  /**
   * Added (#22): what was pulled from the resume per component, with a confidence 0..1, shown before
   * and during the interview. `by`: the instant `preview` or the onboard `agent` run.
   */
  resume_drafts: z
    .array(
      z.object({
        component: ProfileComponentKey,
        confidence: z.number().min(0).max(1),
        items: z.array(z.string()),
        by: z.enum(['preview', 'agent']),
      }),
    )
    .default([]),
  /**
   * Added (#38): the kept source resume. `source_path` is its extracted text (vault markdown), `file_path`
   * the original upload (PDF / DOCX), `parse_run_id` the headless `onboard` run queued to parse it
   * (only on the ingest that queued it). Absent before a resume is in.
   */
  resume: z
    .object({
      source_path: VaultPath,
      file_path: VaultPath.nullable(),
      parse_run_id: Id.nullable(),
    })
    .optional(),
});

/** Added in Wave 2 (lane E): start full onboarding, or re-interview only some components. */
export const onboardStart = defineOp({
  name: 'onboard.start',
  description: 'Start onboarding; with components, re-interview only those; with calibrate, recalibrate the weights (needs a profile).',
  input: z.object({
    components: z.array(ProfileComponentKey).optional(),
    /**
     * Added (#25): recalibrate. A session at the calibrate step, seeded from the current profile (the bars
     * start from its weights); confirm writes only the weighted components as a new version.
     */
    calibrate: z.boolean().optional(),
  }),
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
  description:
    'Keep a resume in the vault (files/) and draft Story and Craft from it. A human upload also queues a headless onboard run that extracts the facts verbatim (onboard.extract).',
  input: z.object({
    file_path: VaultPath.optional(),
    text: z.string().optional(),
    /** Added (#38): an uploaded file (PDF, DOCX, MD, TXT), base64. Kept in files/ with its extracted text. */
    file: z.object({ name: z.string().min(1), content_base64: z.string().min(1) }).optional(),
  }),
  output: OnboardState,
  impact: 'low',
  emits: [],
  owner: 'E',
});

export const onboardAnswer = defineOp({
  name: 'onboard.answer',
  description: 'Answer one interview question for a component.',
  input: z.object({
    question_id: z.string(),
    /** Required unless `skip` (#23). */
    value: z.union([z.string(), z.number(), z.array(z.string())]).optional(),
    /** Added (#23): "I don't know": the question is answered with nothing; the draft is unchanged. */
    skip: z.boolean().optional(),
    /** Added (#38): the dictated original of a text answer whose cleaned `value` the user confirmed (kept for provenance). */
    raw: z.string().optional(),
  }),
  output: OnboardState,
  impact: 'low',
  emits: [],
  owner: 'E',
});

/**
 * Added (#38): the resume facts an agent extracted verbatim from the kept source resume. Every value must
 * appear in the resume text (numbers, dates, titles, employers, degrees), else invalid_input with the list.
 * `years` only when stated (`years_basis: 'stated'`) or derived from the role dates (`'from dates'`, asked
 * for confirmation). During onboarding it replaces the instant preview in the draft (interview answers
 * win); after onboarding it is proposed as a Story diff for the user.
 */
export const onboardExtract = defineOp({
  name: 'onboard.extract',
  description:
    'Write the facts extracted verbatim from the kept resume (roles, employers, titles, dates, wins, metrics, skills) as a draft for the user to confirm.',
  input: z.object({
    story: z.record(z.string(), z.unknown()),
    craft: z.record(z.string(), z.unknown()).optional(),
    /**
     * Added (#22): the agent's drafts for components the resume informs (judgment, not facts), each with
     * a confidence 0..1 and the resume lines it rests on. At or above 0.7 the interview confirms the
     * draft (Yes / Edit); below, it asks and pre-fills it. Never written to the profile unconfirmed.
     */
    drafts: z
      .partialRecord(
        z.enum(['craft', 'domain', 'growth', 'voice']),
        z.object({
          data: z.record(z.string(), z.unknown()),
          confidence: z.number().min(0).max(1),
          evidence: z.array(z.string()).max(6).optional(),
        }),
      )
      .optional(),
  }),
  output: z.object({
    /** `session`: merged into the onboarding draft; `diff`: proposed as a Story diff (onboarding was done). */
    target: z.enum(['session', 'diff']),
    state: OnboardState.optional(),
    diff_id: Id.optional(),
  }),
  impact: 'low',
  emits: [],
  owner: 'E',
});

/**
 * Added (#22): follow-up questions the onboard agent run proposes from the resume (where it is silent or
 * ambiguous). Asked after the component's bank questions; answers are kept in the component's
 * `follow_ups`. Full sentences, no duplicates of an existing question, at most 6 per session.
 */
export const OnboardProposedQuestion = z.object({
  component: ProfileComponentKey,
  label: z.string().min(1),
  example: z.string().optional(),
  answer_type: z.enum(['chips', 'multi_chips', 'text']),
  options: z.array(z.string().min(1)).max(8).optional(),
  /** Why the resume prompts it (kept with the session, not shown). */
  reason: z.string().optional(),
});
export const onboardProposeQuestions = defineOp({
  name: 'onboard.propose_questions',
  description:
    'Propose follow-up interview questions from the resume (full sentences, one component each, where the resume is silent or ambiguous). Answers are kept in that component.',
  input: z.object({ questions: z.array(OnboardProposedQuestion).min(1).max(5) }),
  output: z.object({
    added: z.array(z.string()),
    rejected: z.array(z.object({ label: z.string(), reason: z.string() })),
    state: OnboardState,
  }),
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

/** Per-source intake counts (`roles.add`, #28 / #32). */
export const IntakeCounts = z.object({
  candidates: z.number().int(),
  added: z.number().int(),
  duplicates: z.number().int(),
  skipped_dead: z.number().int(),
  skipped_aggregator: z.number().int(),
  /** Not added: over the run's watchlist share or per-company limit (#67). */
  skipped_cap: z.number().int().default(0),
});
export type IntakeCounts = z.infer<typeof IntakeCounts>;

export const rolesAdd = defineOp({
  name: 'roles.add',
  description:
    "Add candidate roles to inbox. Dedupes on url, ATS job id, company + title (fuzzy). Verifies each new posting URL: dead postings are skipped; aggregator links are resolved to the company's own ATS posting or skipped. Within a scout run, source watchlist adds stop at ceil(scout.watchlist_share_max * scout.target_new_roles) and at scout.max_per_company per company (skipped watchlist_cap / company_cap): fill the rest with open-market roles.",
  input: z.object({
    candidates: z.array(RoleCandidate).min(1),
    /** Check each new candidate's URL before adding (#32). Default true. */
    verify: z.boolean().optional(),
  }),
  output: z.object({
    added: z.array(Id),
    duplicates: z.array(z.object({ index: z.number().int(), existing_id: Id, match: z.enum(['url', 'ats_job_id', 'company_title']) })),
    /** Near matches that were added and queued as `roles.dedupe` decisions. */
    possible_duplicates: z.array(z.object({ index: z.number().int(), role_id: Id, existing_id: Id, decision_id: Id })).default([]),
    /**
     * Not added: the posting is gone (`dead`), only an aggregator listed it (`aggregator`), or (#67) the run's
     * watchlist adds are at their share (`watchlist_cap`) or the company at `scout.max_per_company` (`company_cap`).
     */
    skipped: z
      .array(
        z.object({ index: z.number().int(), reason: z.enum(['dead', 'aggregator', 'watchlist_cap', 'company_cap']), detail: z.string() }),
      )
      .default([]),
    /** Aggregator hits stored under the company's own posting URL. */
    resolved: z.array(z.object({ index: z.number().int(), role_id: Id, from: z.string(), to: z.string() })).default([]),
    /** Counts per candidate `source`. */
    by_source: z.partialRecord(RoleSource, IntakeCounts).default({}),
    /**
     * The scout run's watchlist budget after this call (#67): `max` = ceil(share * target), `added` so far
     * (this call included), `open_needed` = open-market adds still needed to reach `target`.
     */
    watchlist_budget: z
      .object({
        run_id: Id.nullable(),
        target: z.number().int(),
        max: z.number().int(),
        added: z.number().int(),
        remaining: z.number().int(),
        max_per_company: z.number().int(),
        open_added: z.number().int(),
        open_needed: z.number().int(),
      })
      .optional(),
  }),
  impact: 'low',
  emits: ['role_added'],
  owner: 'B',
});

export const scoutWatchlistScan = defineOp({
  name: 'scout.watchlist_scan',
  description:
    "List every open role on each watchlist company's ATS board (Greenhouse, Lever, Ashby), drop clear title / seniority / work-mode misses and roles already in the pipeline, group near-identical titles, rank the rest by title and profile fit and return at most scout.max_per_company per company as roles.add candidates (best first, companies interleaved). Companies without a readable board come back no_board (search the web for them). Board candidates never replace open-market search: roles.add caps a run's watchlist adds at its share of scout.target_new_roles.",
  input: z.object({
    /** Company names or slugs. Default: the Company component watchlist. */
    companies: z.array(z.string().min(1)).optional(),
    /** Title keywords that replace the Craft functions for the title rule. */
    include: z.array(z.string().min(1)).optional(),
    /** Title words that drop a posting. */
    exclude: z.array(z.string().min(1)).optional(),
    /** JD characters per candidate (roles.add captures the full JD from the ATS). Default 400; 0 = none. */
    jd_chars: z.number().int().min(0).max(20000).optional(),
    /** Most candidates per company (#67). Default `scout.max_per_company` (else `scoring.company_active_cap` + 2). */
    max_per_company: z.number().int().min(1).optional(),
  }),
  output: z.object({
    companies: z.array(
      z.object({
        company: z.string(),
        name: z.string(),
        state: z.enum(['scanned', 'no_board', 'error']),
        ats: z.string().nullable(),
        board: z.string().nullable(),
        listed: z.number().int(),
        /** Returned as candidates (after grouping and the per-company limit). */
        kept: z.number().int(),
        /** Passed the filter but over `max_per_company` (lowest fit dropped). */
        capped: z.number().int().default(0),
        /** Folded into a near-identical title at the same company (similarity >= 0.85). */
        grouped: z.number().int().default(0),
        reason: z.string().optional(),
      }),
    ),
    candidates: z.array(RoleCandidate),
    dropped: z.object({
      title: z.number().int(),
      seniority: z.number().int(),
      work_mode: z.number().int(),
      location: z.number().int(),
      known: z.number().int(),
      similar: z.number().int().default(0),
      company_cap: z.number().int().default(0),
    }),
    /** Near-identical titles folded into the kept one (`kept` = its URL). */
    groups: z.array(z.object({ company: z.string(), kept: z.string(), title: z.string(), similar: z.array(z.string()) })).default([]),
    max_per_company: z.number().int().optional(),
  }),
  impact: 'low',
  readOnly: true,
  emits: [],
  owner: 'B',
});

export const rolesScore = defineOp({
  name: 'roles.score',
  description:
    'Score a role; set active, held or archived. Without criteria the resolver judges C1..C9 (Kev, blind for C1 C2 C3 C4 C9); agent criteria get a Kev second opinion.',
  input: z.object({
    role_id: Id,
    /** Agent-judged C1..C9. Omit to let the resolver judge them (rule -> Kev -> agent -> human). */
    criteria: z.record(Criterion, CriterionScore).optional(),
    facts: z.record(z.string(), z.unknown()).default({}),
    /** The agent's p per supplied criterion (default: ctx.confidence, else 0.75). `confidence` is the MCP tool argument. */
    criteria_p: z.partialRecord(Criterion, Probability).optional(),
    /** Extra brand strings to mask for the blind criteria (products, founders, ticker). */
    brand_terms: z.array(z.string()).optional(),
    /** Criteria carried over from the previous score (profile rescore): no new decisions. */
    rescore: z.boolean().optional(),
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

/** Added (#83): a `dealbreaker` archive whose only hits were work-mode rules, re-checked against the current profile. */
export const ReevaluatedRole = z.object({
  role_id: Id,
  /** The work-mode hits that archived it (latest score). */
  old_hits: z.array(z.string()),
  /** Hits under the current profile (empty = it now passes the filters). */
  hits: z.array(z.string()),
  verify: z.array(z.string()),
  passes: z.boolean(),
  total: z.number().int(),
  band: Band,
  /** The Needs-you decision queued to restore it (null on a dry run, or when not queued). */
  decision_id: Id.nullable(),
  /** Why no decision was queued: `fails`, `below_threshold`, `pending` (one is already waiting), `dry_run`. */
  skipped: z.enum(['fails', 'below_threshold', 'pending', 'dry_run']).nullable(),
});

export const rolesReevaluateFilters = defineOp({
  name: 'roles.reevaluate_filters',
  description:
    'Re-check dealbreaker archives whose only hits were work-mode rules against the current profile; queue a Needs-you restore decision (rescore) per role that now passes. Never restores on its own.',
  input: z.object({
    /** List what would be queued; write nothing. */
    dry_run: z.boolean().optional(),
    /** Limit to these roles (default: every `dealbreaker` archive). */
    role_ids: z.array(Id).optional(),
  }),
  output: z.object({ items: z.array(ReevaluatedRole), queued: z.number().int() }),
  impact: 'low',
  emits: [],
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

/** Added (#54): the documents a fact check covers. */
const FactDoc = z.enum(['resume', 'cover_letter', 'answers']);
/** An unsupported claim for the user; `decision_id` = its `apply.fact_check` decision in Needs you. */
const FactNeedsYou = z.object({
  doc: FactDoc,
  kind: z.string(),
  claim: z.string(),
  line: z.string(),
  decision_id: Id.optional(),
});

export const applyTailor = defineOp({
  name: 'apply.tailor',
  description: 'Write the tailored package and move the role to draft-ready.',
  input: z.object({
    role_id: Id,
    resume_md: z.string().min(1),
    cover_letter_md: z.string().min(1),
    fit_map_md: z.string().min(1),
  }),
  output: z.object({
    application: Application,
    /**
     * Added (#38): the fact check against the sources (kept resume text + confirmed Story). Numbers, years,
     * dates, degrees, and the resume's role headings not in the sources reject the op (invalid_input, the
     * list in `issues`); a title or employer named in prose that the sources lack is kept here as needs-you
     * (also listed in the fit map).
     */
    fact_check: z
      .object({
        checked: z.number().int().min(0),
        needs_you: z.array(FactNeedsYou.extend({ doc: z.enum(['resume', 'cover_letter']) })),
      })
      .default({ checked: 0, needs_you: [] }),
  }),
  impact: 'low',
  emits: ['application_tailored', 'role_moved', 'role_promoted'],
  owner: 'B',
});

/** A portal question as the fill skill classified it (#42). */
const FillQuestion = z
  .object({
    question: z.string().min(1),
    /** autofill: identity fields and uploads; standard: saved Application defaults; written: drafted. Default written. */
    kind: z.enum(FILL_KINDS).default('written'),
    /** autofill / standard: which field (STANDARD_FIELDS / AUTOFILL_FIELDS); `other` = by question. */
    field: z.string().optional(),
    /** standard `work_authorization` / `relocation`: the country the question asks about. */
    country: z.string().optional(),
    /** written: the drafted answer. standard: only used when nothing is saved (shown as a suggestion). */
    answer: z.string().default(''),
    /** The drafter's confidence in a written answer; below the policy's second-opinion threshold it needs you. */
    confidence: Probability.optional(),
    /** The drafter's own flag: a legal or personal question with no saved default. Needs `reason`. */
    needs_human: z.boolean().default(false),
    reason: z.string().optional(),
  })
  .refine((a) => !a.needs_human || !!a.reason?.trim(), { message: 'needs_human needs a one-line reason', path: ['reason'] });

const FilledAnswer = z.object({
  question: z.string(),
  kind: z.enum(FILL_KINDS),
  field: z.string().optional(),
  answer: z.string(),
  needs_human: z.boolean(),
  /** One line: why it needs you ("no saved answer for relocation to Canada"). */
  reason: z.string().optional(),
});

export const applyFill = defineOp({
  name: 'apply.fill',
  description:
    'Write answers to the real portal questions: identity and upload fields listed as portal fills, standard questions from the saved Application defaults, written answers fact-checked; only what needs the user is flagged, each with a reason.',
  input: z.object({
    role_id: Id,
    portal_url: z.string().url().optional(),
    answers: z.array(FillQuestion),
  }),
  output: z.object({
    application: Application,
    /** Added (#42): every question as filed, needs-you first. */
    answers: z.array(FilledAnswer).default([]),
    counts: z
      .object({
        needs_you: z.number().int().min(0),
        written: z.number().int().min(0),
        standard: z.number().int().min(0),
        autofill: z.number().int().min(0),
      })
      .default({ needs_you: 0, written: 0, standard: 0, autofill: 0 }),
    /** Added (#42, #54): unsupported claims in written answers, each queued as an `apply.fact_check` decision. */
    fact_check: z
      .object({ checked: z.number().int().min(0), needs_you: z.array(FactNeedsYou.extend({ doc: z.literal('answers') })) })
      .default({ checked: 0, needs_you: [] }),
  }),
  impact: 'low',
  emits: [],
  owner: 'B',
});

/**
 * Added (#54): apply the user's call on an unsupported claim (`apply.fact_check` decision action):
 * `keep` leaves the document, `remove` drops the line that states it, any other text replaces that line.
 */
export const applyResolveClaim = defineOp({
  name: 'apply.resolve_claim',
  description: 'Keep, remove or rewrite the line of a tailored document or answer that states an unsupported claim.',
  input: z.object({
    role_id: Id,
    doc: FactDoc,
    /** The document line the claim is on (as the fact check reported it). */
    line: z.string().min(1),
    /** `keep`, `remove`, or the replacement text for the line. */
    value: z.string().min(1),
  }),
  output: z.object({ changed: z.boolean(), path: VaultPath.nullable() }),
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

/** Added (#37): one candidate address for a contact, ranked by the company's learned format. */
export const EmailCandidate = z.object({
  email: z.string().email(),
  /** `first.last`, `flast`, `first`, `firstl`, `f.last`, `last`, or `provider`. */
  pattern: z.string(),
  p: Probability,
});
export type EmailCandidate = z.infer<typeof EmailCandidate>;

/**
 * Added (#37): find or estimate a contact's email. Known addresses first (the contact's own, then `hints`
 * the agent found in Gmail, LinkedIn contact info or public pages); else the engine learns the company's
 * address format from addresses seen at its domain (known contacts, JD, dossier, hints), checks the
 * domain's MX record (no SMTP probing) and ranks candidates. The top pick is a `people.email` decision:
 * confident -> stored as confirmed; otherwise stored as an unconfirmed guess and queued in Needs you with
 * the alternatives. `value` = a human's pick (decision action `$value`): stored with confidence 1.
 */
export const peopleFindEmail = defineOp({
  name: 'people.find_email',
  description:
    "Find or estimate a contact's email: known addresses (hints from Gmail, LinkedIn, public pages), else the company's address pattern with a confidence. Low confidence goes to Needs you.",
  input: z.object({
    contact_id: Id,
    /** The role the email is for (JD + dossier are evidence). Default: the contact's latest role link. */
    role_id: Id.optional(),
    /** Addresses the agent saw (read-only): Gmail threads and signatures, LinkedIn contact info, public pages. */
    hints: z
      .array(
        z.object({
          email: z.string().email(),
          /** Whose address it is, when known (any person at the company teaches the format). */
          name: z.string().min(1).max(120).nullable().optional(),
          source: EmailSource.extract(['gmail', 'linkedin', 'public']),
        }),
      )
      .max(50)
      .optional(),
    /** The company's email domain when the company row has none (e.g. from the dossier or a team page). */
    domain: z
      .string()
      .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i)
      .optional(),
    /** The address to use: a human's pick from Needs you (`$value`) or a manual entry. */
    value: z.string().min(1).optional(),
  }),
  output: z.object({
    contact: Contact,
    email: z.string().email().nullable(),
    source: EmailSource.nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    /** True when the address goes into a Gmail draft's To. */
    confirmed: z.boolean(),
    domain: z.string().nullable(),
    /** MX record found for the domain; null = not checked or the lookup failed. */
    mx: z.boolean().nullable(),
    /** The learned format (null: no examples, priors only). */
    pattern: z.string().nullable(),
    candidates: z.array(EmailCandidate),
    decision_id: Id.nullable(),
    outcome: PolicyOutcome.nullable(),
    /** Why there is no usable address (no domain, unconfirmed guess, ...); null when `confirmed`. */
    reason: z.string().nullable(),
  }),
  impact: 'low',
  emits: [],
  owner: 'H',
});

/**
 * Added (#37): who a Gmail draft goes to. `email` is set only when the address is confirmed or at the
 * policy threshold; otherwise To stays empty and `reason` says why.
 */
export const DraftRecipient = z.object({
  contact_id: Id,
  name: z.string(),
  email: z.string().email().nullable(),
  email_source: EmailSource.nullable(),
  email_confidence: z.number().min(0).max(1).nullable(),
  /** The best address on file even when it is not used (an unconfirmed guess). */
  guess: z.string().email().nullable(),
  reason: z.string().nullable(),
});
export type DraftRecipient = z.infer<typeof DraftRecipient>;

// ---------------------------------------------------------------- outreach (H)

export const outreachDraft = defineOp({
  name: 'outreach.draft',
  description: 'Write an outreach draft (Hook, Proof, Ask, optional sign-off) to the vault.',
  input: z.object({
    contact_id: Id,
    role_id: Id,
    tier: ContactTier,
    hook: z.string().min(1),
    proof: z.string().min(1),
    ask: z.string().min(1),
    subject: z.string().optional(),
    /** Added (outreach voice): sign-off in the user's voice. Default: Voice `signoff`, else "Thanks," + first name. */
    signoff: z.string().min(1).optional(),
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
    /** Added (outreach voice): the stored sign-off (or the default one). */
    signoff: z.string(),
    /** Added (outreach voice): the Gmail body as a natural email (greeting, Hook, Proof, Ask, sign-off). */
    body: z.string(),
    /** One per OUTREACH_TONES entry, same order. */
    variants: z.array(DraftText).length(OUTREACH_TONES.length),
    /** Added (#37): the Gmail draft's To (the contact, or the mutual for bridge drafts). */
    to: DraftRecipient.nullable().default(null),
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
  /** Added (#37): `to` = the address the draft was created with (null: no To, `to_reason` says why). */
  output: z.object({
    outreach: Outreach,
    gmail_draft_id: z.string(),
    to: z.string().email().nullable().default(null),
    to_reason: z.string().nullable().default(null),
  }),
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
 * The single entry point for starting a skill run (#30): a human or schedule run is `queued` and the
 * run queue (`runs.dispatch`) launches the configured headless runner (`config.runner`). An agent's own
 * run is `running` at once and never launched. A second run for the same skill and scope (role, company
 * for research, contact, outreach) is not created: the active one is returned with `deduped: true`.
 * A `connect` run's `summary_json.outreach_id` names the draft it wrote (or, with `outreach_id`, the
 * draft it puts in Gmail).
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
    /** Added (#30): the run that caused this one (pipeline rules, schedules). Kept as `summary_json.triggered_by`. */
    triggered_by: Id.optional(),
    /**
     * Added (#29): the schedule this run is for (`pp run <skill> --schedule`, the `pp up` catch-up). Its
     * skill must be the schedule's (`SCHEDULE_SKILL`). Kept as `summary_json.schedule`.
     */
    schedule: ScheduleKey.optional(),
    /**
     * Added (#39): an agent asks for a queued headless run instead of doing the skill's work itself (the Ask
     * panel delegates). Ignored for a human or schedule (always queued). Kept as `summary_json.actor: "ask"`.
     */
    queue: z.boolean().optional(),
  }),
  /** `deduped` (#30): an active run for the same skill and scope already existed; `run` is that run. */
  output: z.object({ run: Run, deduped: z.boolean().optional() }),
  impact: 'low',
  emits: ['run_started'],
  owner: 'B',
});

/**
 * Added (#30): the run queue's dispatcher. Launches queued runs oldest first, up to
 * `config.runs.max_concurrent` running at once, never two for the same skill and scope. `runs.start`
 * and `runs.finish` call it; `pp up` and `pp drain` call it too.
 */
export const runsDispatch = defineOp({
  name: 'runs.dispatch',
  description: 'Launch queued skill runs, up to the concurrency limit.',
  input: z.object({}),
  output: z.object({ launched: z.array(Id), queued: z.number().int().min(0), running: z.number().int().min(0) }),
  impact: 'low',
  emits: [],
  owner: 'B',
});

/**
 * Added in Wave 2 (lane B): close a run started with runs.start (a `queued` or `running` run). Since #30
 * it also applies the pipeline rules (config `pipeline`): the runs it queues are listed in
 * `summary_json.triggered`.
 */
export const runsFinish = defineOp({
  name: 'runs.finish',
  description: 'Close a skill run started with runs.start.',
  input: z.object({
    run_id: Id,
    status: RunStatus.exclude(['queued', 'running']),
    summary: z.record(z.string(), z.unknown()).optional(),
    note: z.string().optional(),
  }),
  output: z.object({ run: Run }),
  impact: 'low',
  emits: ['run_finished'],
  owner: 'B',
});

/**
 * Added (#29): each schedule with its spec, next local fire time, last scheduled run and OS job state
 * (`unknown` where the process has no view of the OS jobs). Settings and `pp schedules status` show it.
 */
export const ScheduleStatus = z.object({
  key: ScheduleKey,
  skill: Skill,
  spec: ScheduleSpec,
  on: z.boolean(),
  next_run: IsoTimestamp.nullable(),
  last_run: Run.nullable(),
  job: ScheduleJobState,
});
export type ScheduleStatus = z.infer<typeof ScheduleStatus>;

export const schedulesStatus = defineOp({
  name: 'schedules.status',
  description: 'Schedules: spec, next run, last scheduled run, OS job state.',
  input: z.object({}),
  output: z.object({ items: z.array(ScheduleStatus) }),
  impact: 'low',
  readOnly: true,
  emits: [],
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
        /** `not_installed`: Kev is not in PP_HOME and does not answer (`pp kev install`). */
        status: z.enum(['ok', 'slow', 'down', 'not_installed']),
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
  'profile.set_defaults': profileSetDefaults,
  'profile.learn': profileLearn,
  'onboard.start': onboardStart,
  'onboard.state': onboardState,
  'onboard.samples': onboardSamples,
  'onboard.ingest_resume': onboardIngestResume,
  'onboard.answer': onboardAnswer,
  'onboard.calibrate': onboardCalibrate,
  'onboard.confirm': onboardConfirm,
  'onboard.extract': onboardExtract,
  'onboard.propose_questions': onboardProposeQuestions,
  'roles.add': rolesAdd,
  'scout.watchlist_scan': scoutWatchlistScan,
  'roles.score': rolesScore,
  'roles.reevaluate_filters': rolesReevaluateFilters,
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
  'apply.resolve_claim': applyResolveClaim,
  'apply.mark_submitted': applyMarkSubmitted,
  'people.find': peopleFind,
  'people.link': peopleLink,
  'people.classify': peopleClassify,
  'people.find_email': peopleFindEmail,
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
  'runs.dispatch': runsDispatch,
  'schedules.status': schedulesStatus,
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
