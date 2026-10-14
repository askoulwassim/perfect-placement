import { z } from 'zod';
import {
  Application,
  BridgeTie,
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
  Backend,
  Band,
  ConnectFallback,
  ConnectPath,
  ContactDegree,
  ContactRole,
  ContactTier,
  Criterion,
  DecisionKind,
  DecisionStatus,
  EmailCheckResult,
  EmailDomainCheck,
  EmailEvidenceKind,
  EmailRisk,
  EmailSource,
  Freshness,
  InboxClass,
  PolicyOutcome,
  ProfileComponentKey,
  RoleSource,
  RoleStatus,
  RunErrorCode,
  RunStatus,
  Skill,
  SubjectType,
  Workplace,
} from '../enums.js';
import { PolicyConfig, ROUTABLE_BACKENDS, ScheduleSpec } from '../policy.js';
import { CriterionScore, Id, IsoTimestamp, Probability, VaultPath } from '../primitives.js';
import { ApplicationDefaults, FILL_KINDS, StoryContact } from '../profile-data.js';
import { ScheduleJobState, ScheduleKey } from '../schedules.js';
import { RENDER_DOCS, RENDER_FORMATS } from '../vault.js';
import { Ack, defineOp, Page } from './define.js';

/*
 * The ops registry. Every write in the system is one of these.
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

/**
 * Added (#124): save the user's identity and contact (Story `contact`: full name, preferred first name, email,
 * phone, city, LinkedIn) from You. Merged into what is saved; an empty string clears a field. A human edit
 * applies at once as profile v+1 (a Story diff: an asset, never rescored, never a hard exclusion); from any
 * other actor the diff goes through the resolver like every Story diff. An email must look like one.
 */
export const IdentityInput = z.object({
  full_name: z.string().max(120).optional(),
  preferred_name: z.string().max(60).optional(),
  email: z
    .string()
    .max(200)
    .refine((v) => !v.trim() || z.email().safeParse(v.trim()).success, { message: 'not an email address' })
    .optional(),
  phone: z.string().max(40).optional(),
  city: z.string().max(120).optional(),
  linkedin: z.string().max(200).optional(),
});
export const profileSetIdentity = defineOp({
  name: 'profile.set_identity',
  description:
    'Save your name, preferred first name, email, phone, city and LinkedIn (Story contact); Fill uses them for the identity fields.',
  input: z.object({ contact: IdentityInput }),
  output: z.object({ version: ProfileVersion.nullable(), contact: StoryContact }),
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
      /**
       * `list` (#75): free entries kept as chips (Enter adds one); answered with a string[] (a comma
       * separated string is still accepted).
       */
      answer_type: z.enum(['chips', 'multi_chips', 'slider', 'text', 'list']),
      options: z.array(z.string()).optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      /** Slider step (Wave 2, lane D request). */
      step: z.number().optional(),
      /** Added (#73): what a slider measures, so the UI formats it (`money`: `$212.5k`; `percent`: `40%`). */
      unit: z.enum(['money', 'percent']).optional(),
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
      /**
       * Added (#74): free entry is allowed besides `options` (chips / multi_chips): the UI shows an Other
       * chip with a text field. Persona-dependent questions (Craft functions, level, titles; Domain;
       * Growth scope) carry it; their options come from the resume, the static list only as a fallback.
       */
      other: z.boolean().optional(),
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
    /**
     * Added (#76): with `skip`, skip every remaining question of this question's component (the Voice step's
     * Skip). Skipping Voice stores the neutral default style (`VOICE_DEFAULT_STYLE`) when none is set.
     */
    skip_component: z.boolean().optional(),
  }),
  output: OnboardState,
  impact: 'low',
  emits: [],
  owner: 'E',
});

const OptionList = z.array(z.string().trim().min(1).max(60)).min(2).max(12);
/** Added (#74): persona-dependent interview options (see `onboard.extract`). */
export const OnboardOptions = z.object({
  persona: z.string().trim().min(1).max(40).optional(),
  functions: OptionList.optional(),
  levels: OptionList.optional(),
  titles: OptionList.optional(),
  domains: OptionList.optional(),
  scopes: OptionList.optional(),
});
export type OnboardOptions = z.infer<typeof OnboardOptions>;

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
    /**
     * Added (#74): the persona-dependent answer options the agent generated from the resume (judgment, not
     * facts): `functions`, `levels`, `titles` (typical job titles), `domains`, `scopes` (Growth scope
     * ceilings), 2 to 12 short options each, plus a `persona` name ("sales", "product"). Kept with the
     * onboarding session; they replace the instant preview's options and the static fallback lists. The
     * interview always allows free entry (Other) besides them. Ignored once onboarding is done.
     */
    options: OnboardOptions.optional(),
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

