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
