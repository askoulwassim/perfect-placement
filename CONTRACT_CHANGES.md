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