/**
 * Added (#76): the Voice a `voice` run (You > Voice > Learn voice) learned from the user's own writing, with
 * consent: recent sent Gmail messages (read-only) and, when `config.linkedin.mode` is `live`, their LinkedIn
 * posts (read-only, Claude in Chrome). Never auto-applied: it becomes a pending Voice diff only a human can
 * accept (`profile.apply_diff` from any other actor is `human_only`). Samples are the user's own words, short,
 * with other people's names, addresses, links and quoted content removed; the op refuses a sample with an
 * email address, phone number, URL, @handle, a greeting to someone by name, or an em dash. New samples are
 * added after the kept ones, up to VOICE_SAMPLES_MAX.
 */
export const profileProposeVoice = defineOp({
  name: 'profile.propose_voice',
  description:
    "Propose the Voice learned from the user's own sent emails and LinkedIn posts (style, traits, up to 3 short anonymized samples) as a pending diff for the user to accept. Never applies it.",
  input: z.object({
    style: z.string().trim().min(1).max(40).optional(),
    traits: z.array(z.string().trim().min(1).max(120)).max(6).default([]),
    samples: z.array(z.string().trim().min(1)).max(3).default([]),
    /** How much was read (counts only). */
    sources: z.object({ gmail_sent: z.number().int().min(0).default(0), linkedin_posts: z.number().int().min(0).default(0) }),
  }),
  output: z.object({
    /** Null when nothing would change. */
    diff: ProfileDiff.nullable(),
    /** Samples not added because Voice already holds VOICE_SAMPLES_MAX. */
    dropped: z.number().int().min(0).default(0),
  }),
  impact: 'low',
  emits: ['profile_diff_proposed'],
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

/**
 * Added (#74): the scout's query ingredients from the profile, persona-aware: `titles` are the title
 * variations (Craft `titles` first, then each Craft function's typical titles at the Craft level and one
 * level up), so a sales profile scouts sales roles; `domains` the ranked Domain; `locations` Work mode.
 */
export const scoutPlan = defineOp({
  name: 'scout.plan',
  description:
    "The profile's scout query ingredients: title variations from Craft (titles, functions, level; persona-aware, not product-only), ranked domains and work locations.",
  input: z.object({}),
  output: z.object({
    persona: z.string().nullable(),
    titles: z.array(z.string()),
    domains: z.array(z.string()),
    locations: z.array(z.string()),
  }),
  impact: 'low',
  readOnly: true,
  emits: [],
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
  input: z.object({
    role_ids: z.array(Id).optional(),
    all_in_scope: z.boolean().optional(),
    /**
     * Pipeline pre-check before scoring (#77): hard closed evidence from the ATS API or the page closes the
     * role on a rule decision without asking a backend; only an inconclusive check asks the resolver.
     */
    precheck: z.boolean().optional(),
  }),
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

/** Added (#78): which no-contact fallback Connect used for a role, and why. */
export const ConnectState = z.object({
  fallback: ConnectFallback,
  reason: z.string().nullable(),
  /** The fallback contact (team inbox or cold leader); null when skipped. */
  contact_id: Id.nullable(),
  at: IsoTimestamp,
});
export type ConnectState = z.infer<typeof ConnectState>;

/** Added (#98): one way to reach a 2nd-degree hiring-team target, with its one-line reason. */
export const ConnectPathOption = z.object({
  path: ConnectPath,
  /** Who the note goes to: the target (direct) or the mutual (bridge). */
  contact_id: Id,
  name: z.string(),
  /** The tier the draft uses: `cold_hiring` for a direct note, `bridge` for an intro. */
  tier: ContactTier,
  score: z.number(),
  /** One line, e.g. "Hiring team · Email likely" or "Other company · No email". */
  reason: z.string(),
  /** A bridge to a mutual with no email while the target is reachable: never drafted. */
  blocked: z.boolean(),
});
export type ConnectPathOption = z.infer<typeof ConnectPathOption>;

/** Added (#98): the ranked paths for a target; `options` lists the recommended one first. */
export const ConnectPaths = z.object({
  recommended: ConnectPath,
  /** The user's pick when set and allowed, else `recommended`. Drafts follow it. */
  chosen: ConnectPath,
  options: z.array(ConnectPathOption),
});
export type ConnectPaths = z.infer<typeof ConnectPaths>;

/**
 * Added (#131): one node of a role's people graph. `me` (the user), `company` (the role's company), or a
 * `person`: every contact linked to the role plus every mutual named by a link's `via_contact_id` (a mutual
 * needs no role link of its own). `recommended` marks the nodes on the path the primary action drafts.
 */
export const RoleGraphNode = z.object({
  id: z.string(),
  kind: z.enum(['me', 'company', 'person']),
  contact_id: Id.optional(),
  name: z.string(),
  degree: ContactDegree.optional(),
  tier: ContactTier.optional(),
  /** On the team side: the hiring team (`is_hiring_team`) or, #132, the link's `team_side`. */
  team_side: z.boolean().optional(),
  recommended: z.boolean().optional(),
});
export type RoleGraphNode = z.infer<typeof RoleGraphNode>;

/**
 * Added (#131): a relationship. `knows`: me -> a 1st-degree person; `via`: mutual -> 2nd-degree target;
 * `works_at` / `hiring` / `team`: person -> company (`hiring` for the hiring team; #132 `team` for a team-side
 * person not on the hiring team).
 */
export const RoleGraphEdge = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(['knows', 'via', 'works_at', 'hiring', 'team']),
  degree: ContactDegree.optional(),
  recommended: z.boolean().optional(),
});
export type RoleGraphEdge = z.infer<typeof RoleGraphEdge>;

/** Added (#131): the people graph for a role, built by the engine. Node ids are unique. */
export const RoleGraph = z.object({ nodes: z.array(RoleGraphNode), edges: z.array(RoleGraphEdge) });
export type RoleGraph = z.infer<typeof RoleGraph>;

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
    /** `paths` (#98): direct vs bridge for a 2nd-degree hiring-team (or #132 team-side) target with a mutual, else null. */
    contacts: z.array(z.object({ contact: Contact, link: ContactLink, paths: ConnectPaths.nullable().default(null) })),
    md_body: z.string().nullable(),
    /** Added (#78): the no-contact fallback Connect last used for this role (null: none). */
    connect: ConnectState.nullable().default(null),
    /** Added (#131): me, the company and every person (mutuals included) with their relationships. */
    graph: RoleGraph.default({ nodes: [], edges: [] }),
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
  input: z.object({
    company_id: Id,
    markdown: z.string().min(1),
    /** Added (#105): the role the research is for (at this company). An active or held role is picked: -> on-deck, `role_picked`. */
    role_id: Id.optional(),
  }),
  output: z.object({ md_path: VaultPath }),
  impact: 'low',
  emits: ['role_moved', 'role_picked', 'role_promoted'],
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
  emits: ['application_tailored', 'role_moved', 'role_picked', 'role_promoted'],
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

/**
 * Added (#81): who saved an answer. `fill`: a fill run; `ask`: the Ask panel (answers given in Ask for the role in
 * focus, merged into that role's Answers and shown as "Saved from Ask").
 */
export const ANSWER_SOURCES = ['fill', 'ask'] as const;
export const AnswerSource = z.enum(ANSWER_SOURCES);
export type AnswerSource = z.infer<typeof AnswerSource>;

const FilledAnswer = z.object({
  question: z.string(),
  kind: z.enum(FILL_KINDS),
  field: z.string().optional(),
  answer: z.string(),
  needs_human: z.boolean(),
  /** One line: why it needs you ("no saved answer for relocation to Canada"). */
  reason: z.string().optional(),
  /** Added (#81): who saved it. Absent on answers filed before #81 (read as `fill`). */
  source: AnswerSource.optional(),
});

export const applyFill = defineOp({
  name: 'apply.fill',
  description:
    'Write answers to the real portal questions: identity and upload fields listed as portal fills, standard questions from the saved Application defaults, written answers fact-checked; only what needs the user is flagged, each with a reason.',
  input: z.object({
    role_id: Id,
    portal_url: z.string().url().optional(),
    answers: z.array(FillQuestion),
    /**
     * Added (#81): who is saving. `fill` (default): the answers replace the file, keeping earlier Ask answers to
     * questions this call does not answer. `ask`: merged into the saved answers (same question replaced, others
     * kept). An Ask session's MCP server sets `ask` when it is absent.
     */
    source: AnswerSource.default('fill'),
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
 * Added (#81): the paste fallback for portals a fill run cannot read (questions on other tabs or steps, a
 * login wall). Saves the pasted questions to `applications/<role_id>/questions.md` (package path `questions`)
 * and queues a fill run that answers them instead of reading the portal (`run: false` saves only).
 */
export const applySetQuestions = defineOp({
  name: 'apply.set_questions',
  description:
    'Save portal questions the user pasted for a draft-ready role and queue a fill run that answers them instead of reading the portal.',
  input: z.object({
    role_id: Id,
    /** The questions as pasted, one or more per line; blank lines are dropped. */
    questions_text: z.string().trim().min(1).max(20000),
    /** Queue the fill run (default true). */
    run: z.boolean().default(true),
  }),
  output: z.object({
    application: Application,
    path: VaultPath,
    /** Non-empty lines saved. */
    count: z.number().int().min(1),
    /** The queued (or already active) fill run; null with `run: false`. */
    run: Run.nullable(),
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

/**
 * Added (#78): skip Connect for a role so it never stalls (no usable contact, or the user's call): the
 * application moves from `connect` to `fill`. Already past Connect: a no-op (`skipped: false`).
 */
export const applySkipConnect = defineOp({
  name: 'apply.skip_connect',
  description: 'Skip Connect for a role (no usable contact, or the user chose to): the application moves from Connect to Fill.',
  input: z.object({ role_id: Id, reason: z.string().min(1).max(200) }),
  output: z.object({ application: Application, skipped: z.boolean() }),
  impact: 'low',
  emits: [],
  owner: 'B',
});

/**
 * Added (#106): render the tailored resume and cover letter (markdown) to PDF and DOCX with a clean,
 * ATS-friendly template (pure JS). Files go to the vault at `files/<role_id>/<doc>.<format>` and are recorded
 * on the application (`package_paths_json.resume_pdf`, ...); the UI downloads them through `GET /api/files`,
 * the fill assist uploads the PDFs (`abs_path`). Rendering again overwrites (the files follow the markdown).
 */
export const applyRenderDocuments = defineOp({
  name: 'apply.render_documents',
  description:
    'Render the tailored resume and cover letter to PDF and DOCX (files/<role_id>/), record them on the application, and return their paths for download or upload.',
  input: z.object({
    role_id: Id,
    formats: z.array(z.enum(RENDER_FORMATS)).min(1).default(['pdf', 'docx']),
    docs: z.array(z.enum(RENDER_DOCS)).min(1).default(['resume', 'cover_letter']),
  }),
  output: z.object({
    application: Application,
    files: z.array(
      z.object({
        doc: z.enum(RENDER_DOCS),
        format: z.enum(RENDER_FORMATS),
        /** Vault-relative (download route). */
        path: VaultPath,
        /** Absolute path on this machine (the fill assist uploads it with Claude in Chrome). */
        abs_path: z.string(),
        bytes: z.number().int().min(1),
      }),
    ),
  }),
  impact: 'low',
  emits: [],
  owner: 'B',
});

/**
 * Added (#106): a control label a fill assist must never act on (the whole label: "Submit", "Apply now",
 * "Send application"; a question that merely mentions applying is not one). The fill run has no click tool;
 * `apply.fill_done` refuses a report that says it filled one of these.
 */
export const SUBMIT_LIKE =
  /^(?:review and submit|submit|apply|send|finish|complete)(?:\s+(?:now|application|my application|for this (?:job|role|position)))?\s*[.!>»→]*$/i;
/** Trims before testing: `SUBMIT_LIKE` has no leading or trailing `\s*`, which backtrack quadratically on long runs of spaces (#152). */
export const isSubmitLike = (label: string): boolean => SUBMIT_LIKE.test(label.trim());

/**
 * Added (#106): a fill assist run reports what it did in the portal (uploaded the rendered PDFs, filled the
 * answer fields from Answers, stopped before Submit). Recorded as `application.fill_assist_json`; the Role
 * screen's primary becomes Open portal. A `filled` label that looks like submit / apply / send is refused
 * (`invalid_input`): the human submits.
 */
export const applyFillDone = defineOp({
  name: 'apply.fill_done',
  description:
    'Record a fill assist: the portal is open with the documents uploaded and the answer fields filled, stopped before Submit (the human submits).',
  input: z.object({
    role_id: Id,
    /** Labels of the fields filled (never a submit / apply / send control). */
    filled: z.array(z.string().trim().min(1)).default([]),
    uploaded: z.array(z.enum(RENDER_DOCS)).default([]),
    /** Fields left for the human, each with a one-line reason. */
    skipped: z.array(z.object({ label: z.string().trim().min(1), reason: z.string().trim().min(1) })).default([]),
  }),
  output: z.object({ application: Application }),
  impact: 'low',
  emits: [],
  owner: 'B',
});

// ------------------------------------------------------------------ people (H)

/**
 * Why a people.find run read no LinkedIn (#82). The agent reports the first six; the engine adds `off`
 * and `dry_run` (config), `invalid` (no hint passed the profile URL allowlist) and `not_reported`.
 */
export const LINKEDIN_SKIP_REASONS = [
  'no_browser',
  'signed_out',
  'checkpoint',
  'capped',
  'not_found',
  'error',
  'off',
  'dry_run',
  'invalid',
  'not_reported',
] as const;
export const LinkedInSkipReason = z.enum(LINKEDIN_SKIP_REASONS);
export type LinkedInSkipReason = z.infer<typeof LinkedInSkipReason>;
/** Where people.find's LinkedIn people came from (#82): the agent's Claude in Chrome read, the recorded test adapter, or nothing (off). */
export const LINKEDIN_PROVENANCE = ['agent', 'dry-run', 'off'] as const;
export const LinkedInProvenance = z.enum(LINKEDIN_PROVENANCE);
export type LinkedInProvenance = z.infer<typeof LinkedInProvenance>;

/** One person the connect skill found (JD, team page, the user, or its own LinkedIn read via Claude in Chrome, #82). */
export const PeopleFindHint = z.object({
  name: z.string().min(1),
  headline: z.string().nullable().optional(),
  linkedin_url: z.string().url().nullable().optional(),
  email: z.string().email().nullable().optional(),
  source: z.enum(['jd', 'company_site', 'manual', 'linkedin']),
  /** LinkedIn only: relationship shown on the card (`1` connection, `2` via a mutual, `cold`). Default `cold`. */
  degree: ContactDegree.optional(),
  /** LinkedIn only, degree 2: the 1st-degree mutual this person is reachable through. */
  via: z
    .object({
      name: z.string().min(1),
      headline: z.string().nullable().optional(),
      linkedin_url: z.string().url(),
      /** Added (#98): the mutual's tie to this person (same company, same industry, history). Default none. */
      tie: BridgeTie.optional(),
    })
    .nullable()
    .optional(),
  /** Listed as the hiring team (e.g. "Meet the hiring team" on the posting). people.classify still runs. */
  hiring_team: z.boolean().optional(),
  /**
   * Added (#132, judgment): on the team side though not the hiring team: works at the company or one of its
   * product brands (dossier aliases), in the role's org or an adjacent function (product, design,
   * engineering leadership on that product). Gets ranked direct / bridge paths. Only ever adds.
   */
  team_side: z.boolean().optional(),
  /** Added (#132): the product brand they work under when it differs from the company name. */
  brand: z.string().min(1).max(120).nullable().optional(),
});
export type PeopleFindHint = z.infer<typeof PeopleFindHint>;

export const peopleFind = defineOp({
  name: 'people.find',
  description:
    'Find people for a picked role: the LinkedIn people the agent read (read-only via Claude in Chrome, capped), Gmail and the JD.',
  input: z.object({
    role_id: Id,
    dry_run: z.boolean().optional(),
    /** People the skill found: in the JD, on the company site, named by the user, or on LinkedIn (source `linkedin`). */
    hints: z.array(PeopleFindHint).max(60).optional(),
    /** What the agent's LinkedIn read did (#82): pages opened, or why it read nothing. */
    linkedin: z
      .object({
        pages_opened: z.number().int().min(0).default(0),
        skipped: LinkedInSkipReason.extract(['no_browser', 'signed_out', 'checkpoint', 'capped', 'not_found', 'error']).optional(),
      })
      .optional(),
    /** LinkedIn vanity slug when it differs from the company slug. */
    linkedin_company_slug: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional(),
  }),
  output: z.object({
    found: z.array(z.object({ contact: Contact, link: ContactLink })),
    capped: z.boolean(),
    /** #82: where LinkedIn people came from, how many were kept, and why none were read. */
    linkedin: z
      .object({
        mode: LinkedInProvenance,
        people: z.number().int().min(0),
        rejected: z.number().int().min(0),
        budget_left: z.number().int().min(0),
        reason: LinkedInSkipReason.nullable(),
      })
      .optional(),
  }),
  impact: 'low',
  /** #105: an active or held role is picked first (-> on-deck, `role_picked`); not on `dry_run`. */
  emits: ['contact_found', 'role_moved', 'role_picked', 'role_promoted'],
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

/** Added (#98): pick direct or bridge for a 2nd-degree hiring-team target before drafting. */
export const peopleSetPath = defineOp({
  name: 'people.set_path',
  description:
    'Pick how to reach a 2nd-degree hiring-team contact: a direct note to them or a bridge intro through the mutual (null: back to the ranked default).',
  input: z.object({ contact_id: Id, role_id: Id, path: ConnectPath.nullable() }),
  output: z.object({ link: ContactLink, paths: ConnectPaths }),
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

/**
 * Added (#99): the passive check on one candidate address. No mail server is ever contacted: `domain` is
 * DNS only (MX, else an A record), `risk` comes from vendored lists, `pattern_peers` counts real addresses
 * at the domain (the user's own mail, known contacts, public pages) whose format matches this candidate's,
 * `public_match` = the exact address was seen (a public page or the user's own mail).
 */
export const EmailCheck = z.object({
  domain: EmailDomainCheck,
  risk: EmailRisk,
  pattern_peers: z.number().int().nonnegative(),
  public_match: z.boolean(),
});
export type EmailCheck = z.infer<typeof EmailCheck>;

/** Added (#37): one candidate address for a contact, ranked by the company's learned format. */
export const EmailCandidate = z.object({
  email: z.string().email(),
  /** `first.last`, `flast`, `first`, `firstl`, `f.last`, `last`, or `provider`. */
  pattern: z.string(),
  p: Probability,
  /** Added (#99): the passive check (an exact match or 2+ agreeing peers raise `p`; no MX or invalid drops it). */
  check: EmailCheck.optional(),
});
export type EmailCandidate = z.infer<typeof EmailCandidate>;

/** Added (#99): one piece of pattern evidence (see `people.find_email` `evidence`). */
export const EmailEvidence = z.object({
  kind: EmailEvidenceKind,
  address: z.string().email(),
  /** Where it was seen: `gmail`, or the page (e.g. "team page"). Never a subject or body. */
  source: z.string().min(1).max(80),
  url: z.string().url().optional(),
  /** Whose address it is, when the header or page names them (format inference only; not stored). */
  name: z.string().min(1).max(120).optional(),
});
export type EmailEvidence = z.infer<typeof EmailEvidence>;

/**
 * Added (#37): find or estimate a contact's email. Known addresses first (the contact's own, then `hints`
 * the agent found in Gmail, LinkedIn contact info or public pages); else the engine learns the company's
 * address format from addresses seen at its domain (known contacts, JD, dossier, hints), checks the
 * domain's MX record (no SMTP probing) and ranks candidates. The top pick is a `people.email` decision:
 * #99: each candidate gets a passive `check`; see `EmailCheck` and `evidence`.
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
    /**
     * Added (#99): pattern evidence the agent gathered read-only. `inbox_peer`: an address at the company
     * domain in the user's own Gmail (from / to / cc; `name` = the display name, used to infer the format
     * and never stored); `public_mention`: an address on a public page (`url`). Only the address and its
     * inferred format are kept (on the decision), never a subject or body.
     */
    evidence: z.array(EmailEvidence).max(50).optional(),
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
    /** Added (#99): candidates dropped by the check (invalid syntax, no MX) or found invalid by the user. */
    dropped: z.array(z.string().email()).default([]),
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
 * Added (#99): the user's own check of a candidate address (Needs you **Valid** / **Invalid**, after
 * checking it by hand). Human only. `valid` confirms the address: it resolves the pending `people.email`
 * decision with it (Gmail drafts waiting for the address are queued). `invalid` drops the candidate from
 * the pending decision; the decision stays open while other candidates remain, else it expires and the
 * guess is cleared. Recorded on the decision as `manual_checks[]` with `source: "manual_check"`.
 */
export const peopleEmailChecked = defineOp({
  name: 'people.email_checked',
  description: "Record the user's manual check of a candidate email address: valid confirms it, invalid drops it.",
  input: z.object({ contact_id: Id, address: z.string().email(), result: EmailCheckResult }),
  output: z.object({
    contact: Contact,
    result: EmailCheckResult,
    source: z.literal('manual_check'),
    /** The `people.email` decision the check applied to (null: none was pending). */
    decision_id: Id.nullable(),
    /** True while the decision is still pending (other candidates remain). */
    open: z.boolean(),
    /** Candidates still offered. */
    remaining: z.array(z.string().email()),
    /** True when the contact's address is confirmed (goes into a Gmail draft's To). */
    confirmed: z.boolean(),
  }),
  impact: 'low',
  emits: [],
  owner: 'H',
});

/** Added (#78): an address the agent found for the hiring team (JD, careers page, dossier, company site). */
export const TeamInboxHint = z.object({
  email: z.string().email(),
  /** A named recruiter or talent partner; omitted for a team mailbox (`recruiting@`, `talent@`, `jobs@`). */
  name: z.string().min(1).max(120).optional(),
  source: z.enum(['jd', 'careers', 'dossier', 'company_site']),
  url: z.string().url().optional(),
});
export type TeamInboxHint = z.infer<typeof TeamInboxHint>;

/**
 * Added (#78): the no-contact fallback for a picked role, chosen by the engine in order. With no usable
 * contact (every link `cold_other`, or none): (1) a hiring-team or recruiting address (the agent's
 * `team_inbox` hints plus team mailboxes in the JD and dossier, at the company domain) becomes a contact
 * "Hiring team" (or the named recruiter), `email_source: public`, linked `cold_hiring`; else (2) the
 * likely hiring leader from the dossier (`leader`) becomes a `cold_hiring` contact and `people.find_email`
 * guesses the address (flagged; low confidence goes to Needs you); else (3) Connect is skipped and the
 * application moves to Fill. A role that already has a usable contact returns `fallback: null`.
 */
export const peopleFallback = defineOp({
  name: 'people.fallback',
  description:
    'No usable contact for a picked role: use a hiring-team or recruiting address, else a cold note to the likely hiring leader (guessed email), else skip Connect so the application moves to Fill.',
  input: z.object({
    role_id: Id,
    team_inbox: z.array(TeamInboxHint).max(10).optional(),
    /** The likely hiring leader from the dossier (e.g. the CPO or VP Product). */
    leader: z
      .object({
        name: z.string().min(1).max(120),
        headline: z.string().max(200).nullable().optional(),
        linkedin_url: z.string().url().nullable().optional(),
      })
      .optional(),
    /** The company's email domain when the company row has none. */
    domain: z
      .string()
      .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i)
      .optional(),
    /** Addresses seen at the company (teach the leader's address format), as for people.find_email. */
    email_hints: peopleFindEmail.input.shape.hints,
    /** Why there is no contact (recorded when Connect is skipped). Default "no contacts". */
    reason: z.string().min(1).max(200).optional(),
  }),
  output: z.object({
    fallback: ConnectFallback.nullable(),
    contact: Contact.nullable(),
    link: ContactLink.nullable(),
    /** The leader's address (people.find_email); null for a team inbox or a skip. */
    email: z
      .object({
        email: z.string().email().nullable(),
        confidence: z.number().min(0).max(1).nullable(),
        confirmed: z.boolean(),
        decision_id: Id.nullable(),
        outcome: PolicyOutcome.nullable(),
        reason: z.string().nullable(),
      })
      .nullable(),
    application: Application.nullable(),
    /** Why this fallback (or none) was used. */
    reason: z.string().nullable(),
  }),
  impact: 'low',
  /** #105: an active or held role is picked first (-> on-deck, `role_picked`). */
  emits: ['contact_found', 'role_moved', 'role_picked', 'role_promoted'],
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
  /**
   * Added (#99): the pending `people.email` decision on this address. While set, no Gmail draft is created
   * (the engine queues the Gmail step once the address is confirmed).
   */
  decision_id: Id.nullable().default(null),
  /** Added (#132): the recipient's LinkedIn profile URL (Open profile when there is no email); null when none. */
  linkedin_url: z.string().nullable().default(null),
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
    /** Added (#98): the target a bridge intro is about (`outreach.about_contact_id`); null otherwise. */
    about: Contact.nullable().default(null),
  }),
  impact: 'low',
  readOnly: true,
  emits: [],
  owner: 'H',
});

/** Added in Wave 2 (lane D): drafts for a role (DraftStatusChip per person). */
export const outreachList = defineOp({
  name: 'outreach.list',
  description: 'Outreach drafts for a role, one per recipient (a bridge intro is about its target).',
  input: z.object({ role_id: Id }),
  /** #98: each item names its recipient (`contact_id`) and, for a bridge intro, the target it is about. */
  output: z.object({
    items: z.array(
      Outreach.extend({
        recipient_name: z.string().default(''),
        about_name: z.string().nullable().default(null),
        /** Added (#132): the recipient has no address at all (no Gmail draft until one is confirmed). */
        no_email: z.boolean().default(false),
      }),
    ),
  }),
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
  /**
   * Added (#37): `to` = the address the draft was created with (null: no To, `to_reason` says why).
   * #99: refused (`conflict`) while the recipient's address is a guess waiting in Needs you, unless the
   * agent already made the draft (`gmail_draft_id`: recorded with no To, filled once confirmed). The To
   * used is kept on `outreach.gmail_to`. Recording the same `gmail_draft_id` again on an `in_gmail`
   * draft with no To (the To update step) sets `gmail_to` to the confirmed address. #132: refused
   * (`conflict`) when the recipient has no address at all: never a Gmail draft without To.
   */
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

/**
 * Added (#102): the role a decision is about (subject_type 'role'), so a reviewer can open the posting.
 * `freshness_evidence`: a freshness.closed decision's own evidence, else the role's last freshness check.
 */
export const DecisionSubjectRole = z.object({
  id: Id,
  url: z.string().nullable(),
  last_checked_at: IsoTimestamp.nullable(),
  freshness_evidence: z.string().nullable(),
});
export type DecisionSubjectRole = z.infer<typeof DecisionSubjectRole>;

/** A queued decision; `subject_role` is set when the subject is a role that exists (#102). */
export const QueuedDecision = Decision.extend({ subject_role: DecisionSubjectRole.optional() });
export type QueuedDecision = z.infer<typeof QueuedDecision>;

/**
 * Added (#103): one row of the auto stream. Members share kind and run (or, with no run id, kind and a
 * time window), and subject unless the kind is a batch kind (AUTO_BATCH_KINDS), where subject_id is null
 * when members span subjects. `decision_ids` newest first; `undoable_ids` the members `decisions.undo_group`
 * would undo now. `backend`: the backend that answered most members (a strict majority), else `mixed`.
 * `total`: for a `roles.criterion` group, the role's score total from that scoring, else null.
 */
export const AutoGroup = z.object({
  id: z.string(),
  kind: DecisionKind,
  subject_type: SubjectType,
  subject_id: z.string().nullable(),
  run_id: Id.nullable(),
  decision_ids: z.array(Id),
  count: z.number().int().positive(),
  backend: z.union([Backend, z.literal('mixed')]),
  first_ts: IsoTimestamp,
  ts: IsoTimestamp,
  undoable_ids: z.array(Id),
  undone_count: z.number().int().nonnegative(),
  total: z.number().nullable(),
});
export type AutoGroup = z.infer<typeof AutoGroup>;

export const decisionsQueue = defineOp({
  name: 'decisions.queue',
  description:
    'The Needs-you queue plus recent auto decisions. Role decisions carry subject_role (url, last check). auto_groups: recent_auto grouped per subject and run (one row per role per score run).',
  input: z.object({
    status: z.array(DecisionStatus).optional(),
    include_auto_since: IsoTimestamp.optional(),
  }),
  output: z.object({ pending: z.array(QueuedDecision), recent_auto: z.array(QueuedDecision), auto_groups: z.array(AutoGroup) }),
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

/** Added (#103): undo every undoable member of an auto-stream group in one call; the rest are skipped with a reason. */
export const decisionsUndoGroup = defineOp({
  name: 'decisions.undo_group',
  description: 'Undo several auto + undo decisions (an auto-stream group) inside their windows. Skips the ones that cannot be undone.',
  input: z.object({ decision_ids: z.array(Id).min(1).max(500) }),
  output: z.object({
    undone: z.array(Decision),
    skipped: z.array(z.object({ decision_id: Id, reason: z.string() })),
  }),
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
     * #99: refused while the recipient's address is a guess waiting in Needs you. For an `in_gmail` draft
     * with no To (`gmail_to` null) and a confirmed address, the run is the To update step instead
     * (`summary_json.step: "gmail_to"`): the agent sets the draft's To with the connector's update tool.
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
    /**
     * Added (#106): `fill` only. The fill assist: after the answers, the run uploads the rendered resume and cover
     * letter PDFs and fills the answer fields in the portal tab (Claude in Chrome `file_upload` + `form_input`),
     * stops before Submit and reports with `apply.fill_done`. Without it a fill run only reads the portal. Kept as
     * `summary_json.assist`.
     */
    assist: z.boolean().optional(),
    /**
     * Added (#122): the failed run this one retries (engine use: `runs.finish` re-queues a run that ended
     * `error_code: "connector_unavailable"` once). Same skill; that run must be `error` and not retried yet. Kept as
     * `summary_json.retry_of` with `attempt` (the first try is 1) and `not_before` (the dispatcher waits until then);
     * the retried run gets `summary_json.retried` = this run's id.
     */
    retry_of: Id.optional(),
  }),
  /** `deduped` (#30): an active run for the same skill and scope already existed; `run` is that run. */
  output: z.object({ run: Run, deduped: z.boolean().optional() }),
  impact: 'low',
  /** #105: `research`, `tailor` or `connect` for an active or held role picks it first (-> on-deck, `role_picked`). */
  emits: ['run_started', 'role_moved', 'role_picked', 'role_promoted'],
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
/** Added (#107): a Claude in Chrome tab id (`tabs_context_mcp`, `tabs_create_mcp`). */
export const ChromeTabId = z.number().int().nonnegative();
export type ChromeTabId = z.infer<typeof ChromeTabId>;

/**
 * Added (#107): the Chrome tabs a run used, as it reported them on `runs.finish` (kept as `summary_json.tabs`).
 * `opened`: every tab the run used (the session's tab it reused, or one it created); `closed`: the ones it closed
 * (`tabs_close_mcp`); `left_open`: only the fill assist's portal tab (`portal`), for the human to submit.
 */
export const RunTabs = z.object({
  opened: z.array(ChromeTabId).default([]),
  closed: z.array(ChromeTabId).default([]),
  left_open: z.array(ChromeTabId).default([]),
  portal: ChromeTabId.optional(),
});
export type RunTabs = z.infer<typeof RunTabs>;

export const runsFinish = defineOp({
  name: 'runs.finish',
  description: 'Close a skill run started with runs.start.',
  input: z.object({
    run_id: Id,
    status: RunStatus.exclude(['queued', 'running']),
    summary: z.record(z.string(), z.unknown()).optional(),
    note: z.string().optional(),
    /**
     * Added (#107): the Chrome tabs this run used and closed (`connect`, `fill`, `voice` only). Stored as
     * `summary_json.tabs`; a `summary.tabs` object is read the same way. Only a fill assist run may leave a tab
     * open, and only its `portal` tab.
     */
    tabs: RunTabs.optional(),
    /**
     * Added (#122): why the run failed, as a code (status `error`). `connector_unavailable`: a connector tool the
     * skill is granted (Gmail, Claude in Chrome) is missing from the session; the engine retries the run once
     * after a short delay. Kept as `summary_json.error_code`. `stalled` (#121): set by the engine when a run passes
     * its wall-clock cap.
     */
    error_code: RunErrorCode.optional(),
    /** Added (#122): the one-line error (kept as `summary_json.error`, over `summary.error`). */
    error: z.string().optional(),
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

/** Every op, keyed by name. */
export const OPS = {
  'profile.get': profileGet,
  'profile.history': profileHistory,
  'profile.propose_diff': profileProposeDiff,
  'profile.apply_diff': profileApplyDiff,
  'profile.reject_diff': profileRejectDiff,
  'profile.undo_diff': profileUndoDiff,
  'profile.set_defaults': profileSetDefaults,
  'profile.set_identity': profileSetIdentity,
  'profile.learn': profileLearn,
  'profile.propose_voice': profileProposeVoice,
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
  'scout.plan': scoutPlan,
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
  'apply.set_questions': applySetQuestions,
  'apply.resolve_claim': applyResolveClaim,
  'apply.mark_submitted': applyMarkSubmitted,
  'apply.skip_connect': applySkipConnect,
  'apply.render_documents': applyRenderDocuments,
  'apply.fill_done': applyFillDone,
  'people.find': peopleFind,
  'people.link': peopleLink,
  'people.classify': peopleClassify,
  'people.find_email': peopleFindEmail,
  'people.email_checked': peopleEmailChecked,
  'people.fallback': peopleFallback,
  'people.set_path': peopleSetPath,
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
  'decisions.undo_group': decisionsUndoGroup,
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
