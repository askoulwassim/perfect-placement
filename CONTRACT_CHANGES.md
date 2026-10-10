# Contract change requests

`packages/contracts` and `packages/engine/db/migrations/001_init.sql` are frozen during Wave 1. A lane that needs a change appends an entry below and works against a local shim inside its own folders. Wave 2 resolves every entry (accept, amend, or reject) before merging lanes.

## Template

```
### <short title>
- Lane: <A..J>
- Date: YYYY-MM-DD
- Contract: <file / export / table>
- Change: <exact addition or edit>
- Why: <what breaks or is impossible without it>
- Shim: <how the lane works around it meanwhile>
- Status: open | accepted | amended | rejected (Wave 2 fills this)
```

## Wave 0 additions beyond the contracts.md sketch (for the record)

These were added in Wave 0 so lanes do not need to request them:

- **Ops:** `profile.reject_diff` (low), `runs.start` (low; UI stage buttons and Scout now start skill runs), `config.get` (low), `config.update` (medium; Settings Save).
- **Op metadata:** `dynamicImpact` (static `impact` is the ceiling), `humanOnly`, `unimplemented`, `readOnly`, `owner` lane.
- **Tables:** `profile_diff` (pending diffs for Learn + You screen).
- **Columns:** `role.location`, `role.comp_currency`, `role.flags_json`, `role.created_at`, `role.updated_at`; `score.facts_json`; `decision.status`, `decision.resolved_at`, `decision.action_json` (the op to run when a human accepts).
- **Constraints:** archived requires `archive_reason`, held requires `held_reason`, `score` and `event` append-only (triggers), high-impact decisions must have `policy_outcome = 'human'`, unique `role.url`.
- **Enums:** archive reason `legacy` (v1 migration only), `DECISION_KINDS` (keys for `config.overrides`), `CONTACT_TIERS` (5 avatar tiers), `INBOX_CLASSES`, `SKILLS`.
- **Config:** `freshness.stale_after_days` (45).

## Requests

Resolved in Wave 2 Phase 1 (see docs/v2/wave2-plan.md): every entry below has its `Status:` set, and the accepted or amended changes are implemented in `packages/contracts`, migration `002_wave2.sql` and the fixtures. New requests go under their lane heading with `Status: open`.

## Lane B requests

### runs.finish op
- Lane: B
- Date: 2026-10-08
- Contract: packages/contracts/src/ops/registry.ts (OPS)
- Change: add `runs.finish` { input: { run_id: Id, status: RunStatus minus 'running', summary?: record, note?: string }, output: { run: Run }, impact: low, emits: ['run_finished'], owner: 'B' }.
- Why: `runs.start` opens a run but nothing in the registry closes it, so `run_finished` can never be emitted and every skill run stays `running` (MCP agents and the UI cannot finish one).
- Shim: defined in packages/engine/ops/_shim/extra-ops.ts; `runOp` accepts it next to OPS (not visible to lane C's generated MCP tools until accepted).
- Status: accepted (registry `runs.finish`; lane B's `_shim/extra-ops.ts` copy is now redundant, Phase 2 removes it).

### role_promoted in more emits lists
- Lane: B
- Date: 2026-10-08
- Contract: registry `emits` of `apply.tailor`, `apply.mark_submitted`, `inbox.ingest` (and `roles.check_freshness`, which can free a slot too)
- Change: add 'role_promoted' to each.
- Why: moving a role out of `active` frees a company slot, and held promotion runs inside the same op. Those ops cannot emit role_promoted today.
- Shim: `promoteHeld` emits `role_moved` with payload `{ promoted: true }` when the op cannot emit role_promoted.
- Status: accepted (apply.tailor, apply.mark_submitted, inbox.ingest, roles.check_freshness).

### Recording externally judged decisions (resolver)
- Lane: B (affects I)
- Date: 2026-10-08
- Contract: packages/contracts/src/resolver.ts (`Resolver`, `AskRequest`)
- Change: (a) add `action?: { op: string; input: unknown }` to AskRequest so a queued decision carries the op to run (`decision.action_json`); (b) add `record(req: { decision, impact, subject, question, answer: Answer, backend, action? }): { decisionId, outcome }` to `Resolver` for judgments made outside the resolver (a skill's email classification with its p, an agent asking for a medium-impact op).
- Why: `inbox.ingest` receives `class` + `p` per message from the skill and must apply policy and log a decision row with the action, without asking a backend again. `ask()` has no way to pass the action or a precomputed answer.
- Shim: `DecisionPort.record` (packages/engine/ops/ports.ts), implemented in ops/_shim/decisions.ts as a POLICY_GRID lookup; `auto_second` goes to a human (no second backend).
- Status: accepted: `Resolver.record(RecordRequest): Promise<RecordResult>` for externally judged answers; the action part is amended into `AskRequest.action` / `.actions` (DecisionAction).

### Archive reason `duplicate`
- Lane: B
- Date: 2026-10-08
- Contract: enums.ts ARCHIVE_REASONS + migration CHECK
- Change: add 'duplicate'.
- Why: accepting a `roles.dedupe` decision archives the new role; today the closest reason is `passed`, which reads as a skip signal to the Learn loop.
- Shim: action uses `passed` with note `duplicate of <id>`; `role_skipped` is only emitted for passed roles leaving active/held/on-deck, so inbox duplicates do not pollute learning.
- Status: accepted (enum + migration 002 role rebuild).

### roles.add output: possible duplicates
- Lane: B
- Date: 2026-10-08
- Contract: registry `roles.add` output
- Change: add `possible_duplicates: Array<{ index, role_id, existing_id, decision_id }>`.
- Why: near matches (title similarity 0.6 to 0.9) are added and queued as `roles.dedupe` decisions; the caller cannot see which without reading the queue.
- Shim: listed in the run log only.
- Status: accepted (`possible_duplicates`, default []).

### Agent confidence for medium-impact ops
- Lane: B (affects I, C)
- Date: 2026-10-08
- Contract: define.ts `OpContext`
- Change: add optional `confidence?: { p: number; backend: Backend }` so an agent can state its confidence when it calls a medium-impact op (`roles.move`, `roles.archive`, `config.update`) and the policy grid can auto + undo it.
- Why: today an automated actor calling a medium op with no decision id always lands in Needs you (queued with p 0.5), since the op has nothing to put through the grid.
- Shim: runtime queues a human decision (`forceHuman`).
- Status: accepted (`OpContext.confidence?: { p, backend }`); powers wave1-decisions #17.

## Lane I requests

### Typed `action_json` (DecisionAction)
- Lane: I
- Date: 2026-10-08
- Contract: packages/contracts/src/entities.ts `Decision.action_json`
- Change: add `export const DecisionAction = z.object({ op: z.string(), input: z.unknown(), when: z.union([z.string(), z.boolean(), z.number()]).optional(), undo: z.object({ op: z.string(), input: z.unknown() }).optional() })` and type `action_json` as `DecisionAction.nullable()`. Semantics: `"$value"` anywhere in `input` is replaced by the final value; `when` gates the action on the final value; `undo` is the inverse op run by `decisions.undo`.
- Why: `decisions.resolve` must know whether the chosen value means "do it" (a yes/no pick of `open = true` must not run `roles.archive`), and `decisions.undo` needs an inverse op. Without `when`, accepting fixture `dc_0001` as picked (open = true) would archive an open role.
- Shim: lane I parses these optional keys from the existing Json column (`packages/resolver/src/actions.ts`).
- Status: accepted (`DecisionAction = { op, input, when?, undo? }` in entities.ts; `Decision.action_json: DecisionAction | null`).

### Per-question actions on AskRequest
- Lane: I
- Date: 2026-10-08
- Contract: packages/contracts/src/resolver.ts `AskRequest`
- Change: add `actions: z.record(z.string(), DecisionAction).optional()` (keyed by question id).
- Why: every `decision` row carries `action_json`, and `ask()` writes the rows, so callers need a way to pass the action in.
- Shim: `resolver.ask(req, { actions })` takes them as an optional second argument (still assignable to `AskFn`).
- Status: amended: one shape for all action requests (I, E, G, B). `AskRequest.action?: DecisionAction` (all questions) and `AskRequest.actions?: Record<questionId, DecisionAction>` (per question wins).

### Fixture: `dc_0001` should gate its archive on `open = false`
- Lane: I
- Date: 2026-10-08
- Contract: packages/fixtures/src/data.ts `dc_0001`, `dc_0101`
- Change: `action_json: { op: 'roles.archive', input: {...}, when: false, undo: { op: 'roles.move', input: { role_id, to: <previous status> } } }`.
- Why: see first request. `dc_0101` (auto + undo) has no inverse op today, so `decisions.undo` can only mark it undone and emit `decision_undone`.
- Shim: tests patch the rows in a temp db.
- Status: accepted (`when: false` + `undo` on dc_0001; `undo` on dc_0101).

### Decision repository ownership
- Lane: I
- Date: 2026-10-08
- Contract: packages/engine/db (lane A)
- Change: none to contracts. Wave 2 should either adopt `packages/resolver/src/store.ts` (`DecisionStore`) as the decision repository or have lane A's repository implement that interface.
- Why: two writers for `decision` would drift.
- Shim: the resolver takes the store by injection.
- Status: accepted, no contract change: lane A's repository implements lane I's `DecisionStore` interface (Phase 2).
## Lane E requests

### Per-component data schemas
- Lane: E
- Date: 2026-10-08
- Contract: packages/contracts/src/entities.ts (`ProfileComponent.data_json`)
- Change: export `COMPONENT_DATA_SCHEMAS: Record<ProfileComponentKey, z.ZodType>` (loose objects) plus `CriteriaWeights`, `V1Section`; validate `data_json` per `key`. Source of truth today: `packages/engine/profile/components.ts`.
- Why: UI (You screen), MCP JSON schemas, lane F (reads Terms/Work mode/Dealbreakers/Company fields) and lane A (v1 import) all need the same shape. Today `data_json` is `Record<string, unknown>`.
- Shim: schemas live in engine/profile and are applied by lane E handlers only.
- Status: accepted: `COMPONENT_DATA_SCHEMAS` (loose objects), `CriterionWeights` (lane E alias `CriteriaWeights`), `V1Section`, `parseComponentData` in contracts/profile-data.ts; engine/profile/components.ts re-exports them. `ProfileComponent.data_json` stays a record; validate per key with `parseComponentData`.

### Criterion weights live on components (CRITERION_OWNER)
- Lane: E
- Date: 2026-10-08
- Contract: enums.ts / entities.ts (profile)
- Change: add `CRITERION_OWNER: Record<Criterion, ProfileComponentKey>` = c1,c7 team; c2 company; c3,c9 craft; c4,c5 domain; c6 terms; c8 growth. Each owner stores `data_json.criteria_weights` (points of 100); weighted `weight` column = owned sum / 100. Terms (filter) keeps `weight` null but carries `criteria_weights.c6`.
- Why: `onboard.calibrate` outputs 9 criterion weights but a component has one `weight`; lane F needs one function `rubricWeights(components)` to build the score rubric from a profile version.
- Shim: `rubricWeights`, `weightsByComponent` exported from engine/profile; lane F can import them.
- Status: amended: `CRITERION_OWNER` = c1, c7 team; **c2, c3, c9 craft**; c4, c5 domain; c6 terms; c8 growth (F's mapping: C2 is scored blind, so it is role-intrinsic). Field name **`criterion_weights`** (points of 100); lane E code renamed from `criteria_weights`.

### onboard_session table
- Lane: E
- Date: 2026-10-08
- Contract: migration 002 (lane A) + entities.ts
- Change: `onboard_session(id TEXT PK, started_at, updated_at, step, scope_json, draft_json, sources_json, answered_json, calibration_json, version_id)`.
- Why: onboarding state spans many ops and must survive restarts; migration 001 has nowhere to put it.
- Shim: `OnboardStore` interface; file store at `$PP_HOME/onboarding.json` (JSON, not markdown), memory store in tests.
- Status: accepted (migration 002 + `OnboardSession` in TABLES).

### onboard.start + onboard.samples ops
- Lane: E
- Date: 2026-10-08
- Contract: ops/registry.ts
- Change: `onboard.start` (low) input `{ components?: ProfileComponentKey[] }` (omit = full onboarding; given = re-interview only those, then confirm) output `OnboardState`; `onboard.samples` (low, readOnly) output `{ samples: { id, title, company, criteria: Record<Criterion, 1..5> }[] }`.
- Why: blueprint requires re-interviewing one component without redoing the rest; the calibration screen needs the 12 cards. Neither is reachable through current ops.
- Shim: `startComponentInterview()` and `calibrationSamples()` functions.
- Status: accepted, merged with lane D's request: `onboard.start`, `onboard.state`, `onboard.samples` (items `{ id, company, letter, title, comp, mode, criteria }` + baseline `weights`).

### onboard.confirm output: proposed_diffs
- Lane: E
- Date: 2026-10-08
- Contract: ops/registry.ts `onboard.confirm.output`
- Change: add `proposed_diffs: ProfileDiff[]` (default []).
- Why: when an agent re-runs onboarding over an existing profile, filter changes are held back as pending high-impact diffs; callers should see them.
- Shim: handler returns them; contract output parse strips the field (visible through `profile.get` pending_diffs).
- Status: accepted (`proposed_diffs`, default []).

### AskRequest.action
- Lane: E (also affects I, B, F, G, H)
- Date: 2026-10-08
- Contract: resolver.ts `AskRequest`
- Change: optional `action?: { op: OpName; input: Record<string, unknown> }` written to `decision.action_json` for each question (or per-question `action`).
- Why: `decisions.resolve` runs `action_json` when a human accepts, but no caller can set it through `ask()`.
- Shim: injected `attachAction(decisionId, action)` (test shim updates `decision.action_json` directly).
- Status: amended into the single DecisionAction shape (see lane I "Per-question actions on AskRequest").

### profile.undo_diff (or decisions.undo dispatch)
- Lane: E
- Date: 2026-10-08
- Contract: ops/registry.ts
- Change: `profile.undo_diff` (low, emits none or a new `profile_diff_undone`) input `{ diff_id }` output `{ version: ProfileVersion }`; lane I's `decisions.undo` calls it for `profile.apply_diff` decisions. Or document that `decisions.undo` dispatches to engine/profile `undoDiff`.
- Why: weighted diffs apply as auto + 24h undo; undo must create v+1 restoring the prior data and mark the diff `undone`.
- Shim: `undoDiff(deps, diffId, ctx)`.
- Status: accepted (`profile.undo_diff`, low, emits none); `decisions.undo` dispatches through `DecisionAction.undo`.

### profile.learn op
- Lane: E
- Date: 2026-10-08
- Contract: ops/registry.ts
- Change: `profile.learn` (low; emits `profile_diff_proposed`, `profile_diff_applied`) input `{ event_id: Id }` output `{ proposed: ProfileDiff[], applied: {diff_id, version_id}[], queued: {diff_id, decision_id}[] }`.
- Why: the learn loop must be triggerable by schedules, the inbox monitor and MCP through the one ops registry.
- Shim: `learnFromEvent(deps, eventId, ctx)`.
- Status: accepted.

### ProfileDiff.event_id meaning
- Lane: E
- Date: 2026-10-08
- Contract: entities.ts `ProfileDiff.event_id` (doc only)
- Change: document as "the event that caused the diff; the proposal event when there is no cause". Applied versions copy it to `profile_version.event_id`.
- Why: fixtures point it at the proposal event; the learn loop needs the causing event for traceability.
- Shim: implemented as described.
- Status: accepted (doc comment on `ProfileDiff.event_id`).
## Lane F requests

### Pin the score formula (scale) in the rubric snapshot
- Lane: F
- Date: 2026-10-08
- Contract: `entities.ts` Score.rubric_json; fixtures `RUBRIC`
- Change: add a typed `RubricSnapshot` (zod) with `scale: 'v1' | 'zero_based'`, `weights` (c1..c9 lower case, sum 100), `bands`, `affinity_cap`, `company_active_cap`, `profile_version_id`, `weights_source`. Default scale `v1` (`round(sum(c_i*w_i)/5)`, range 20..100), which is what v1 scorer.py used and what green 75 / yellow 55 were calibrated on. Regenerate fixture scores with `v1` (they use `zero_based` today, which puts all-4s at 75 instead of 80).
- Why: totals from the two formulas are not comparable; the per-company cap ranks roles by latest total, so a mixed db ranks wrong. Lane A imports v1 totals in the v1 scale.
- Shim: `packages/engine/scoring/rubric.ts` supports both and writes `scale` into `rubric_json`; handler tests pass `scale: 'zero_based'` to match the fixtures.
- Status: accepted: `RubricSnapshot` (loose) with `scale` default `'v1'` (wave1-decisions #11). Fixtures regenerated on the v1 formula. `Score.rubric_json` stays a record (v1 legacy rows differ).

### Where calibrated criterion weights live in a profile version
- Lane: F (needs E)
- Date: 2026-10-08
- Contract: profile component `data_json` shapes (lane E schemas)
- Change: `data_json.criterion_weights: Partial<Record<Criterion, number>>` on the owning weighted component: team (c1, c7), craft (c2, c3, c9), domain (c4, c5), terms (c6), growth (c8). Missing criteria fall back to the v1 weights; result normalized to 100. Also type the filter keys scoring reads: `work_mode.modes`, `terms.comp_floor`, `terms.comp_floor_hard` (bool; comp is a C6 penalty unless true), `company.affinity` (slug -> int), `company.watchlist` (slugs).
- Why: `profile_component.weight` is one number per component, not per criterion; blueprint says weights come from the profile version and calibration derives criterion weights.
- Shim: `CRITERION_OWNER` + `profileCriterionWeights()` in `scoring/rubric.ts`.
- Status: amended: see lane E "Criterion weights live on components" (same mapping, field `criterion_weights`); `terms.comp_floor_hard`, `work_mode.modes`, `company.affinity`, `company.watchlist` are typed in COMPONENT_DATA_SCHEMAS.

### roles.score: optional profile version in, cap moves out
- Lane: F
- Date: 2026-10-08
- Contract: `ops/registry.ts` rolesScore
- Change: input `profile_version_id?: Id` (Learn loop rescoring under a new version; default latest). Output `cap: Array<{ role_id, from: 'active'|'held', to: 'active'|'held' }>` (other roles the per-company cap moved, so UI and agents can show the bump).
- Why: today the version can only be injected by the caller's deps, and bumped roles are visible only as events.
- Shim: `ScoringDeps.profileVersionId`; handler returns `{ output, eventIds, cap }`.
- Status: accepted (`profile_version_id?` in; `cap` out, default []).

### Statuses a rescore may move
- Lane: F
- Date: 2026-10-08
- Contract: `enums.ts`
- Change: export `RESCORE_MOVABLE = ['inbox','active','held']` and `RESCORE_REVIVABLE_ARCHIVE = ['below_threshold','dealbreaker']`. `on-deck` is not in `PROTECTED_STATUSES`, but a rescore moving a human pick back to active/archived is a downgrade, so scoring keeps on-deck too.
- Why: lanes B (roles.move), E (learn rescore) and F must agree on what an automated rescore may touch.
- Shim: `isMovable()` in `scoring/handler.ts`.
- Status: accepted (`RESCORE_MOVABLE`, `RESCORE_REVIVABLE_ARCHIVE`); on-deck protected from rescore (wave1-decisions #13).
## Lane G requests

### AskRequest carries the action a human accept runs
- Lane: G
- Date: 2026-10-08
- Contract: `packages/contracts/src/resolver.ts` `AskRequest`
- Change: add `action: z.object({ op: z.string(), input: z.record(z.string(), z.unknown()) }).optional()`; the resolver copies it into `decision.action_json` when it writes the decision row.
- Why: `decision.action_json` ("the op to run when this decision is applied") is written by the resolver, but `AskRequest` has no way to pass it. Freshness needs `{ op: 'roles.archive', input: { role_id, reason: 'closed' } }` on every `freshness.closed` decision so Needs-you accept works; inbox and others will need the same.
- Shim: `FreshnessStore.attachDecisionAction(decisionId, action)` (`sqlite-store.ts`) sets `action_json` right after `ask()` returns, only when it is still null.
- Status: amended into the single DecisionAction shape (see lane I "Per-question actions on AskRequest").

### roles.check_freshness output lists skipped ids
- Lane: G
- Date: 2026-10-08
- Contract: `packages/contracts/src/ops/registry.ts` `rolesCheckFreshness.output`
- Change: add `skipped: z.array(Id).default([])`: requested `role_ids` that were not checked because they are outside `FRESHNESS_SCOPE` (applied or later, archived, inbox) or unknown.
- Why: a caller passing an applied role id today gets silently fewer results; the UI and agents should see "skipped, out of scope" rather than infer it.
- Shim: `checkFreshness()` returns `skipped` next to `output`; the handler drops it to match the frozen schema.
- Status: accepted (`skipped`, default []).
## Lane H requests

### people.find: skill hints + LinkedIn company slug
- Lane: H
- Date: 2026-10-08
- Contract: packages/contracts/src/ops/registry.ts `peopleFind.input`
- Change: add `hints: z.array(z.object({ name, headline?: string|null, linkedin_url?: url|null, email?: email|null, source: 'jd'|'company_site'|'manual' })).max(20).optional()` and `linkedin_company_slug: z.string().regex(/^[a-z0-9-]+$/).optional()`.
- Why: the blueprint lists the JD and company team page as people sources, but no op can create a contact other than people.find, and people.link needs an existing contact_id. The LinkedIn vanity slug often differs from the PP company slug.
- Shim: `PeopleFindInput` in packages/engine/people/find.ts extends the contract input with both fields.
- Status: accepted.

### people.classify: say whether the tier was applied
- Lane: H
- Date: 2026-10-08
- Contract: `peopleClassify.output`
- Change: add `outcome: PolicyOutcome` (or `applied: boolean`).
- Why: when the resolver routes to `human`, the link keeps its provisional tier and the decision waits in Needs you; callers (skill, UI) cannot tell this from the output today.
- Shim: callers read `decision.policy_outcome` by `decision_id`.
- Status: accepted (`outcome: PolicyOutcome`).

### people.classify decision action
- Lane: H
- Date: 2026-10-08
- Contract: decision `action_json` convention (lane I) for kind `people.classify`
- Change: when a human resolves a people.classify decision, apply it via `people.link { contact_id, role_id, degree, tier, is_hiring_team, via_contact_id, company_id }` built from the chosen role. Lane I's resolver should set `action_json` accordingly, or decisions.resolve should call a lane H helper.
- Why: otherwise the human pick never reaches contact_link.
- Shim: none; tests assert the decision stays pending with the provisional tier.
- Status: accepted via DecisionAction (`people.link`); Phase 2 wires it.

### config.linkedin: mode, driver, per-run caps
- Lane: H
- Date: 2026-10-08
- Contract: `PolicyConfig.linkedin` / `DEFAULT_CONFIG.linkedin`
- Change: add `mode: 'off'|'dry-run'|'live'` (default `'off'`), `driver: 'playwright'|'claude-in-chrome'` , `max_pages_per_run: 6`, `max_mutual_expansions: 3`.
- Why: live LinkedIn reads must be opt-in per install; per-run caps are hard-coded defaults in the adapter today.
- Shim: adapter options + defaults in packages/engine/integrations/linkedin/index.ts; deps decide whether a LinkedIn source is injected.
- Status: accepted; defaults `mode: 'live'` (wave1-decisions #6), `driver: 'claude-in-chrome'` (#4), `max_pages_per_run: 6`, `max_mutual_expansions: 3`. Tests use `dry-run`.
## Lane C requests

### `companies.get` read op
- Lane: C
- Date: 2026-10-08
- Contract: packages/contracts/src/ops/registry.ts (`OPS`)
- Change: add `companies.get` { input: `{ company_id: Id }`, output: `{ company: Company, roles: RoleSummary[], dossier_md: string | null }`, impact low, readOnly, emits [], owner B }.
- Why: the MCP "company" resource (lane C brief) has no op to read one company. A company with no roles, or its dossier, cannot be served.
- Shim: `pp://companies/{company_id}` calls `roles.list({ company_id, limit: 500 })` and returns the first item's company plus the roles; not found when the company has no roles.
- Status: accepted (lane B handler in ops/handlers/reads.ts).
## Lane D requests

All shims below live in `apps/web/src/client/types.ts` (`ShimOps`) and are served by the fixtures mock (`apps/web/src/client/mock.ts`). They are read-only; every write in the UI already goes through a registry op.

### outreach.get (read op)
- Lane: D
- Date: 2026-10-08
- Contract: packages/contracts/src/ops/registry.ts
- Change: add `outreach.get` { outreach_id } -> { outreach: Outreach, contact: Contact, subject: string | null, hook: string, proof: string, ask: string, variants: { hook, proof, ask }[4] }; low, readOnly, owner H. `variants` is one draft per tone (Ask for the conversation, Coffee or intro, Forwardable blurb, Positioning note); the prototype's tone chips switch between them locally.
- Why: the Outreach draft screen shows Hook / Proof / Ask, and the Needs-you "Ready for Gmail?" card shows them as evidence. No op returns draft text; markdown must not be parsed by the UI.
- Shim: `ShimOps['outreach.get']`.
- Status: accepted (`variants` = one per `OUTREACH_TONES`, length 4).

### outreach.list (read op) or outreach in roles.get
- Lane: D
- Date: 2026-10-08
- Contract: registry.ts (`roles.get` output or a new op)
- Change: either add `outreach: Outreach[]` to `roles.get` output, or add `outreach.list` { role_id } -> { items: Outreach[] }.
- Why: People list and Role panel need each person's DraftStatusChip (none / drafted / in Gmail / replied).
- Shim: `ShimOps['outreach.list']`.
- Status: accepted as `outreach.list { role_id }`.

### contacts.get (read op)
- Lane: D
- Date: 2026-10-08
- Contract: registry.ts
- Change: add `contacts.get` { contact_id } -> { contact: Contact, links: ContactLink[] }; low, readOnly, owner H.
- Why: Needs-you cards for `people.classify` decisions have `subject_type = contact` and need a name and tier.
- Shim: `ShimOps['contacts.get']`.
- Status: accepted.

### vault.read (read op) for package previews
- Lane: D
- Date: 2026-10-08
- Contract: registry.ts
- Change: add `vault.read` { path: VaultPath } -> { markdown: string | null } (frontmatter stripped; path must be one the db references), or `applications.package` { role_id } -> { dossier?, resume?, cover_letter?, fit_map?, answers? } as markdown strings.
- Why: Role screen package tabs (Dossier, Resume, Cover, Fit map, Answers) preview documents. No op returns their content.
- Shim: `ShimOps['vault.read']`.
- Status: accepted, restricted to paths the db references (lane B handler in ops/handlers/reads.ts).

### onboard.samples and onboard.state (read ops)
- Lane: D
- Date: 2026-10-08
- Contract: registry.ts
- Change: add `onboard.samples` {} -> { items: { id, company, letter, title, comp, mode, criteria: Record<Criterion, 1..5> }[], weights: Record<Criterion, number> } (the 12 calibration roles plus the baseline weights the bars start from) and `onboard.state` {} -> OnboardState (resume mid-flow). OnboardState.next_question would also need `step` for sliders (the prototype uses 5).
- Why: Calibrate shows 12 sample roles and `onboard.calibrate` needs their `sample_id`; Onboarding cannot resume without a state read.
- Shim: `ShimOps['onboard.samples']`; state kept in the screen.
- Status: accepted, merged with lane E's request (OnboardState.next_question gains `step`).

### system.backends (read op)
- Lane: D
- Date: 2026-10-08
- Contract: registry.ts
- Change: add `system.backends` {} -> { items: { name: 'jev'|'kev'|'llm', mode: 'hosted'|'local', status: 'ok'|'slow'|'down', latencyMs: number|null }[] }, owner I (or fold into `system.doctor` checks).
- Why: Settings BackendCards show status dots and latency.
- Shim: `ShimOps['system.backends']`.
- Status: amended: items `{ name: 'rule'|'kev'|'agent'|'jev'|'llm', mode: 'hosted'|'local'|'session', status, latencyMs }`, owner I.

### runs.start: optional contact_id, connect run summary
- Lane: D
- Date: 2026-10-08
- Contract: registry.ts `runsStart`
- Change: add `contact_id: Id.optional()` to `runs.start` input; document that a `connect` run's `summary_json.outreach_id` names the draft it wrote.
- Why: People primary is "Draft for <best path>" and opens the resulting draft; without contact_id the run cannot target a person the user picked, and the UI needs the outreach id to navigate.
- Shim: mock drafts for the best-path person and returns `summary_json.outreach_id`.
- Status: accepted (`contact_id?`; documented `summary_json.outreach_id`).

### Schedules on/off
- Lane: D
- Date: 2026-10-08
- Contract: policy.ts `PolicyConfig.schedules`
- Change: allow the literal `'off'` (or add `{ spec, enabled }` per schedule).
- Why: Settings has an on/off toggle per schedule; today the schema only holds a spec string.
- Shim: UI writes `'off'` via `config.update` (passes `z.string()`).
- Status: accepted: each schedule is `string | 'off'` (`ScheduleSpec`).

### PRIMARY_ACTIONS wording
- Lane: D
- Date: 2026-10-08
- Contract: ui.ts `PRIMARY_ACTIONS`
- Change: people label `Draft for <first name>` (op runs.start); needs-you shows `Back to Now` (null) when clear; role shows `Open River` (null) once applied; onboarding `Next` is `onboard.answer` only on the Interview step and navigation (null) on Resume and Calibrate (those steps call `onboard.ingest_resume` and `onboard.calibrate` from the drop zone and N/M/Y).
- Why: matches the handoff screen table and the click paths.
- Shim: none needed.
- Status: accepted.

### Local API route shape
- Lane: D
- Date: 2026-10-08
- Contract: contracts.md (local API)
- Change: `POST /api/ops/:name` with the op input as JSON body, response = `OpOutcome` JSON, actor = human.
- Why: `apps/web/src/client/http.ts` targets this; lane B/C should serve it in `pp up`.
- Shim: `VITE_PP_API=/api` switches the UI to it.
- Status: accepted: `POST /api/ops/:name`, JSON body, returns `OpOutcome`, actor human (Phase 3 serves it).

### Prototype values missing from tokens
- Lane: D
- Date: 2026-10-08
- Contract: packages/contracts/src/tokens.ts (`tint`)
- Change: add the extra tints and shadows the prototype uses: rail bg `rgba(9,26,45,0.6)`, river column bg `rgba(9,26,45,0.55)`, emerald alphas 0.03/0.04/0.06/0.07/0.08/0.12/0.14/0.15/0.16, gold alphas 0.06/0.08/0.12/0.16/0.35/0.5, coral 0.12/0.14/0.35, emerald-deep 0.18/0.35, best-path hover `#0E6B51`, calibration card shadow `#0A1C31`, mobile ground glow `radial-gradient(500px 360px at 100% 0%, rgba(11,92,69,0.5), rgba(11,92,69,0) 70%)`, pill shadow `0 12px 40px rgba(0,0,0,0.35)`, Ask shadow `0 20px 60px rgba(0,0,0,0.45)`. Also note the prototype switches to the phone layout below 720px, not 390.
- Why: the faithful port uses them; today they live as literals in `apps/web/src/components/theme.ts` (`X`).
- Shim: `X` constants in theme.ts.
- Status: accepted: tints, `extra`, `shadow`, `groundGlowMobile`, `layout.mobileBreakpoint = 720` in tokens.ts; tokens.css regenerated at build.
## Lane J requests

### Zod prop schemas for the four generated-UI cards
- Lane: J
- Date: 2026-10-08
- Contract: packages/contracts/src/ui.ts (new export, e.g. `GENUI_PROPS`)
- Change: add zod schemas, id-only: `RoleCard: z.object({ roleId: z.string() })`, `ScoreRadar: z.object({ roleId: z.string() })`, `ContactCard: z.object({ contactId: z.string(), roleId: z.string().optional() })`, `ProfileDiff: z.object({ diffId: z.string() })`. Key order is part of the contract (OpenUI maps positional args by key order).
- Why: OpenUI generates the model prompt and parses replies from these schemas; lane D's components and the MCP tool schema should share one source instead of `COMPONENTS` prop strings.
- Shim: defined locally in `apps/web/genui/src/library.tsx`.
- Status: accepted (`GENUI_PROPS` in ui.ts, id-only, key order kept).

### Fold apps/web/genui into the build (not a contract; Wave 2 integration)
- Lane: J
- Date: 2026-10-08
- Contract: pnpm-workspace.yaml / apps/web/package.json / apps/web vite config
- Change: either add `@openuidev/react-lang@0.3.2`, `@openuidev/lang-core@0.3.2`, `react`, `react-dom` to apps/web and include `genui/src` in its build, or add `apps/web/genui` to `pnpm-workspace.yaml`. Keep `@openuidev/lang-core` OUT of `onlyBuiltDependencies` (its postinstall sends install telemetry). In the apps/web Vite config, alias `@openuidev/devtools` to an empty module (react-lang loads it from cdn.jsdelivr.net when NODE_ENV=development).
- Why: genui is a standalone package with its own lockfile during Wave 1 because lane D owns apps/web's package.json.
- Shim: `cd apps/web/genui && pnpm install --ignore-workspace && pnpm check` (see genui/README.md).
- Status: accepted as Phase 3 integration work (not a contract change); done in Phase 3b (PR #13).

## Wave 2 Phase 2

Contract changes made while wiring the engine (docs/v2/wave2-plan.md "Phase 2").

### Per-kind confident outcome override
- Lane: integration (I, E, B)
- Date: 2026-10-08
- Contract: packages/contracts/src/policy.ts (`ThresholdOverride`, `PolicyConfig.overrides`, `DEFAULT_CONFIG`, `thresholdsFor`)
- Change: `config.overrides[kind]` is `Thresholds.partial()` plus `confident_outcome?: 'auto' | 'auto_undo'`. When set to `auto_undo`, a confident decision of that kind whose grid cell is plain `auto` applies with a `undo_hours` undo window instead. Hard exclusions still win. `DEFAULT_CONFIG.overrides` sets it for `profile.apply_diff` (wave1-decisions #14: asset and weighted diffs, auto + 24h undo when confident) and `inbox.classify` (#16: a confident confirmation, including one that revives an archived role, auto + 24h undo; every confident inbox move gets the undo, with `action_json.undo` restoring the prior status). `freshness.closed` keeps the plain grid (#18); Settings may set the same override there.
- Why: #14 and #16 ask for auto + undo, but the #24 grid gives medium + confident plain `auto`; a kind-level override keeps the grid itself unchanged.
- Shim: none.
- Status: accepted

### people.classify takes the human's pick
- Lane: integration (H, I)
- Date: 2026-10-08
- Contract: registry `peopleClassify.input`
- Change: optional `role: ContactRole`: apply that classification directly (tier = degree x hiring team), no resolver call. A `people.classify` decision's action is `{ op: 'people.classify', input: { contact_id, role_id, role: '$value' } }`, so accepting or changing the pick in Needs you applies it. Amends "people.classify decision action" above (`people.link` cannot derive the tier from the chosen value).
- Why: `people.link` needs `tier` and `is_hiring_team`, which `$value` substitution cannot compute.
- Shim: none.
- Status: accepted

### roles.score notes: any subset of criteria
- Lane: integration (F)
- Date: 2026-10-08
- Contract: registry `rolesScore.input.notes`
- Change: `z.partialRecord(Criterion, z.string())` instead of `z.record(Criterion, ...)` (zod 4 records over an enum are exhaustive, so a note for one criterion failed validation).
- Why: rationale is written per criterion when there is something to say.
- Shim: none.
- Status: accepted

## Fresh start cleanup

### Drop migration-only values (#26)
- Lane: cleanup (A, E, F)
- Date: 2026-10-08
- Contract: `ARCHIVE_REASONS`, `ROLE_SOURCES`, `ROLE_FLAG_KEYS` (enums.ts); `V1Section` and component `v1_sections` (profile-data.ts); migration `003_fresh_start.sql`
- Change: remove archive reason `legacy`, role source `migration`, flag key `verify_remote` and the `v1_sections` component field. 003 rebuilds `role` (12-step, as 002) with the narrowed CHECKs, after mapping any leftover `legacy` -> `passed` and `migration` -> `manual`.
- Why: no v1 data is ever imported (wave1-decisions #26); these existed only for the v1 importer.
- Shim: none (003 maps leftovers).
- Status: accepted

## First-run experience

### Kev model choice in config
- Lane: first-run
- Date: 2026-10-08
- Contract: packages/contracts/src/policy.ts (`BackendsConfig.kev`)
- Change: optional `backends.kev.model: string` (e.g. `kev-0.8b`, `kev-4b`). `pp kev install --model` / `pp kev start --model` store it with `config.update`; `pp kev start` and `pp up` serve that checkpoint. Absent means `kev-4b`. `DEFAULT_CONFIG` unchanged.
- Why: pp now manages the Kev process (`pp kev install|start|stop|status`, `pp up` starts it on demand); 16 GB machines need `kev-0.8b`, and the choice must survive restarts.
- Shim: none.
- Status: accepted

## Gmail via agent

### outreach.to_gmail records an agent-made draft; runs.start runs the Gmail draft step
- Lane: gmail (H, B, D)
- Date: 2026-10-08
- Contract: registry `outreachToGmail.input`, `runsStart.input`; `PRIMARY_ACTIONS['outreach-draft']` (ui.ts)
- Change: `outreach.to_gmail` gains optional `gmail_draft_id: string` = a Gmail draft the calling agent already created with its own Gmail tool. The handler then skips the engine Gmail client, still runs the writing-rule checks, stores the id, sets `in_gmail` and advances Connect to Fill. Without the id and with no engine client it answers `backend_unavailable` (start a Gmail-capable agent run). Impact (medium) and policy unchanged. `runs.start` gains optional `outreach_id` (skill `connect` only): a run scoped to that draft's Gmail step; role and contact come from the outreach (must be `drafted`), `summary_json` gets `outreach_id` + `step: 'gmail_draft'`, and the runner prompt is the Gmail step (read `outreach.get`, create a Gmail **draft** with the agent's Gmail tool, never send, then `outreach.to_gmail { outreach_id, gmail_draft_id, confidence }`). The Outreach screen's **Create Gmail draft** now calls `runs.start` (was `outreach.to_gmail`); Ask replies no longer offer `outreach.to_gmail` (not in PRIMARY_ACTIONS).
- Why: wave1-decisions #5 and #9: the Gmail connector exists only inside an agent session; the engine has no Gmail client and no OAuth app. Smallest change: one optional field per op, no new op.
- Shim: none (both fields optional; an injected `EngineServices.gmail` still works without the id).
- Status: accepted

## Outreach voice

### Natural-email outreach: sign-off, composed body, several voice samples
- Lane: outreach-voice (H, E, D)
- Date: 2026-10-08
- Contract: registry `outreachDraft.input`, `outreachGet.output`, `OnboardState.next_question`; profile-data `voice` (`signoff`), `VOICE_SAMPLES_MAX`, `VOICE_SAMPLE_MAX_CHARS`
- Change: `outreach.draft` gains optional `signoff` (default: Voice `signoff`, else "Thanks," plus the Story first name), stored as a `## Sign-off` section of the vault draft. `outreach.get` gains `signoff: string` (stored or default) and `body: string`, the Gmail body exactly as `outreach.to_gmail` composes it (greeting line, Hook, Proof, Ask, sign-off); the agent's Gmail draft step uses `body`. `next_question` gains optional `max_items`, `max_chars` and `items` for list text questions: `voice.sample` keeps up to `VOICE_SAMPLES_MAX` (5) samples of at most `VOICE_SAMPLE_MAX_CHARS` (1500); a string answer appends one, a string[] answer replaces the list (removes items); `items` is the list kept so far. Voice data gains `signoff?: string` (`samples` unchanged, still a loose string list).
- Why: drafts read as bare fragments; Wassim wants real emails grounded in his Story, the role and the company, in his own voice, with several writing samples as style exemplars.
- Shim: none (all additions optional on input; older drafts without a sign-off get the default).
- Status: accepted

## First launch

### Seen first-visit cues in config
- Lane: first-launch (D)
- Date: 2026-10-08
- Contract: packages/contracts/src/policy.ts (`PolicyConfig.ui`, `DEFAULT_CONFIG.ui`)
- Change: optional `ui: { cues_seen: string[] }` (default `[]`): ids of the one-time first-visit cues already dismissed (wave1-decisions #27). The web UI saves it with `config.update { patch: { ui: { cues_seen } } }` (arrays replace); Settings "Show cues" saves `[]`. `DEFAULT_CONFIG` gains `ui: { cues_seen: [] }`. Mock mode keeps it in memory.
- Why: cues are shown once per screen and must stay dismissed across browsers and restarts, so the state lives in the vault, not localStorage.
- Shim: none (optional; a config.json without `ui` parses as before).
- Status: accepted (superseded by "Getting started flags in config", 2026-10-09)

### Getting started flags in config; `ui.cues_seen` retired (#24, #43)
- Lane: guided-path (D)
- Date: 2026-10-09
- Contract: packages/contracts/src/policy.ts (new `GuideState`, `DEFAULT_GUIDE`; `PolicyConfig.ui`, `DEFAULT_CONFIG.ui`)
- Change: `ui` is now `{ guide: { policy: boolean, review: boolean, done: boolean } }` (each default `false`; `ui` itself stays optional). `policy`: Settings was opened; `review`: River or Needs you was opened with scored roles; `done`: every Getting started step is finished and the card never shows again. The web UI sets them with `config.update { patch: { ui: { guide: { <flag>: true } } } }`; nothing in the UI clears them. Dev-only reset through `pp op config.update`. `ui.cues_seen` is removed: an older config.json that has it parses unchanged (the key is dropped on the next write). Fixture config (`FIXTURE_CONFIG`) has the guide finished (an established search); tests that walk the path patch it back.
- Why: the per-screen cues had no order and no "why", and a "Show cues" setting is not something a user should manage; guidance is a story that runs once and goes away (#24, #43).
- Shim: none (optional; an unknown `cues_seen` is stripped by the schema).
- Status: accepted

## Run status

### Run status `queued` (#21)
- Lane: run-status (B, D)
- Date: 2026-10-09
- Contract: `RUN_STATUSES` + new `RUN_ACTIVE_STATUSES` (enums.ts); registry `runsFinish.input.status`; migration `004_run_queued.sql`
- Change: `RUN_STATUSES` gains `queued` (first): a run waiting for its turn. `RUN_ACTIVE_STATUSES = ['queued', 'running']` (in progress). `runs.finish` takes neither `queued` nor `running` and now also closes a `queued` run (e.g. cancelled). 004 rebuilds `run` with the wider CHECK (no indexes, triggers or FKs involved; data copied as is). Nothing queues yet.
- Why: the run queue and automatic pipeline (#30), schedules (#29) and the guided path (#24) show queued, running and done/failed per run; the UI already treats `queued` as in progress (button label "Queued", no duplicate starts).
- Shim: none (additive; existing rows keep their status).
- Status: accepted

## Run queue and pipeline

### Run queue, `runs.dispatch`, config `runs` + `pipeline` (#30)
- Lane: pipeline-queue (B, D)
- Date: 2026-10-09
- Contract: registry `runsStart.input` (`triggered_by`), `runsStart.output` (`deduped`), new op `runs.dispatch`; policy.ts `PolicyConfig.runs`, `PolicyConfig.pipeline`, `DEFAULT_CONFIG`
- Change: `runs.start` is the single entry point for skill runs (UI, schedules, the pipeline). A human or schedule run is created `queued` (was `running`); an agent's own run is still `running` at once and never launched. A second active run for the same skill and scope (role, contact, outreach; research: the role's company, kept as `summary_json.company_id`) is not created: the existing one is returned with `deduped: true`. Optional input `triggered_by` (a run id) is kept as `summary_json.triggered_by` + `triggered_by_skill`. New op `runs.dispatch {}` -> `{ launched, queued, running }` (impact low, no events): launches queued runs oldest first, at most `config.runs.max_concurrent` running, never two running for one scope; `runs.start`, `runs.finish`, `pp up` (start + every 30 s) and the new `pp drain` call it. `runs.finish` applies config `pipeline` rules: `score_after_scout` (scout ended `ok`, inbox non-empty -> one score run for the inbox), `research_after_score` (score ended `ok`/`partial` -> one research run per company of a kept role with no dossier); the finished run gets `summary_json.triggered`. Config: `runs: { max_concurrent: 2 }`, `pipeline: { score_after_scout: true, research_after_score: true }`. No new event types (`run_started` payload gains `status` and `triggered_by`); no migration (`queued` came with 004).
- Why: scouted roles sat unscored in Inbox and new companies had no dossier unless someone started each run (#30); schedules (#29) enqueue through the same entry point.
- Shim: none (config sections default through `readConfig`; input and output fields optional).
- Status: accepted

## Schedules and run-linked ops

### Schedules run as OS jobs: `runs.start.schedule`, `schedules.status`, schedule helpers (#29)
- Lane: schedules (B, D)
- Date: 2026-10-09
- Contract: new `packages/contracts/src/schedules.ts` (`SCHEDULE_KEYS`, `ScheduleKey`, `SCHEDULE_SKILL`, `scheduleForSkill`, `SCHEDULE_JOB_STATES`, `ScheduleJobState`, `DAY_NAMES`, `parseSchedule`, `nextFire`, `prevFire`, `scheduleMissed`); registry `runsStart.input` (`schedule`), new op `schedules.status` + `ScheduleStatus`
- Change: schedule specs are local wall-clock times: `daily HH:MM`, `weekdays HH:MM`, `<day> HH:MM`, `<day>,<day> HH:MM` (sun..sat), or `off` (`ScheduleSpec` itself unchanged). `runs.start` takes optional `schedule` (a schedule key whose `SCHEDULE_SKILL` is the run's skill, else `invalid_input`), kept as `summary_json.schedule`; `scout_score` enqueues scout. New read op `schedules.status {}` -> `{ items: [{ key, skill, spec, on, next_run, last_run, job }] }` (impact low, no events): next local fire time, the latest run with that `schedule`, and the OS job state (`installed | missing | stale | off | orphan | manual | unknown`). Engine (not a contract): `EngineServices.scheduleJobs { status, sync }`; `config.update` that changes `schedules` calls `sync` after commit; `catchUpSchedules` for `pp up`. CLI: `pp schedules install|remove|status`, `pp run <skill> [--schedule]`, `pp setup` asks (`--no-schedules`), `pp up --no-catch-up`, doctor check `schedule_jobs`.
- Why: `config.schedules` was stored and shown but nothing ran it (#29). Owner picked option B (OS jobs) with `pp up` catch-up as the fallback.
- Shim: none (additive; existing runs have no `schedule` and count as never scheduled).
- Status: accepted

### Ops in a headless run carry its run id (#50)
- Lane: schedules (B)
- Date: 2026-10-09
- Contract: event `payload_json` (`run_id`), runner MCP server env (`PP_RUN_ID`)
- Change: the runner passes `PP_RUN_ID` in the pp MCP server's env (Claude `--mcp-config`, Codex `-c mcp_servers.pp.env.PP_RUN_ID`, Cursor `.cursor/mcp.json`); `pp-mcp` sets `ctx.runId` on every op. Any op run with `ctx.runId` records `run_id` in each event payload it emits (unless the payload sets one). The #30 research rule takes a score run's roles from `role_scored` events linked to it; only an agent's own run with no linked events falls back to unlinked events since it started.
- Why: a headless run's ops were not linked to the run, so the research rule guessed by event time and could pick up roles another session scored.
- Shim: none (old events without `run_id` are only read by the agent-run fallback).
- Status: accepted

## Scout yield and intake quality

### Scout targets, `scout.watchlist_scan`, roles.add intake check (#28, #32)
- Lane: scout-quality (B, F, G)
- Date: 2026-10-09
- Contract: policy.ts `PolicyConfig.scout` (`target_new_roles`, `max_queries`), `DEFAULT_CONFIG`; registry `rolesAdd.input` (`verify`), `rolesAdd.output` (`skipped`, `resolved`, `by_source`), new `IntakeCounts`, new op `scout.watchlist_scan`
- Change: config `scout` gains `target_new_roles` (default 25) and `max_queries` (default 30): the scout skill keeps building query variations until the run has added the target or spent the web-search budget. New read op `scout.watchlist_scan { companies?, include?, exclude?, jd_chars? }` -> `{ companies: [{ company, name, state: scanned | no_board | error, ats, board, listed, kept, reason? }], candidates: RoleCandidate[], dropped: { title, seniority, work_mode, location, known } }` (impact low, no events): lists every open posting on each company's Greenhouse / Lever / Ashby board (company row's `ats_type` + `ats_board`, else the slug probed on each ATS), drops clear title / seniority / work-mode / US-location misses from Craft and Work mode plus postings already in the pipeline, and returns the rest with a JD summary (default 400 chars). The watchlist share cap applies to watchlist **web queries** only; board scans are not queries and their role count is not capped. `roles.add` checks each new candidate URL before the transaction (skip with `verify: false`; no network for known roles): an aggregator URL (LinkedIn, builtin*, Indeed, Glassdoor, Wellfound, ZipRecruiter and others) is resolved to the company's ATS posting by title (similarity >= 0.7) and stored under that URL and job id (`resolved`), else skipped (`skipped[].reason = 'aggregator'`); an ATS URL is checked through the ATS API, anything else through the freshness page check, and dead postings (ATS closed, 404/410, redirect to a listing, closed phrase) are skipped (`reason = 'dead'`); a bot wall or network failure keeps the role with `freshness: 'unsure'`. Verified-open roles get `freshness: 'open'` + `last_checked_at`, and the ATS JD (plus location, posted date, workplace when missing). `by_source` counts per candidate source `{ candidates, added, duplicates, skipped_dead, skipped_aggregator }`; the run log shows the same table.
- Why: the first real scout run added 3 roles (#28); most posting pages were dead and one role linked to an aggregator (#32).
- Shim: none (new config fields default through zod, new output fields default; `verify` optional).
- Status: accepted

### Watchlist share of adds, `scout.max_per_company`, ranked board scans, achieved source mix (#67)
- Lane: source-mix (B, F)
- Date: 2026-10-09
- Contract: policy.ts `PolicyConfig.scout.max_per_company` (optional), new helpers `scoutMaxPerCompany`, `scoutWatchlistMaxAdds`; registry `IntakeCounts.skipped_cap`, `rolesAdd.output.skipped[].reason` (`watchlist_cap`, `company_cap`), `rolesAdd.output.watchlist_budget`, `scoutWatchlistScan.input.max_per_company`, `scoutWatchlistScan.output` (`companies[].capped`, `companies[].grouped`, `dropped.similar`, `dropped.company_cap`, `groups`, `max_per_company`)
- Change: config `scout.max_per_company` (unset = `scoring.company_active_cap` + 2, so 5 by default). `scout.watchlist_scan` ranks each company's filtered postings by title and profile fit (Craft functions / target +3, adjacent / explore +1.5, Domain words up to +2 by rank, -0.5 per level step from the Craft level; then newest, then listing order), groups near-identical titles (same company, title similarity >= 0.85; the best stands for the group, the rest are listed in `groups`), and returns at most `max_per_company` per company (input override), companies interleaved best first; `kept` counts what is returned, `capped` and `grouped` what is not. `roles.add` enforces the watchlist share on **adds**: within a scout run (ctx.runId when it is a scout run, else the latest running scout run; counted from the run's `role_added` events) source `watchlist` adds stop at `ceil(watchlist_share_max x target_new_roles)` (9 of 25 by default) and at `max_per_company` per company; over that a candidate is `skipped` with reason `watchlist_cap` / `company_cap` (counted in `by_source[].skipped_cap`, no network spent on it). Outside a scout run the limits apply per call. The output carries `watchlist_budget { run_id, target, max, added, remaining, max_per_company, open_added, open_needed }` whenever a scout run is open or the call has watchlist candidates; the run log shows the budget line and a Cap column. `runs.finish` on a scout run writes `summary_json.source_mix { target, added, watchlist, open, watchlist_max, watchlist_share, watchlist_share_max, by_source, by_company }` from the run's adds and a "Source mix" line in the log. Skill (not a contract): open-market search always runs until `open_needed` is 0 or `max_queries` is spent, even when board scans alone exceed the target. Not done: the score run does not skip roles the cap might hold, since held vs active depends on the role's own total (documented in `skills/scout/plan.md`, "Scoring cost"); the intake limit bounds that cost to `max_per_company - company_active_cap` per company per run.
- Why: a run on a big watchlist board added 38 roles, 30 from one company, ran no open-market query, then spent a 5-minute score run to hold or archive most of them (#67).
- Shim: none (new config field optional, new output fields defaulted or optional, new skip reasons only appear for watchlist candidates over the cap).
- Status: accepted

## Resume facts

### Kept source resume, `onboard.extract`, dictated answers, tailor fact check (#38)
- Lane: resume-facts (B, D, E)
- Date: 2026-10-09
- Contract: registry `onboardIngestResume.input` (`file`), `OnboardState` (`resume`), `onboardAnswer.input` (`raw`), new op `onboard.extract`, `applyTailor.output` (`fact_check`); profile-data.ts Story (`years_basis`, `source_path`, `source_file`, `extracted_by`) and every component (`dictated`); vault.ts `MARKDOWN_TYPES` (`resume_source`), `vaultPath.resumeText` / `resumeFile`; new `text.ts` (`cleanDictation`, `numberWordsToDigits`)
- Change: `onboard.ingest_resume` takes `file: { name, content_base64 }` (PDF, DOCX, MD, TXT) besides `text` / `file_path`; it keeps the resume in `files/` (`resume-<stamp>.md`, frontmatter type `resume_source`, the extracted text; plus `resume-<stamp>-original.<pdf|docx>`), links it from Story (`source_path`, `source_file`), and for a human actor queues a headless `onboard` run (`runs.start`). `OnboardState.resume = { source_path, file_path, parse_run_id }` (optional). The heuristic is only an instant preview and never infers a number: `years` only when stated (`years_basis: 'stated'`) or spanned by the role dates (`'from dates'`), which the new `story.years` question asks the user to confirm (`confirmed`) or leave out; `onboard.confirm` drops unconfirmed or basis-less years. New op `onboard.extract { story, craft? }` -> `{ target: 'session' | 'diff', state?, diff_id? }` (impact low, no events): the agent's verbatim extraction; every number, date, title, employer and degree must be in the kept resume text (`checkFacts`), else `invalid_input` with the list; it replaces the preview in the live onboarding draft (interview answers win) or, after onboarding, becomes a Story diff via `profile.propose_diff`. `onboard.answer` cleans free-text answers (`cleanDictation`: fillers and doubled words out) and keeps the raw text in `<component>.dictated[question_id]`; optional `raw` carries the original when the UI sent the cleaned text the user confirmed. `apply.tailor` fact-checks the resume and cover letter against the kept resume text + the confirmed Story (`storySourceText`; unconfirmed years excluded): an unsupported number, year, years-of-experience, date, degree or resume role heading rejects the op (`invalid_input`, `issues` = `[{ doc, kind, claim, line }]`); a title or employer named in prose that the sources (cover letter: plus the role, JD and dossier) lack is accepted and returned as `fact_check.needs_you`, listed in the fit map with a claim -> source line table and in the `application_tailored` payload. `vault.read` also serves the kept resume text linked from Story or the onboarding draft. Engine (not a contract): `VaultTx.writeBytes` / `readBytes`, `unpdf` dependency, runner `SKILL_ASSETS.onboard = ['extract.md']`.
- Why: a tailored resume stated "26 years" (#38): the resume was not kept, the heuristic guessed years from the earliest year in the text, a dictated win was stored with its fillers, and nothing checked the tailored facts.
- Shim: none (new input and output fields optional or defaulted; an old Story `years` without `years_basis` is simply not a fact source and is dropped on the next confirm). No migration.
- Status: accepted

## Scoring through the decision layer

### `roles.score` judges through the resolver; `system.backends` reports `not_installed` (#40)
- Lane: kev-scoring (F, I, D)
- Date: 2026-10-09
- Contract: registry `rolesScore.input` (`criteria` optional, `facts` defaults to `{}`, new `criteria_p`, `brand_terms`, `rescore`), `systemBackends.output.items[].status` (`not_installed`)
- Change: `roles.score` without `criteria` asks the resolver for C1..C9 (`roles.criterion`, low impact, typed `score` questions 1-5): one ask with the blind state for C1, C2, C3, C4, C9 (company and brand terms masked, plus `brand_terms`) and one with the full state for C5..C8, so Kev answers in one call per state; order rule -> Kev -> agent -> human. If no model answers: an attached agent gets `backend_unavailable` (nothing is queued; it judges and calls again with `criteria`), any other actor gets `requires_human` with the nine questions in Needs you; while they are pending a new call queues nothing, and once all nine are resolved the next call scores with the human answers. Supplied `criteria` are recorded as nine `agent` decisions (p from `criteria_p`, else `ctx.confidence`, else 0.75; `confidence` stays the MCP tool argument); Kev, when it answers, gives a second opinion on the same blind / open states (`answer_json.second`, `disagree: true` beyond one point). The score row's `facts_json` gains `criteria_source` (per criterion `{ backend, p, decision_id, latency_ms }`), and for agent criteria `second_opinion` (`kev` | `unavailable`) and `disagreements` (`[{ criterion, agent, kev, kev_p }]`). `rescore: true` (profile rescores) writes no decisions and keeps the carried sources. `system.backends` reports Kev as `not_installed` when it does not answer and `$PP_HOME/kev/installed.json` is missing, else `down`. Resolver (not a contract): `ResolverInstance.consult(backend, req)` (one backend, no decision row) and `record` options `second` / `extra`. Engine (not a contract): `EngineServices.kevInstalled`. UI: Role screen chips per criterion (source + confidence, coral with Kev's value on a split); Settings Kev card "Not installed" with `pp kev install`.
- Why: scoring bypassed the decision layer: never blind, never calibrated, no per-criterion decisions to learn from, and nobody could tell whether Kev was used (#40).
- Shim: none (all new input fields optional; old score rows have no `criteria_source` and show no chips; `not_installed` is a new enum value the CLI and Settings handle).
- Status: accepted

## Selective fill and fact-check decisions

### `apply.fill` classifies questions; Application defaults; `profile.set_defaults` (#42)
- Lane: fill-selective (B, D, E)
- Date: 2026-10-09
- Contract: registry `applyFill.input.answers[]` (`kind`, `field`, `country`, `confidence`, `reason`; `answer` defaults to `''`; `needs_human` requires `reason`), `applyFill.output` (`answers`, `counts`, `fact_check`), new op `profile.set_defaults`; profile-data.ts `ApplicationDefaults`, Terms `application_defaults`, `EEO_DEFAULT`, `FILL_KINDS`, `AUTOFILL_FIELDS`, `STANDARD_FIELDS`
- Change: the fill skill classifies each portal question `autofill` (identity and uploads), `standard` (sponsorship, work authorization by country, relocation, start date, notice, comp, office days, location, EEO, other) or `written` (default). The op lists autofill fields once as "Portal fills" with values from Story contact, else the kept resume text (name, email, phone, LinkedIn, GitHub) or the package paths (resume, cover letter), never flagged. Standard answers come from Terms `application_defaults` (`sponsorship`, `authorized_countries`, `relocation`, `notice_period`, `in_office`, `comp_expectation`, `eeo`, `answers` by field), falling back to Work mode (`relocation`, remote-only modes, `home_location` / `locations`) and Terms (`comp_target`, `comp_target_max`, `currency`); EEO defaults to "Prefer not to say"; with nothing saved the question needs the user with a one-line reason ("no saved work authorization for Canada"). Written answers are fact-checked like the cover letter (`checkFacts` against the kept resume + confirmed Story, titles and employers also from the role, JD and dossier); an unsupported claim, a `confidence` below `config.policy.second_opinion`, a drafter flag (legal or personal, with `reason`) or an empty draft needs the user, each with its reason. Output `answers` is needs-you first, then written, standard, portal fills; `answers.md` is grouped the same way (`## Needs you` with `> reason`, `## Written`, `## Standard`, `## Portal fills` as a list). Onboarding asks six full-sentence questions into `application_defaults` (sponsorship, authorized countries, relocation unless Work mode has it, notice, office days unless remote only, EEO). New op `profile.set_defaults { defaults }` -> `{ version | null, defaults }` (impact low, emits `profile_diff_proposed`, `profile_diff_applied`): merges the fields (empty string or list clears one) and proposes + applies one Terms diff: a human applies at once, any other actor goes through the resolver like every Terms diff. Engine (not a contract): a diff that only changes unscored keys (`application_defaults`, `notes`, `open_questions`, `dictated`) does not rescore. UI: Role Answers tab grouped; You > Terms "Application defaults" editor with one Save (`profile.set_defaults`).
- Why: Fill flagged every answer as needs-you, answered identity fields, and asked standard questions fresh each time (#42).
- Shim: old callers (`{ question, answer }`) still parse as written answers; `needs_human: true` without a `reason` is now `invalid_input`. New output fields default. No migration (Terms data is a loose object).
- Status: accepted

### Fact-check needs-you items as `apply.fact_check` decisions; `apply.resolve_claim`; migration 005 (#54)
- Lane: fill-selective (B, D, I)
- Date: 2026-10-09
- Contract: enums `DECISION_KINDS` (`apply.fact_check`), migration 005 (decision CHECK), registry `applyTailor.output.fact_check.needs_you[]` (`decision_id`, `doc`), new op `apply.resolve_claim`; resolver `KIND_IMPACT_FLOOR['apply.fact_check'] = 'medium'`
- Change: every needs-you claim from `apply.tailor` (resume, cover letter) and `apply.fill` (answers) is recorded as an `apply.fact_check` decision (subject the role, impact medium, backend `rule`, always the human): a `choice` question `keep | remove | other` carrying `doc`, `kind`, `claim`, `line` and `source` (the nearest source line by shared words, `nearestSource`, or null), pick `remove` at p 0.5 (truth only), action `apply.resolve_claim { role_id, doc, line, value: '$value' }`. Before queuing, the pending fact-check decisions for the same role and documents are expired (a re-tailor or re-fill replaces them). New op `apply.resolve_claim { role_id, doc: resume | cover_letter | answers, line, value }` -> `{ changed, path }` (impact low, no events): `keep` leaves the document, `remove` drops the line (and a doubled blank line), any other text replaces the line (indent kept); a line no longer in the document changes nothing. Migration 005 rebuilds `decision` (12-step, as 002) with the new kind. Facts (not a contract): an employer at the end of a sentence is checked without its period. UI: Needs you shows `Keep "<claim>"?` with the document line and source as evidence; Change offers the other choice plus an Edit field whose Save resolves with the new text (`decisions.resolve` change).
- Why: tailor's needs-you claims only showed in the fit map and op output; the user had no place to act on them (#54).
- Shim: none (new kind, new optional output field; old decisions untouched).
- Status: accepted

## Contact emails

### Contact `email_source` + `email_confidence`, `people.find_email`, decision kind `people.email`, draft recipient; migration 006 (#37)
- Lane: contact-emails (H, B, D, I)
- Date: 2026-10-09
- Contract: enums `EMAIL_SOURCES` / `EmailSource`, `DECISION_KINDS` (`people.email`); entities `Contact` (`email_source`, `email_confidence`); migration 006 (contact columns + decision CHECK); registry new op `people.find_email`, `EmailCandidate`, `DraftRecipient`, `outreachGet.output` (`to`), `outreachToGmail.output` (`to`, `to_reason`); resolver `KIND_IMPACT_FLOOR['people.email'] = 'medium'`
- Change: a contact's email carries its source (`gmail`, `linkedin`, `public`, `pattern`, `provider`, `manual`; null without an email) and a confidence 0..1. New op `people.find_email { contact_id, role_id?, hints?: [{ email, name?, source: gmail | linkedin | public }], domain?, value? }` -> `{ contact, email, source, confidence, confirmed, domain, mx, pattern, candidates: [{ email, pattern, p }], decision_id, outcome, reason }` (impact low, no events). Known first: the contact's own known address is kept; a hint naming the person, or an unnamed address at the company domain that spells their full name (JD, dossier, hints), is stored with its source (Gmail, LinkedIn, manual at 1; public at 0.9). Otherwise pattern inference (engine mechanics): the domain from the company row, else `domain`, else the dossier ("Website:" / "Domain:"), else a hint domain containing the company slug; the format (`first.last`, `flast`, `first`, `firstl`, `f.last`, `last`) is learned from addresses at the domain (known contacts linked to the company, hints, JD, dossier; role mailboxes ignored), candidates ranked by posterior (prior x 0.3 + evidence), times 0.3 when the domain has no MX record (injectable MX resolver, DNS by default, faked in tests; never SMTP). The top pick is recorded as a `people.email` decision (backend `rule`, medium impact floor, a `choice` of up to four candidates + `other`, with `name`, `domain`, `mx`, `pattern`, `examples`, `candidates`; action `people.find_email { contact_id, role_id, value: '$value' }`); earlier pending ones for the contact expire. The guess is stored either way (`pattern` or `provider`, confidence p); it counts as confirmed only at the `people.email` auto threshold. A human pick (`value`) is stored at confidence 1 (`pattern` when it is one of the guesses, else `manual`); a non-human `value` without a decision is `invalid_input`. `people.find` stores the source and confidence of addresses it sees, and a known address replaces a guess. `outreach.get` returns `to` (the contact, or the mutual for bridge drafts: `email` only when confirmed or at the threshold and no `people.email` decision is pending, else null with `reason`, plus the unconfirmed `guess`); `outreach.to_gmail` creates the engine-client draft with that To and returns `to` / `to_reason`. Migration 006 adds the two columns (ALTER TABLE ADD COLUMN with CHECKs), backfills existing addresses as known (Gmail / LinkedIn / manual at 1, JD and company site as `public` at 0.9) and rebuilds `decision` (12-step, as 005) with the new kind. Engine (not a contract): `EngineServices.mx`, `EngineServices.emailProvider` (typed seam for Hunter / Apollo; pinned, no adapter); runner: a full `connect` run loads the Gmail connector (no strict MCP config) and pre-approves Gmail `search_threads`, `get_thread`, `get_message` only, with send, reply, forward, delete and trash denied; the Gmail draft prompt takes To from `outreach.get`'s `to`. UI: People rows and the Outreach recipient show the address with its source and confidence ("Guess 45%"); Needs you shows `Use <address>?` with the other candidates and an Edit field.
- Why: connect found people but rarely an address, so Gmail drafts had no recipient (#37).
- Shim: none (new columns nullable, new output fields default; old contacts with an email and no source count as known).
- Status: accepted

## Ask agent session

### `AskChatRequest` / `AskChatEvent`, `POST /api/ask`, `runs.start.queue` (#39)
- Lane: ask-agent (B, D, J, CLI, MCP)
- Date: 2026-10-09
- Contract: new `ask.ts` (`AskChatContext`, `AskChatRequest`, `ASK_CHAT_ERROR_CODES`, `AskChatEvent`, `askChatFrame`, `parseAskChatFrames`); registry `runsStart.input.queue` (optional boolean)
- Change: Ask (Cmd+K) is a real agent session. `pp up` serves `POST /api/ask` with `AskChatRequest { thread_id?, message, context?: { screen?, role_id? } }` and streams Server-Sent Events of `AskChatEvent` (`thread { thread_id, runner }`, `text { delta }`, `tool { id, name, op }`, `tool_result { id, ok }`, `run { run_id, skill }`, `error { code: runner_missing | not_logged_in | runner_failed | busy | invalid_input | unavailable, message }`, `done`). Each message runs one turn of `config.runner` with the pp MCP server (all pp tools, web search and fetch; no shell, no file writes) and a system prompt (act through ops, the policy, never submit or send, reply in OpenUI Lang with the id-only genui cards). Threads continue with Claude Code `--resume <session_id>`; Codex and Cursor replay the last turns. `runs.start` takes `queue: true`: an agent asks for a queued headless run instead of being the run itself (`summary_json.actor: "ask"`, a queue run like a human's); the Ask MCP server (`PP_ASK=1`) sets it by default. Not a contract: threads live in `pp up` memory; the web `OpClient` gains optional `ask()`; the mock answers Ask from fixtures with the old local compose.
- Why: Ask built replies locally and could not run anything; "score my inbox roles" did nothing (#39).
- Shim: none (new endpoint, new optional input; an agent without `queue` keeps today's behavior).
- Status: accepted

## Onboarding interview

### Full-sentence questions, "I don't know", resume-adaptive interview, `onboard.propose_questions`; migration 007 (#23, #22)
- Lane: onboarding-interview (B, D, E)
- Date: 2026-10-09
- Contract: registry `OnboardState.next_question` (`example`, `kind`, `suggested`), `OnboardState.resume_drafts`, `onboardAnswer.input` (`value` optional, `skip`), `onboardExtract.input` (`drafts`), new `OnboardProposedQuestion` and op `onboard.propose_questions`; entities `OnboardSession.interview_json` + migration 007; profile-data.ts every component (`follow_ups`)
- Change: every question in the bank is a full sentence (`label`) with an optional one-line `example`; duplicates are gone (Company affinity "Which companies would you love to work at?" then Network "Where do you already know people who could introduce you?"; industries only in Domain avoid, not in Dealbreakers; a relocation hard no answers the relocation default, which now comes last with the other Application defaults). `onboard.answer { question_id, skip: true }` answers "I don't know": the id is answered, the draft unchanged, the id kept in the plan's `skipped`; without `skip` a `value` is required (`invalid_input`). The session keeps an interview plan in `onboard_session.interview_json` (`{ hints, questions, skipped }`): `onboard.ingest_resume` drafts hints per component the resume informs (Story headline, Craft functions / level / mode, Domain ranked, Growth scope and trajectory, Voice style from the resume's own writing), each with a confidence 0..1 and the lines it rests on. With a hint at 0.7 or more a full onboarding opens that component with `next_question.kind = 'confirm'` (id `confirm.<component>`, label "Looks like ... Right?", chips `yes` / `edit`): `yes` writes the draft (resume + interview sources), `edit` removes it and asks the component's questions with the draft as `suggested`; a lower confidence only pre-fills (`suggested`). `state.resume_drafts` lists `{ component, confidence, items, by: preview | agent }`. `onboard.extract` takes optional `drafts { craft | domain | growth | voice: { data, confidence, evidence? } }` that replace the preview hints (and the extracted Story's headline becomes the Story hint); a component whose confirm was answered keeps its hint, and the agent's craft replaces the preview's except fields the user answered. New op `onboard.propose_questions { questions: [{ component, label, example?, answer_type: chips | multi_chips | text, options?, reason? }] }` -> `{ added, rejected: [{ label, reason }], state }` (impact low, no events): the onboard agent's follow-ups, asked after the component's bank questions (`kind: 'follow_up'`, ids `follow.<n>`), at most 6 per session, rejected when not a full sentence ending in ? or ., with an em or en dash, chips without two options, outside a re-interview's scope, or a near duplicate (content-word overlap >= 0.6) of a bank question or an earlier follow-up; refused (`conflict`) once the interview is over. Answers are kept in the component's `follow_ups` (`[{ question, answer }]`, unscored). UI: the Onboarding question shows the component it fills ("Q 3 · Craft"), the sentence, its example, Yes / Edit chips on confirms, a pre-filled suggestion, an "I don't know" button (`onboard.answer`), and what was pulled from the resume per component with its confidence (after the drop and beside each question).
- Why: the interview ignored the uploaded resume (#22) and asked unclear or duplicate questions ("Warm companies", #23).
- Shim: none for callers (new input fields optional, new output fields defaulted). Migration 007 is additive (`ALTER TABLE onboard_session ADD COLUMN interview_json TEXT NOT NULL DEFAULT '{}'`); an older session resumes with an empty plan (the bank only).
- Status: accepted

## One profile experience

### `onboard.start { calibrate }`; You primary Recalibrate calls `onboard.start` (#25)
- Lane: one-profile (D, E)
- Date: 2026-10-09
- Contract: registry `onboardStart.input.calibrate` (optional boolean); ui.ts `PRIMARY_ACTIONS.you` Recalibrate op `onboard.start` (was `null`), `PRIMARY_ACTIONS.onboarding` gains `Save` (`onboard.confirm`)
- Change: `onboard.start { calibrate: true }` starts a recalibration: a session at the `calibrate` step with an empty scope, seeded from the current profile (`not_found` without one). Its prior is the current profile's weights as they are (no stated nudges re-applied), so `onboard.samples` bars start there; `onboard.calibrate` works as in full onboarding; `onboard.confirm` refuses (`conflict`) with no card answered, else writes only the weighted components as a new version with reason `onboard: recalibrate`. UI (not a contract): Setup and You are one place. The Setup rail entry is gone; a fresh vault lands on You, which is setup (resume, interview, calibrate, confirm) until a profile exists. With a profile You shows the constellation; a selected component has **Re-interview** (`onboard.start { components: [key] }`) and the primary **Recalibrate** (`onboard.start { calibrate }`), both running the same steps in place (`#/you/interview`, `#/you/calibrate`; `#/you/setup` redoes everything; old `#/onboarding` links open it) and ending in **Save** (`onboard.confirm`); recalibration's confirm step shows every criterion's weight before and after.
- Why: Setup and You / Recalibrate were two places for one profile, and Recalibrate had no session to calibrate in (#25).
- Shim: none (new optional input; without `calibrate` `onboard.start` is unchanged).
- Status: accepted

## Small follow-ups

### `ask_thread` table, `AskThreadRow`, `ID_PREFIX.ask_thread`; migration 008 (#69)
- Lane: small-followups (A, D, J, CLI)
- Date: 2026-10-09
- Contract: entities `AskThreadRow` (`id`, `created_at`, `updated_at`, `runner` in `RUNNER_COMMANDS`, `session_id` nullable, `turns_json: [{ user, reply }]` at most `ASK_THREAD_MAX_TURNS`), `AskThreadTurn`, `ASK_THREAD_MAX_TURNS` (20), `ASK_THREAD_TTL_DAYS` (30), `TABLES.ask_thread`; primitives `ID_PREFIX.ask_thread = 'ask'`; migration 008
- Change: Ask threads survive a `pp up` restart. `pp up` keeps each thread in the vault (`ask_thread`): the runner, the runner's session id (Claude Code `--resume`) and the last 20 turns (Codex and Cursor still replay the last 6). `POST /api/ask` with a `thread_id` not in memory restores it from the table; a changed runner or an unknown id still starts a new thread. Threads not updated for 30 days are pruned when `pp up` opens Ask and on every new thread. Engine (not a contract): `AskThreads({ store?, now?, max? })`, `dbAskThreadStore(db)` in the db layer (raw SQL stays there); thread ids are `ask_<ulid>`. Not an op: conversation state written only by the Ask turn, never by skills, agents or MCP. Web (not a contract): the current thread id is kept in `localStorage` (`pp.ask.thread`, guarded), so reopening the app continues the thread; New thread clears it. Migration 008 is additive (`CREATE TABLE ask_thread` + index on `updated_at`).
- Why: a restart lost the conversation and the Claude session (#69).
- Shim: none (new table; `new AskThreads()` without a store keeps the in-memory behavior; the request contract is unchanged).
- Status: accepted

## Hybrid work-mode filter

### Work mode `remote_only`, `hard_nos`, `by_location`, `outside_locations`; `isRemoteOnly`; op `roles.reevaluate_filters` (#83)
- Lane: r2/01-hybrid-filter (F, E, B)
- Date: 2026-10-09
- Contract: profile-data.ts `WORK_MODES` / `WorkMode`, `isRemoteOnly`, Work mode `remote_only` (boolean), `hard_nos` (modes), `by_location` (`[{ location, modes }]`), `outside_locations` (`verify` | `fail`); registry new op `roles.reevaluate_filters` and `ReevaluatedRole`
- Change: the work-mode filter honors the profile instead of treating `modes: ['remote']` as remote required. Remote, flexible or `remote_ok: true` passes. Hybrid or onsite: a mode hard no (Work mode `hard_nos`, or a Dealbreakers hard no that names only the mode, e.g. "onsite only") is hit `work_mode_hard_no`; explicit `remote_only: true` is `remote_required`; a `by_location` entry for the role's place decides (mode not listed: `work_mode_location`); a place in `locations` passes; elsewhere is a `location` verify flag, or `work_mode_location` with `outside_locations: 'fail'`; no known place is a `location` flag. Unknown mode is a `work_mode` verify flag (was `remote`), never a hit. The place is the new `facts.location`, else the role row's location (and workplace). Scout's remote-only drop, the fill office-days answer and the onboarding office-days question key off `isRemoteOnly`; onboarding asks a new `work_mode.remote_only` question only when remote is the one mode picked. New op `roles.reevaluate_filters { dry_run?, role_ids? }` -> `{ items: [{ role_id, old_hits, hits, verify, passes, total, band, decision_id, skipped }], queued }` (impact low, no events): `dealbreaker` archives whose latest score hits were all work-mode hits (`remote_required`, `work_mode_hard_no`, `work_mode_location`) are re-checked under the current profile; each that passes and is green gets a `roles.move` decision (question id `restore`, noulli, medium, `forceHuman`: always Needs you) whose action is `roles.score { rescore: true }` with the stored criteria and judged facts (`when: true`); a pending one is not duplicated; `dry_run` writes nothing.
- Why: the engine applied remote required to hybrid roles in an accepted location (NYC) and archived them as `dealbreaker` (#83).
- Shim: none for callers (all new fields optional). A profile that really is remote only sets `remote_only: true` (fixtures do). Existing archives are not touched until the owner runs `roles.reevaluate_filters` and accepts each restore.
- Status: accepted

## Gmail tools per skill

### `SKILL_TOOLS[skill].gmail`; `GMAIL_WRITE_TOOLS`, `gmailDeniedTools`; inbox reads Gmail, connect creates drafts (#80, #79)
- Lane: r2/02-gmail-tools (B, H, runs)
- Date: 2026-10-09
- Contract: engine runner `SKILL_TOOLS` (new `gmail` field per skill), `skillAllowedTools`, new `GMAIL_PREFIX`, `GMAIL_WRITE_TOOLS`, `gmailDeniedTools`; `GMAIL_DENIED_TOOLS` widened; every `skills/<skill>/SKILL.md` gains a `## Tools` section
- Change: `inbox` is granted the claude.ai Gmail connector's `search_threads`, `get_thread`, `get_message` (was pp only); its Claude Code run drops `--strict-mcp-config` so the connector loads, keeps `--tools ""` and `dontAsk`, and denies every Gmail write (`GMAIL_WRITE_TOOLS`: send, reply, forward, draft create / update / delete, trash / untrash, spam, labels). A full `connect` run is granted `create_draft` too and finishes its own Gmail drafts (chosen over always queuing a `connect { outreach_id }` run: one run, no extra queue hop, same draft-only guard); every other Gmail write is denied (`GMAIL_DENIED_TOOLS` = writes minus `create_draft`, also used by the Gmail draft step, which stays for the UI's Create Gmail draft). The run prompt's Tools line lists the Gmail tools. Each SKILL.md declares its allowlist in `## Tools`; `runner.test.ts` fails on drift, on a Gmail tool a SKILL.md names but its skill lacks, on made-up `gmail_*` tool names, and on any write granted to a read-only skill.
- Why: the inbox run was denied `gmail_search_messages` / `gmail_read_message` (wrong names, empty allowlist) (#80); the full connect run was denied `create_draft` (#79).
- Shim: none. Codex and Cursor are unchanged (they use the Gmail MCP server the user configured).
- Status: accepted

## LinkedIn read agent-side

### `people.find` LinkedIn hints and provenance; `PeopleFindHint`, `LINKEDIN_SKIP_REASONS`, `LINKEDIN_PROVENANCE` (#82)
- Lane: r2/03-linkedin (H, runs)
- Date: 2026-10-09
- Contract: registry new `PeopleFindHint` (source adds `linkedin`; optional `degree`, `via { name, headline?, linkedin_url }`, `hiring_team`), `peopleFind.input.hints` max 20 -> 60, new `peopleFind.input.linkedin { pages_opened, skipped? }`, new optional `peopleFind.output.linkedin { mode, people, rejected, budget_left, reason }`, new `LinkedInSkipReason` / `LINKEDIN_SKIP_REASONS`, `LinkedInProvenance` / `LINKEDIN_PROVENANCE`; engine runner `SKILL_TOOLS[skill].chrome`, `CHROME_PREFIX`, `CHROME_READ_TOOLS`, `CHROME_WRITE_TOOLS`, `BUILTIN_WRITE_TOOLS`, `connectDeniedTools`, `usesChrome`, `linkedinLine`, `skillAllowedTools(skill, { linkedin })`, `buildRunnerSpec({ linkedin })`, `PromptContext.linkedin`; LinkedIn adapter types narrowed to `dry-run` / `recorded`
- Change: LinkedIn is read by the agent (wave1-decisions #4, #6). A full `connect` run launches Claude Code with `--chrome` when `config.linkedin.mode` is `live` (`off` / `dry-run`: no Chrome), pre-approves only the Chrome `tabs_context_mcp`, `tabs_create_mcp`, `navigate`, `get_page_text`, `read_page`, `find`, denies `computer`, `form_input`, `javascript_tool`, `browser_batch`, `file_upload`, `upload_image`, `shortcuts_execute`, `gif_creator`, Bash / Write / Edit / NotebookEdit and every Gmail write but `create_draft`, and runs `dontAsk`; its prompt states the caps and today's remaining profile budget. The skill reads the 1st-degree connections search, the company People page and up to `max_mutual_expansions` mutual lists, then calls `people.find` with `source: "linkedin"` hints and `linkedin.pages_opened` (or `skipped`). `people.find` accepts LinkedIn hints only when the mode is `live`, keeps only linkedin.com `/in/<slug>` profile URLs (canonicalized; others rejected), counts each person and new via mutual against `max_profiles_per_day` (hints beyond it rejected, `capped: true`), keeps a via for at most `max_mutual_expansions` 2nd-degree people, flags `linkedin_over_page_cap` (run `partial`) past `max_pages_per_run`, and sets `is_hiring_team` (tier follows) on a hiring-team signal. The run row records `linkedin_mode` honestly (`agent` only when the agent read LinkedIn; `dry-run` otherwise, the recorded adapter included; `off`), `linkedin_people`, `linkedin_reason`, `linkedin_rejected`, `linkedin_profiles_read`, `linkedin_pages_opened`, `linkedin_budget_left`. The engine-side live driver path is gone: `createLinkedInAdapter` runs the recorded driver in `dry-run` only. `config.linkedin.mode: live` now means "the agent reads via Chrome"; `driver` is kept for config compatibility (only `claude-in-chrome` is used). UI (not a contract): People shows `LinkedIn: N people` or `LinkedIn not read · <reason>` from the role's latest `people.find` run.
- Why: LinkedIn was never read; every run said `dry-run` with 0 pages (#82).
- Shim: none for callers (all new input and output fields optional; old hints still parse). Run rows from before carry only `linkedin_mode`, shown as not read.
- Status: accepted

## Inbox dead postings

### `FRESHNESS_SCOPE` gains `inbox`; `roles.check_freshness { precheck }`; unverified close; Pass (#77)
- Lane: r2/04-inbox-dead-postings (G, runs, B, D)
- Date: 2026-10-09
- Contract: enums `FRESHNESS_SCOPE` (adds `inbox`, first); registry `rolesCheckFreshness.input.precheck` (optional boolean). Not contracts: resolver `AskOptions.thresholds` / `effectiveThresholds` per-call override widened to `Partial<KindThresholds>` (`confident_outcome` included); engine `FreshnessDeps.record`, `FreshnessStore.expirePendingCloses`, `UNVERIFIED_CLOSE_AFTER`, `UNVERIFIED_P`, `HARD_CLOSED_P`, `scoutRunAdds` rows carry `role_id`
- Change: the daily freshness run checks inbox roles too (an automated close of an inbox role is a plain archive, reason `closed`). Pipeline: when a scout run ends `ok` and `score_after_scout` is on, `runs.finish` first runs `roles.check_freshness { role_ids, precheck: true }` over the inbox roles that run added and intake did not confirm open (linked to the scout run; `summary_json.precheck { checked, closed, unsure }` and a log line); with `precheck`, hard closed evidence (ATS gone, 404/410, closed phrase, listing redirect) archives on a rule `freshness.closed` decision (p 0.97, plain grid: auto) without asking a backend, and only an inconclusive check asks the resolver. The score run is queued only if the inbox still has roles, so closed ones are never scored. Unverified: every unsure check bumps `flags_json.unverified_checks` (open clears it); the 2nd in a row expires the role's pending `freshness.closed` decisions and records a rule decision "not open" with p by what the check saw (contradicted closed evidence 0.97, no ATS match or no URL 0.95, bot wall 0.93, a page that loads with nothing decisive 0.75) and per-call `confident_outcome: 'auto_undo'`: confident -> archived `closed` with a 24h undo back to the prior status; else Needs you with the archive action. UI (not a contract): **Pass** (`roles.archive { reason: 'passed' }`, a human actor so it runs directly) on an inbox Role screen (secondary, next to Open posting) and on River Inbox tiles (hover or focus menu); Shift-click selects Inbox tiles and **Pass N** (with **Clear**) passes them together.
- Why: dead or unverifiable postings sat in Inbox: freshness skipped Inbox and Score all scored them anyway (#77).
- Shim: none (new input optional; roles in inbox were never checked before, so they start with no unverified count).
- Status: accepted

## No-contact fallback

### Ops `people.fallback`, `apply.skip_connect`; `CONNECT_FALLBACKS`, `TeamInboxHint`, roles.get `connect` (#78)
- Lane: r2/05-no-contact-fallback (H, B, D)
- Date: 2026-10-09
- Contract: enums `CONNECT_FALLBACKS` / `ConnectFallback` (`team_inbox`, `cold_leader`, `skipped`); registry new op `people.fallback` (owner H, low, emits `contact_found`) with `TeamInboxHint`, new op `apply.skip_connect { role_id, reason }` -> `{ application, skipped }` (owner B, low), `ConnectState` and `rolesGet.output.connect` (`{ fallback, reason, contact_id, at }`, default null)
- Change: Connect never stalls when `people.find` yields no usable contact (none, or every link `cold_other`). `people.fallback { role_id, team_inbox?, leader?, domain?, email_hints?, reason? }` picks in order: (1) a hiring-team or recruiting address: the agent's `team_inbox` hints (JD, careers page, dossier, company site) plus team mailboxes the engine finds in the JD and dossier, kept only at the company domain or a subdomain; a named recruiter first, then `recruiting`, `recruitment`, `recruiter(s)`, `talent`, `hiring`, `careers`, `career`, `jobs`, `people`, `hr`, `apply` (never `info@` and other role mailboxes). It becomes a contact named "Hiring team" (or the recruiter), `email_source: public` (0.9), linked `degree: cold`, `tier: cold_hiring`, `is_hiring_team: true` (no new contact kind: chosen over a `team_inbox` contact column, which would need a migration). (2) Else the likely hiring leader from the dossier (`leader`) as a `cold_hiring` contact, and `people.find_email` guesses the address (#37: flagged as a pattern guess; unsure -> `people.email` in Needs you, no To until confirmed). (3) Else Connect is skipped: the application moves `connect` -> `fill`. A role with a usable contact returns `fallback: null`. The fallback used is recorded as a finished run row (op `people.fallback` or `apply.skip_connect`, `summary_json { role_id, fallback, reason, contact_id }`) and `roles.get` returns the latest as `connect`. `apply.skip_connect` moves `connect` -> `fill` (a draft-ready role with an earlier or missing application too; past Connect a no-op with `skipped: false`; not yet tailored -> `conflict`; archived -> `forbidden_transition`). Drafts to a fallback contact (engine not a contract): the writer prompt and `templateDraft` use the tailored cover letter (`applications/<role>/cover_letter.md`, title, salutation and closing dropped) as the Proof / Ask basis, greeting "Hi <Company> team," for a team inbox; `outreach.draft` and `outreach.to_gmail` ground such drafts in Story plus the cover letter (it passed the apply.tailor fact check); other drafts are unchanged (Story only). UI (not a contract): Role (People column; mobile under the best path) and People show the fallback used ("Hiring team", "Cold leader", "Skipped") and a **Skip** (`apply.skip_connect { reason: 'user' }`) whenever the role is on the Connect stage. `skills/connect/SKILL.md` gains "No usable contact".
- Why: a draft-ready role with no people found sat in Connect with no way forward (#78).
- Shim: none (new ops; `connect` defaults to null, so older callers and the mock parse unchanged).
- Status: accepted

## Fill reads the portal

### Op `apply.set_questions`; `apply.fill { source }`, `ANSWER_SOURCES`; `APPLICATION_FILES.questions` (#81)
- Lane: r2/06-fill-browser (B, runs)
- Date: 2026-10-09
- Contract: registry new op `apply.set_questions { role_id, questions_text, run? = true }` -> `{ application, path, count, run | null }` (owner B, low); new `AnswerSource` / `ANSWER_SOURCES` (`fill`, `ask`); `applyFill.input.source` (default `fill`), `applyFill.output.answers[].source` (optional); vault `APPLICATION_FILES.questions` (`questions.md`), `MARKDOWN_TYPES` adds `application_questions`; engine runner `SKILL_TOOLS.fill.chrome = CHROME_READ_TOOLS`, `chromeDeniedTools(skill)`, `fillLine`, `PromptContext.questions`, `usesChrome` (fill always, connect only when LinkedIn is live)
- Change: a fill run reads the portal through Claude in Chrome: `--chrome`, no strict MCP config (as for connect), built-ins narrowed to WebFetch, only `tabs_context_mcp`, `tabs_create_mcp`, `navigate`, `get_page_text`, `read_page`, `find` pre-approved, and `computer` (click and type), `form_input`, `javascript_tool`, `browser_batch`, `file_upload`, `upload_image`, `shortcuts_execute`, `gif_creator`, every Gmail write and Bash / Write / Edit / NotebookEdit denied (`dontAsk`). There is no click-only tool, so other tabs and steps are read by navigating to their URLs; unreadable questions end the run as error ("portal questions unreadable"). Paste fallback: `apply.set_questions` (draft-ready roles only, else `conflict`) writes `applications/<role>/questions.md`, records package path `questions`, and queues a fill run (a human's queued, an agent's `queue: true`; an active fill run is reused, `deduped`); the run's prompt names the file and says not to read the portal for questions. Ask: an Ask session's MCP server defaults `apply.fill` to `source: "ask"`; an Ask save merges into the saved answers (same question, case-insensitive, replaced; others kept), a fill save replaces its answers and keeps earlier Ask answers to questions it does not answer. The filed answers ride in the answers file's frontmatter (`answers: [...]`, one JSON line written and read only by `apply.fill`, kept in step by `apply.resolve_claim`); the body is never parsed. answers.md shows `_Saved from Ask_` under such an answer. UI (not a contract): Role > Answers on a draft-ready role has **Add questions** (textarea + **Run**, `apply.set_questions`) and a **Saved from Ask** tag on Ask answers. The Ask system prompt and `skills/fill/SKILL.md` document saving an Ask answer with `apply.fill`.
- Why: a fill run could not see questions on another tab of the portal (WebFetch only) and refused, correctly; Ask's saved answer worked but had no provenance (#81).
- Shim: none; `source` defaults to `fill`, answers filed before #81 have no frontmatter list (an Ask merge then starts from the new answers only) and read as `fill`.
- Status: accepted

## Onboarding inputs

### Question `answer_type: 'list'`, `unit`, `step`; `formatMoney` / `formatMoneyRange` / `parseMoney`; UI inventory `ChipInput`, `SliderInput` (#73, #75)
- Lane: r2/07-onboarding-inputs (E, D)
- Date: 2026-10-09
- Contract: registry `OnboardState.next_question.answer_type` adds `list`; new optional `next_question.unit` (`money` | `percent`); `next_question.step` (already in the schema) is now sent; new `money.ts` exports `formatMoney(n, { full?, currency? })`, `formatMoneyRange(min, max, opts)`, `parseMoney(text)`; `ui.ts` `COMPONENTS` adds `ChipInput`, `SliderInput`. Not contracts: engine `AnswerType` adds `list`, `QuestionDef.step` / `unit`, `asList` splits on commas and new lines and drops duplicates; web `k` helper removed.
- Change: free multi-value questions (`work_mode.locations`, `company.dream`, `network.warm`, `dealbreakers.other`, `defaults.authorized_countries`) are `list`: answered with a string[] (one chip per entry); a comma or new line separated string still parses; an empty list is refused. A list resume suggestion is sent as a string[]. Comp sliders (`terms.floor`, `terms.target`) carry `unit: 'money'`, `step: 1000`; travel carries `unit: 'percent'`, `step: 5`. Money is formatted by the one shared formatter: compact `$212.5k`, `$300k`, `$1.2M`, or full `$300,000` (portal answers); a `k` never follows a full number. `parseMoney` reads `212500`, `$212,500`, `212.5k`, `1.2M`, and treats `300,000k` as 300,000. Uses: onboarding calibration cards (`onboard.samples` `comp`, was `$180k to $240k` rounded, now one decimal), the Fill comp expectation answer (unchanged output), and in the UI (not contracts): the onboarding slider (number field + slider in sync, 1k steps, 5k with Shift), the confirm filters, You chips (Terms comp fields), Role facts Comp (was `180k to 240k`, now `$180k to $240k`, currency aware), Application defaults (a bare amount typed as Comp is saved as `$300,000`). `ChipInput` (Enter / Tab add, Backspace on empty removes the last, x removes, paste splits on commas and new lines, duplicates ignored) is used for every `list` question and the Application defaults Work countries. The tailor and fill skills name the money format.
- Why: the salary slider moved only by 5k with no exact entry and showed a `k` after a full number (#73); multi-value answers were comma separated text (#75).
- Shim: none for callers: `list` answers still accept a comma string, `unit` is optional and an older UI falls back to text for an unknown `answer_type`. Proposed follow-up questions keep `chips` / `multi_chips` / `text`.
- Status: accepted

## Persona options and Voice

### `next_question.other`; `onboard.extract { options }`, `OnboardOptions`; op `scout.plan`; Craft `titles` (#74)
- Lane: r2/08-persona-voice (E, B, D)
- Date: 2026-10-09
- Contract: registry `OnboardState.next_question.other` (optional boolean), new `OnboardOptions` (`persona?`, `functions?`, `levels?`, `titles?`, `domains?`, `scopes?`: 2 to 12 entries of at most 60 chars) as `onboardExtract.input.options`, new read-only op `scout.plan {}` -> `{ persona, titles, domains, locations }` (owner B, low); profile-data Craft `titles` (TextList). Not contracts: engine `profile/persona.ts` (`PERSONAS`, `FUNCTION_TITLES`, `FALLBACK_OPTIONS`, `detectPersona`, `personaOfCraft`, `previewOptions`, `titleVariations`), `InterviewPlan.options`, `QuestionDef.persona` / `other`, `optionsOf(q, draft, plan)`, `OTHER_MAX_CHARS`, resume heuristic functions for sales, account management, business development, marketing, design and customer success.
- Change: Craft functions, Craft level, a new `craft.titles` question ("Which job titles should we search for?", multi chips, after `craft.facing`), Domain ranked and Growth scope ceiling take their options from the resume's persona instead of a fixed product list: the onboard agent run sends `options` with its extraction (kept in `interview_json.options`, `by: 'agent'`); until then the instant preview derives them from the resume's titles (`by: 'preview'`); a re-interview with no resume uses the persona of the Craft draft; the old lists are the fallback. The resume's own values (titles first, domains) and the draft's current values are always among the options. Those questions carry `other: true`: any free entry of at most 60 chars is accepted besides the options (the UI shows an **Other** chip with a text field); `other` options were dropped from those static lists. The preview's growth suggestion follows the persona's ladder (a senior AE: "sales manager"). Scout: `scout.plan` returns persona-aware title variations (Craft `titles` first, then each function's typical titles at the Craft level, then unlevelled), and the watchlist title rule and fit rank accept Craft `titles` as phrases, so a sales profile scouts and keeps "Enterprise Account Executive" and never product titles. `skills/scout` (SKILL.md, plan.md) and `skills/onboard` (SKILL.md, extract.md) say so.
- Why: the interview fit product people only (#74).
- Shim: none for callers (`other`, `options` and Craft `titles` optional; agent-sent product values still valid). Profiles without `titles` scout as before.
- Status: accepted

### Skill `voice`; op `profile.propose_voice`; `onboard.answer { skip_component }`; `VOICE_DEFAULT_STYLE`, Voice `traits` / `learned_from` (#76)
- Lane: r2/08-persona-voice (E, B, runs, D)
- Date: 2026-10-09
- Contract: enums `SKILLS` adds `voice`; registry `onboardAnswer.input.skip_component` (optional boolean), new op `profile.propose_voice { style?, traits (<= 6), samples (<= 3), sources { gmail_sent, linkedin_posts } }` -> `{ diff | null, dropped }` (owner E, low, emits `profile_diff_proposed`); profile-data `VOICE_DEFAULT_STYLE` (`neutral`), `VOICE_LEARN_SAMPLES_MAX` (3), `VOICE_LEARN_SAMPLE_MAX_CHARS` (600), `VOICE_LEARN_MAX_EMAILS` (30), `VOICE_LEARN_MAX_POSTS` (10), `VOICE_TRAITS_MAX` (6), Voice `traits`, `learned_from { gmail_sent?, linkedin_posts? }`; engine runner `SKILL_TOOLS.voice` (Gmail `search_threads`, `get_thread`, `get_message`; Chrome read + navigate tools), `LINKEDIN_SKILLS`, `usesChrome` (voice like connect: Chrome only when `config.linkedin.mode` is `live`), `PromptContext.voice`, `voiceLine`; the Ask prompt's OpButton skill list.
- Change: the Voice step is skippable: `onboard.answer { question_id, skip: true, skip_component: true }` skips every remaining question of that component; for Voice it stores `style: 'neutral'` when none is set (UI: Voice questions show **Skip** instead of "I don't know"). The outreach writer uses `Style: neutral` (plain, clear sentences) when Voice has no style, and passes learned `traits`. **Learn voice** (You > Voice, `runs.start { skill: 'voice' }`; the click is the consent) queues a headless `voice` run: it reads the user's sent Gmail only (read-only, at most 30) and, when LinkedIn is live, their own posts via Claude in Chrome (at most 10 posts and min(`max_pages_per_run`, 5) pages), then calls `profile.propose_voice`. The op refuses samples under 40 or over 600 chars or with an email address, phone number, link, @handle, a greeting or thanks to someone by name, quoted text, a mail header or an em / en dash, adds learned samples after the kept ones up to `VOICE_SAMPLES_MAX` (`dropped` counts the rest) and proposes one pending Voice diff whose first evidence line marks it learned; `profile.apply_diff` on that diff from any actor but a human is `human_only` (never auto-applied, whatever the confidence). Claude Code: no strict MCP config (the Gmail connector loads), `--tools ""`, `dontAsk`, every Gmail write, every acting Chrome tool and built-in writes denied; `--chrome` only when LinkedIn is live. `skills/voice/SKILL.md` declares the same tools (drift test).
- Why: writing style should be skippable and learnable from the user's own writing (#76).
- Shim: none (new skill, op and optional fields). Existing Voice data is unchanged; a profile without `style` now drafts in the neutral style (it had no style line before).
- Status: accepted

## Direct or bridge

### `ContactLink.path`, `ContactLink.via_tie_json`, `BridgeTie`, `CONNECT_PATHS`; op `people.set_path`; roles.get `contacts[].paths`; `Outreach.about_contact_id`, outreach filed per recipient; migration 009 (#98)
- Lane: r3/01-direct-path (H, B, D)
- Date: 2026-10-09
- Contract: enums new `CONNECT_PATHS` / `ConnectPath` (`direct`, `bridge`); entities new `BridgeTie` (`same_company`, `same_industry`, `history`, each default false), `ContactLink.path` (ConnectPath, nullable, default null) and `ContactLink.via_tie_json` (BridgeTie, nullable, default null); migration `009_connect_path` adds both columns to `contact_link` (additive, existing links null) and `outreach.about_contact_id` (refiles existing bridge drafts under their mutual, about the target; their vault file keeps its path); entities `Outreach.about_contact_id` (Id, nullable, default null); vault `vaultPath.outreach(contactId, roleId, aboutId?)` (`outreach/<recipient>-<role>-about-<target>.md` for a bridge intro); registry `outreachGet.output.about` (Contact, nullable, default null), `outreachList.output.items[]` adds `recipient_name` and `about_name`; registry new `ConnectPathOption` (`path`, `contact_id`, `name`, `tier`, `score`, `reason`, `blocked`) and `ConnectPaths` (`recommended`, `chosen`, `options`), `rolesGet.output.contacts[].paths` (ConnectPaths, nullable, default null), `PeopleFindHint.via.tie` (optional BridgeTie), new op `people.set_path { contact_id, role_id, path | null }` -> `{ link, paths }` (owner H, low); `ui.ts` `COMPONENTS` adds `PathChoice`, `DraftList`. Not contracts: engine `people/path.ts` (`rankPaths`, `connectPathsFor`, `draftTierFor`, `reachOf`, `LIKELY_EMAIL_P` 0.4, `REACH_POINTS`, `TIE_POINTS`, `STRONG_TIE` 3, `PATH_TIER`), `draftRecipient` takes `Pick<PeopleDeps, 'repos' | 'config'>`.
- Change: a 2nd-degree hiring-team contact with a mutual has two paths, ranked by code. Direct reach: the target's email confirmed (a Gmail draft would get a To, #37) or likely (a guess at p >= 0.4), else none. Bridge tie: the connect skill's judgment on `people.find` (`via.tie`), kept on the link; points same company 3, history 2, same industry 1, strong at 3 or more. Default: direct when the target is reachable unless the mutual is strong and has an email; bridge when the target is unreachable. A bridge to a mutual with no email is `blocked` while the target is reachable: never the default, `people.set_path` refuses it (`conflict`), and `outreach.draft` refuses its tier. `people.set_path` stores the user's pick (null resets to the default; refused for a contact with no choice); the pick sets which path the primary action drafts and never removes the other path's draft. Outreach is filed under the person it is addressed to (owner's comment on #98): a role holds one draft per recipient, so a direct note to the target (`contact_id` = target, `about_contact_id` null, tier `cold_hiring`) and a bridge intro to the mutual (`contact_id` = mutual, `about_contact_id` = target, tier `bridge`) exist side by side. `outreach.draft` still takes the target as `contact_id` and accepts either open path's tier for such a contact (a blocked bridge refused); other contacts keep the link tier. It files the row under the recipient and redrafts that row in place (the lookup is recipient + role + about). `outreach.get` returns the recipient as `contact`, the To, and `about`; `outreach.list` names the recipient and the target. A bridge row with no `about_contact_id` (none after 009) still resolves its recipient from the link. The link `tier` still means degree x hiring team. The engine writer (`draftContext`) uses the chosen tier and names no mutual on a direct note. One-line reasons: direct "Hiring team · Email confirmed | Email likely | No email"; bridge "<Same company | Same industry | Other company>[ · In touch] · <Email known | Email likely | No email>". UI (not a contract): People shows **Path** above the list for the best target: the recommended path first ("To <first name>" / "Via <first name>", a **Recommended** tag, the reason), and **Use** (`people.set_path`) on the other one unless it is blocked or the target's draft is in Gmail; each path shows its draft status; the primary action is "Draft for <recipient>"; a **Drafts** list under the people lists every draft per recipient ("About <target>" on a bridge intro) and opens it; the best-path pill shows the mutual only on a bridge, and the Outreach path reads You -> mutual -> target for a bridge intro. Role and People find a person's draft as the note to them, else the intro about them. `skills/connect/SKILL.md` (steps 4, 6, 7, 8) and `RUNBOOK.md` say so.
- Why: the tier logic made every 2nd-degree hiring leader a bridge, so the draft went to a weakly tied mutual with no email while the leader's email was known (#98).
- Shim: none for callers (new fields default null; `via.tie` optional; `outreach.draft` input unchanged). Existing 2nd-degree hiring links get paths from their emails with no tie. Callers that matched an outreach to its target by `contact_id` must also match `about_contact_id` for a bridge intro (Role, People and the mock do). Fixture `or_0002` is now filed under the mutual.
- Status: accepted

## Email verification and the Gmail To

### `EmailCheck`, `EmailCandidate.check`, `people.find_email` `evidence`, `people.email_checked`; `DraftRecipient.decision_id`; `Outreach.gmail_to`; the To update step; migration 010 (#99)
- Lane: r3/02-email-verify (H, B, runs, D)
- Date: 2026-10-09
- Contract: enums new `EMAIL_DOMAIN_CHECKS` / `EmailDomainCheck` (`ok`, `no_mx`, `invalid`, `unknown`), `EMAIL_RISKS` / `EmailRisk` (`disposable`, `role`, `free`, `none`), `EMAIL_EVIDENCE_KINDS` / `EmailEvidenceKind` (`inbox_peer`, `public_mention`), `EMAIL_CHECK_RESULTS` / `EmailCheckResult` (`valid`, `invalid`); registry new `EmailCheck` (`domain`, `risk`, `pattern_peers`, `public_match`), `EmailCandidate.check` (optional), `EmailEvidence` (`kind`, `address`, `source`, `url?`, `name?`), `peopleFindEmail.input.evidence` (optional, max 50), `peopleFindEmail.output.dropped` (emails, default []), new op `people.email_checked { contact_id, address, result }` (low impact, human only; output `contact`, `result`, `source: "manual_check"`, `decision_id`, `open`, `remaining`, `confirmed`), `DraftRecipient.decision_id` (Id, nullable, default null); entities `Outreach.gmail_to` (string, nullable, default null); migration `010_gmail_to` adds `outreach.gmail_to` (additive, existing rows null). Not contracts: engine `people/verify.ts` (`isValidSyntax`, `domainCheck`, `riskOf`, `checkOne`, `checkCandidates`, `PROVEN_P` 0.97, `MIN_PEERS` 2), `people/lists/aftership.ts` (vendored lists), `people/dns.ts` `createMailResolver` (injectable `resolveMx` + `resolve4`), `email.ts` `peerFits`, `UNPROVEN_MARGIN`, `NO_CANDIDATE`, `people/check.ts` (`emailChecked`), `PeopleDeps.runOp`, `draftRecipient(deps, c, { except })`, `pendingEmailDecision`, `gmailRecipient`; runner `GMAIL_UPDATE_TOOL`, `GMAIL_GET_DRAFT_TOOL`, `GMAIL_TO_DENIED_TOOLS`, `gmailToPrompt`, `buildRunnerSpec({ gmailTo })`.
- Change: **Passive check before asking; no contact with third-party mail servers.** No SMTP connection, mailbox probe or verification website, ever, and no paid provider or user key. `people.find_email` checks every guessed candidate before the `people.email` decision: syntax (an RFC 5322 subset), the domain (`dns.promises.resolveMx`, else an A record; DNS only; `EngineServices.mx`, injected in tests), list risk (disposable, role and free-provider lists vendored from AfterShip/email-verifier, MIT; a label only) and pattern evidence. The connect skill passes `evidence`: real addresses at the company domain from the user's own Gmail (read-only, from / to / cc; address only, the display name infers the format and is not stored) and public mentions of a candidate address. Code infers each peer's format (`first`, `first.last`, `flast`, `firstl`, `f.last`, `last`) and scores each candidate: `pattern_peers` = peers in its format, `public_match` = the exact address was seen (evidence, hints, JD, dossier). An exact match, or 2+ agreeing peers with no conflicting one (not disposable), raises p to 0.97, so the medium-impact decision auto-applies and To is filled; `no_mx` or `invalid` drops the candidate (`dropped`; none left: no guess, nothing asked); anything else is capped below `second_opinion` and goes to Needs you. The decision keeps `candidates[].check` and `evidence[]` as `{ kind, address, pattern, url? }` only. **The user checks by hand.** Each Needs you email card lists the candidates with short evidence labels ("Pattern: 3 peers", "Public: 1", "No MX", "Role"), a **Check** link (`<a target="_blank" rel="noopener noreferrer">` to https://email-checker.net/, no op, `data-op="local"`; it copies the address, a refused clipboard is ignored) and **Valid** / **Invalid** (`people.email_checked`, actor human). Valid records the check on the decision (`question_json.manual_checks[]`, `source: "manual_check"`) and resolves it with the address through `decisions.resolve` (its action confirms the address; the Gmail ordering below queues the draft); with no pending decision it runs `people.find_email { value }`. Invalid drops the candidate from the decision's options and candidates (`dropped`), moves the pick and a stored guess to the next one and keeps the decision open; the last one rejects the decision and clears the guess. The contact's `email_source` stays `pattern` or `manual` (the `contact.email_source` CHECK is not widened: no table rebuild). **Draft after the address.** While a recipient's address is a guess waiting in Needs you (`outreach.get` `to.decision_id`), `outreach.to_gmail` without `gmail_draft_id` answers `conflict` and creates nothing, and `runs.start { skill: 'connect', outreach_id }` answers `conflict`; a draft the agent already made is still recorded (no To). When the address turns confirmed (a Needs you pick, a Valid check, or a proven guess), the engine queues `runs.start { skill: 'connect', outreach_id }` for each of the recipient's drafts: a `drafted` one gets the Gmail draft step (To filled), an `in_gmail` one with `gmail_to` null gets the **To update step** (`summary_json.step: 'gmail_to'`), whose Claude Code run allows only `mcp__pp`, Gmail `get_draft` and `update_draft` and denies every other Gmail write (`SKILL_TOOLS.connect` unchanged). `outreach.to_gmail` stores the To it used on `gmail_to`. UI: Needs you email cards as above; Outreach shows **Email pending** (disabled) while the address waits; Settings has no email check section. `skills/connect/SKILL.md` (step 7 evidence, steps 10, Gmail draft step, Gmail To step) and `RUNBOOK.md` say so. Supersedes this branch's first cut (paid NeverBounce / ZeroBounce / Hunter adapters with a user key in an env var, `config.email_verifier`, Settings > Email check), removed before merge on the owner's review.
- Why: three guessed addresses went to Needs you, but their Gmail drafts were created right away without To, and confirming filled nothing in (#99). The owner rejected paid verification providers with user keys: verification uses passive data plus the user's own manual check.
- Shim: none for callers (new fields optional or default null; `evidence` optional). Existing in-Gmail drafts have `gmail_to` null: a later confirmation of their recipient's address fills their To. A pattern guess with no evidence that used to reach the auto threshold from hints alone still does when its peers agree (2+, no conflict); otherwise it now waits in Needs you.
- Status: accepted

## Downloads and the fill assist

### `apply.render_documents`, `apply.fill_done`, `runs.start.assist`, `Application.fill_assist_json`, `vaultPath.rendered`, `PRIMARY_ACTIONS.role` Open and fill; migration 011 (#106)
- Lane: r3/03-fill-assist (B, runs, D)
- Date: 2026-10-09
- Contract: vault new `RENDER_DOCS` (`resume`, `cover_letter`), `RENDER_FORMATS` (`pdf`, `docx`), `renderedKey(doc, format)` (`resume_pdf`, ...), `vaultPath.rendered(roleId, doc, format)` = `files/<role_id>/<doc>.<format>`; entities new `FillAssist` (`at`, `run_id`, `filled`, `uploaded`, `skipped: [{ label, reason }]`) and `Application.fill_assist_json` (nullable, default null); registry new ops `apply.render_documents { role_id, formats = [pdf, docx], docs = [resume, cover_letter] }` -> `{ application, files: [{ doc, format, path, abs_path, bytes }] }` (low) and `apply.fill_done { role_id, filled, uploaded, skipped }` -> `{ application }` (low), `SUBMIT_LIKE` / `isSubmitLike`, `runs.start` input `assist` (optional boolean, `fill` only, kept as `summary_json.assist`); ui `PRIMARY_ACTIONS.role` `Fill` renamed **Open and fill** (`runs.start`), then **Open portal** (null); migration `011_fill_assist` adds `application.fill_assist_json` (additive, existing rows null). Not contracts: engine `ops/documents.ts` (`parseMarkdown`, `renderPdf` via `pdfkit`, `renderDocx` via `docx`, `RENDER_MIME`), `downloadableFile` (the route guard), runner `FILL_ASSIST_TOOLS`, `FILL_ASSIST_LINE`, `fillLine(questions, assist)`, `skillAllowedTools(skill, { assist })`, `chromeDeniedTools(skill, { assist })`, `buildRunnerSpec({ assist })`; `pp up` `GET /api/files?path=`; web `OpClient.fileUrl`.
- Change: **Downloads.** `apply.render_documents` renders the tailored resume and cover letter markdown with one ATS-friendly template (single column, standard fonts, real headings and bullets; no tables or images) to PDF and DOCX in pure JS, writes them under `files/<role_id>/` and records them in `package_paths_json` (`resume_pdf`, `resume_docx`, `cover_letter_pdf`, `cover_letter_docx`); rendering again overwrites. `pp up` serves them read-only at `GET /api/files?path=` only when an application references that `files/` PDF or DOCX (anything else 404, writes 405). The Resume and Cover tabs show **Download** with **PDF** and **DOCX** (data-op `apply.render_documents`). **Fill assist.** `runs.start { skill: 'fill', role_id, assist: true }` (the Role primary **Open and fill**, at Fill and at Submit until an assist ran; on a fill run still queued without assist it turns assist on) gets Claude in Chrome `form_input` and `file_upload` next to the read tools; every other acting tool (`computer`, `javascript_tool`, `browser_batch`, `shortcuts_execute`, `upload_image`, `gif_creator`) stays denied, so there is no click or key press that could submit. A fill run without assist (pipeline, pasted questions) keeps #81's read-only list. The prompt's assist line: after `apply.fill`, `apply.render_documents { formats: [pdf] }`, reuse the portal tab, upload the PDFs (`abs_path`), fill the answer fields from Answers, never touch a Submit / Apply / Send control, leave the tab open, report `apply.fill_done`. `apply.fill_done` (draft-ready roles only) refuses a `filled` label that is a submit control (`isSubmitLike`, whole label: "Submit", "Apply now", "Send application"; a question that mentions applying is fine) and an `uploaded` document with no rendered PDF; it stores `fill_assist_json` and moves the application to `submit` at the latest. The Role primary is then **Open portal**. The role stays draft-ready; the human submits. `skills/fill/SKILL.md` (new Fill assist section, `## Tools`), README, AGENTS rule 4 and the `pp up` README say so.
- Why: the user wants a download of the tailored resume, and Fill to open the application, upload the resume and fill the answers, stopping before Submit (#106).
- Shim: none for callers (new fields optional or default null; the read-only fill run is unchanged). Deps added to `@perfect-placement/engine`: `pdfkit`, `docx` (pure JS, no install scripts; `onlyBuiltDependencies` unchanged).
- Status: accepted

## Chrome tabs

### `runs.finish { tabs }`, `RunTabs`, `ChromeTabId`; Chrome skills get `tabs_close_mcp` (#107)
- Lane: r3/04-chrome-tabs (B, runs, D)
- Date: 2026-10-09
- Contract: registry new `ChromeTabId` (non-negative integer) and `RunTabs` (`opened`, `closed`, `left_open`: tab ids, default []; `portal` optional), `runsFinish.input.tabs` (optional RunTabs, stored as `summary_json.tabs`; a `summary.tabs` object is read the same way). Not contracts: engine runner `CHROME_READ_TOOLS` adds `tabs_close_mcp`, new `CHROME_TAB_TOOLS` (`tabs_context_mcp`, `tabs_create_mcp`, `tabs_close_mcp`), `tabsLine(assist)` in the prompt of every run that has Chrome tools; handler `runTabsOf`, `tabsLogLine`; web `runTabs` and a **Tabs** fact on the run detail.
- Change: every Claude in Chrome run (`connect`, `fill`, `voice`) starts with `tabs_context_mcp` and reuses the tab the session created (navigates it), creating one with `tabs_create_mcp` only when none is usable, so no empty extra tab is left. At the end, done or failed, it closes only the tabs it opened or used with `tabs_close_mcp` (never the user's pre-existing tabs) and reports them on `runs.finish { tabs: { opened, closed, left_open } }`. The fill assist leaves its portal tab open (`left_open: [portal]`, `portal` set) for the human to submit and closes any others. `runs.finish` refuses (`invalid_input`) tabs from a skill with no Chrome tools, a closed or left-open id the run did not list in `opened`, an id both closed and left open, and any left-open tab except a fill assist run's single `portal` tab. The run log gets a line "Tabs: opened 12, 13; closed 13; left open 12 (portal)"; Runs > a run shows **Tabs** ("2 opened · 1 closed · 1 left open"). `tabs_close_mcp` is added to `SKILL_TOOLS` for connect, fill and voice (through `CHROME_READ_TOOLS`) and to their SKILL.md `## Tools` (drift test); no other skill gets a tab tool. `skills/connect` (step 3, new Chrome tabs section, RUNBOOK), `skills/fill` (Reading the portal, steps, Fill assist) and `skills/voice` (steps 3, 7) say so.
- Why: a Chrome session left its first tab empty and opened another one for the work, and runs never closed their tabs (#107).
- Shim: none for callers (`tabs` optional; a run that reports no tabs finishes as before).
- Status: accepted

## On deck = picked

### `companies.dossier.write.role_id`; apply stage starts emit `role_picked` (#105)
- Lane: r3/05-on-deck-picked (B, H, runs, D)
- Date: 2026-10-09
- Contract: registry `companiesDossierWrite.input.role_id` (optional Id, a role at that company); `emits` gains `role_moved`, `role_picked`, `role_promoted` on `runs.start`, `companies.dossier.write`, `people.find`, `people.fallback`, and `role_picked` on `apply.tailor`. No new event kind (`role_picked` is already a `LEARNING_EVENTS` member). Not contracts: engine status `MoveVia` `pick` and `PICKABLE_STATUSES` (`active`, `held`); handler `pickRole(h, role, stage)`, `PICK_STAGES`; web `STATUS_LABEL['on-deck']` = "In progress", `TileData.tag`.
- Change: **On deck = picked.** Starting an apply stage on an `active` or `held` role moves it to `on-deck` first (`role_moved` with `via: 'pick'`, `stage`) and emits `role_picked { from, stage }` (stage `research`, `tailor` or `connect`), whoever starts it: `runs.start` for `research`, `tailor` or `connect` with a `role_id` (a human's queued run or an agent's own), `companies.dossier.write` with `role_id`, `apply.tailor`, and `people.find` (not on `dry_run`) / `people.fallback`. Idempotent: a role already at `on-deck` or later is never moved (no downgrade), and `inbox` / `archived` roles are left as they are. Held is pickable: on-deck is outside the per-company cap, so picking a held role takes no slot and the active roles keep theirs; picking an active role frees its slot and the best held role is promoted (`role_promoted`). `apply.tailor` therefore goes active/held -> on-deck -> draft-ready (and accepts a held role). `people.find` on an active role picks it instead of answering `conflict`. Manual River drags (`MANUAL_MOVES`) are unchanged; on-deck stays protected from rescore (wave1-decisions #13). UI (not a contract): River, Role and Now label on-deck **In progress**; Now's Top picks include on-deck roles with an In progress line. `skills/research` (passes `role_id`), `skills/connect` and `skills/tailor`, the blueprint and the design handoff say so.
- Why: on-deck was only set by a manual drag and Tailor skipped it, so it meant nothing (#105; owner's decision: picked = on deck, through the apply stage).
- Shim: none for callers (`role_id` optional; events are additive).
- Status: accepted

## Open posting on role decisions

### `decisions.queue` items carry `subject_role` (`DecisionSubjectRole`, `QueuedDecision`) (#102)
- Lane: r3/07-open-posting (I, D)
- Date: 2026-10-09
- Contract: registry new `DecisionSubjectRole` (`id`, `url` nullable, `last_checked_at` nullable, `freshness_evidence` nullable) and `QueuedDecision` (`Decision` plus optional `subject_role`); `decisionsQueue.output.pending` and `recent_auto` are `QueuedDecision[]`. Not contracts: engine `withSubjectRole` in `ops/lanes/decisions.ts`; web mock `withSubjectRole`, `DecisionView.url` / `checked`, `PostingLink`, `EVIDENCE_MAX` (80).
- Change: every queued decision whose subject is an existing role carries `subject_role`: the role's url and `last_checked_at`, and `freshness_evidence` (a `freshness.closed` decision's own evidence from its question state, else the role's latest `freshness_checked` event evidence, else null). Agents reading `decisions_queue` or `pp://needs-you` get the posting url without a `roles.get` per decision. UI (not a contract): a Needs-you card about a role shows **Open posting** (a plain `<a target="_blank" rel="noopener noreferrer">`, no op) when the url exists; key `O` opens it for the focused card (ignored while typing); freshness cards show **Checked** ("2d ago · <evidence, at most 80 chars>", or "Never").
- Why: "Is this posting still open?" gave no way to open the posting and verify (#102).
- Shim: none for callers (`subject_role` optional; decisions about anything but a role, or a role that no longer exists, have none).
- Status: accepted

## Grouped auto stream

### `decisions.queue.auto_groups` (`AutoGroup`), `decisions.undo_group` (#103)
- Lane: r3/08-now-grouping (I, B, D)
- Date: 2026-10-09
- Contract: registry new `AutoGroup` (`id`, `kind`, `subject_type`, `subject_id` nullable, `run_id` nullable, `decision_ids` newest first, `count`, `backend` (a `Backend` or `mixed`), `first_ts`, `ts`, `undoable_ids`, `undone_count`, `total` nullable); `decisionsQueue.output.auto_groups: AutoGroup[]` (`recent_auto` unchanged); new op `decisions.undo_group { decision_ids: Id[1..500] }` -> `{ undone: Decision[], skipped: [{ decision_id, reason }] }` (low, `dynamicImpact`, emits `decision_undone`); new `auto-groups.ts`: `groupAutoDecisions(decisions, now, { runOf?, totalOf? })`, `AUTO_BATCH_KINDS` (`people.classify`, `freshness.closed`), `AUTO_GROUP_WINDOW_MS` (10 min), `isUndoableNow`. ui `AutoRow` props gain `count`, states `expanded`. Not contracts: resolver `DecisionOpsDeps.groupHints`, `undoOne`; engine `groupHints` (run from any event linked to the decision that carries `run_id`; a `roles.criterion` group's total = the role's first score at or after the group); the engine resolver's decision events carry `run_id` inside a skill run (`ctx.runId`); web `AutoRow` `count` / `expanded` / `onToggle` / `undoOp` / `nested`.
- Change: the auto stream is grouped server-side so MCP and agents get it too. Key: kind, plus subject (except batch kinds), plus run; with no run id, kind (+ subject) and a chained 10-minute window. Mixed kinds never share a group. `backend` is the strict-majority backend, else `mixed`. `decisions.undo_group` runs each id through the same rules as `decisions.undo` (auto + undo only, so hard exclusions never qualify; inside the window; the inverse op keeps its own no-downgrade checks) and skips the rest with a reason; nothing undoable is a `conflict`. UI (not a contract): Now renders one row per group ("Scored 82 · Kev · 9 criteria", "Checked 12 · 2 closed", "Classified 6"), a count toggle (`local`) expands the members, the group Undo calls `decisions.undo_group` once with the undoable ids and is hidden when none is; single-decision groups render as before (`decisions.undo`).
- Why: the Auto stream on Now showed one line per criterion, about nine per scored role (#103).
- Shim: none for callers (`recent_auto` and `decisions.undo` unchanged; `auto_groups` and the op are additive).
- Status: accepted

## Agent session latency

### `system.backends` agent `latencyMs` is a measured median or null; `AskThreadTurn.ms` (#100)
- Lane: r3/10-agent-latency (I, D, cli Ask)
- Date: 2026-10-09
- Contract: `systemBackends.output.items[].latencyMs` stays `number | null` (already nullable; now documented as null when unknown). `AskThreadTurn` gains optional `ms` (int, >= 0): how long the Ask turn took, launch to done. No migration (`ask_thread.turns_json` is JSON; older turns have no `ms`). Not contracts: engine `agentLatencyMs(db, n)`, `AGENT_LATENCY_SAMPLES` (20), `backendStatus(config, services, home?, db?)`, `AskThreads.time()`; web `BackendCard` shows `n/a` for null and `ms p50` on the session card.
- Change: the agent item no longer reports the agent backend's constant `health().latencyMs: 0`. Its `latencyMs` is the median of the last 20 measured agent durations: Ask turns (`turns_json[].ms`, newest threads first) and agent-answered decisions with `latency_ms > 0` (0 means not measured and is skipped), merged by recency; none: `null`. The agent never reads `slow` (a session turn is model think time, not a round trip). Rule keeps its honest in-process 0; Kev and Jev keep their measured health round trip; the API adapter reports none (null).
- Why: Settings always showed the agent session at 0 ms (#100).
- Shim: none for callers (the field was already nullable; `ms` is optional).
- Status: accepted

## Profile identity

### Story `contact` typed (`StoryContact`, `IDENTITY_FIELDS`), `profile.set_identity`, autofill `first_name` / `last_name` / `preferred_name` / `city` (#124)
- Lane: r4/02-profile-identity (E, B, D)
- Date: 2026-10-10
- Contract: profile-data new `IDENTITY_FIELDS` and `StoryContact` (loose object: `full_name`, `preferred_name`, `email`, `phone`, `city`, `linkedin`, all optional strings); Story `contact` becomes `StoryContact` (was `z.record(string, string)`; every old value still parses). `AUTOFILL_FIELDS` gains `first_name`, `last_name`, `preferred_name`, `city`. Registry new `IdentityInput` and op `profile.set_identity { contact: IdentityInput }` -> `{ version: ProfileVersion | null, contact: StoryContact }` (low, owner E, emits `profile_diff_proposed`, `profile_diff_applied`). No migration (`profile_component.data_json` is JSON). Not contracts: engine `parseContact` / `nameOf` (resume.ts), `contactOf` / `contactLine` / `IDENTITY_KEYS` (hints.ts), bank questions `story.preferred_name`, `story.phone`, `story.city`, `story.name` (`QuestionDef.contactKey`), `profileSetIdentity`, `nameParts` (fill.ts); web `IDENTITY_EDIT_FIELDS`, `identityText`, `identityInput`, You > Story **Contact** editor.
- Change: identity lives where email and LinkedIn already did (Story `contact`): Story is the asset of facts about the user, so a change never rescores and is never a hard exclusion. Onboarding: the instant preview reads the resume header deterministically (name line, email, a 10 to 15 digit phone, LinkedIn, a "City, ST" / "City, Country" segment of a contact line; never a preferred name); `onboard.extract { story.contact }` replaces it, each value checked against the resume like every extracted fact. A name read from the resume joins the Story confirm ("Looks like you are Avery Testperson (+1 (555) 010-0142, Springfield, IL), and your headline is ... Right?"); Edit clears only the identity fields and asks each, pre-filled (the preferred name from the first word). With no name line the four questions are asked; a scoped re-interview leaves the contact to You. You: Story shows a Contact editor (Name, Goes by, Email, Phone, City, LinkedIn; one Save, `profile.set_identity`): merged into the saved contact, an empty field clears, a human edit applies as v+1, any other actor goes through the resolver like every Story diff. Fill: Name = `full_name` (then the older `story.name` / `contact.name`, then the resume heading); First / Last name from the full name (credentials after a comma dropped, surname particles and Jr. / III kept with the last name, middle names in neither); Preferred name = `preferred_name`, else the first name; City = `city` before the comma; standard `location` = `city`, then Work mode.
- Why: Fill skipped Name ("No name saved"): the profile had no name field (#124).
- Shim: none for callers (fields optional; a profile without them loads and fills as before).
- Status: accepted
