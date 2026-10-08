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

_None yet._

## Lane B requests

### runs.finish op
- Lane: B
- Date: 2026-10-08
- Contract: packages/contracts/src/ops/registry.ts (OPS)
- Change: add `runs.finish` { input: { run_id: Id, status: RunStatus minus 'running', summary?: record, note?: string }, output: { run: Run }, impact: low, emits: ['run_finished'], owner: 'B' }.
- Why: `runs.start` opens a run but nothing in the registry closes it, so `run_finished` can never be emitted and every skill run stays `running` (MCP agents and the UI cannot finish one).
- Shim: defined in packages/engine/ops/_shim/extra-ops.ts; `runOp` accepts it next to OPS (not visible to lane C's generated MCP tools until accepted).
- Status: open

### role_promoted in more emits lists
- Lane: B
- Date: 2026-10-08
- Contract: registry `emits` of `apply.tailor`, `apply.mark_submitted`, `inbox.ingest` (and `roles.check_freshness`, which can free a slot too)
- Change: add 'role_promoted' to each.
- Why: moving a role out of `active` frees a company slot, and held promotion runs inside the same op. Those ops cannot emit role_promoted today.
- Shim: `promoteHeld` emits `role_moved` with payload `{ promoted: true }` when the op cannot emit role_promoted.
- Status: open

### Recording externally judged decisions (resolver)
- Lane: B (affects I)
- Date: 2026-10-08
- Contract: packages/contracts/src/resolver.ts (`Resolver`, `AskRequest`)
- Change: (a) add `action?: { op: string; input: unknown }` to AskRequest so a queued decision carries the op to run (`decision.action_json`); (b) add `record(req: { decision, impact, subject, question, answer: Answer, backend, action? }): { decisionId, outcome }` to `Resolver` for judgments made outside the resolver (a skill's email classification with its p, an agent asking for a medium-impact op).
- Why: `inbox.ingest` receives `class` + `p` per message from the skill and must apply policy and log a decision row with the action, without asking a backend again. `ask()` has no way to pass the action or a precomputed answer.
- Shim: `DecisionPort.record` (packages/engine/ops/ports.ts), implemented in ops/_shim/decisions.ts as a POLICY_GRID lookup; `auto_second` goes to a human (no second backend).
- Status: open

### Archive reason `duplicate`
- Lane: B
- Date: 2026-10-08
- Contract: enums.ts ARCHIVE_REASONS + migration CHECK
- Change: add 'duplicate'.
- Why: accepting a `roles.dedupe` decision archives the new role; today the closest reason is `passed`, which reads as a skip signal to the Learn loop.
- Shim: action uses `passed` with note `duplicate of <id>`; `role_skipped` is only emitted for passed roles leaving active/held/on-deck, so inbox duplicates do not pollute learning.
- Status: open

### roles.add output: possible duplicates
- Lane: B
- Date: 2026-10-08
- Contract: registry `roles.add` output
- Change: add `possible_duplicates: Array<{ index, role_id, existing_id, decision_id }>`.
- Why: near matches (title similarity 0.6 to 0.9) are added and queued as `roles.dedupe` decisions; the caller cannot see which without reading the queue.
- Shim: listed in the run log only.
- Status: open

### Agent confidence for medium-impact ops
- Lane: B (affects I, C)
- Date: 2026-10-08
- Contract: define.ts `OpContext`
- Change: add optional `confidence?: { p: number; backend: Backend }` so an agent can state its confidence when it calls a medium-impact op (`roles.move`, `roles.archive`, `config.update`) and the policy grid can auto + undo it.
- Why: today an automated actor calling a medium op with no decision id always lands in Needs you (queued with p 0.5), since the op has nothing to put through the grid.
- Shim: runtime queues a human decision (`forceHuman`).
- Status: open

## Lane I requests

### Typed `action_json` (DecisionAction)
- Lane: I
- Date: 2026-10-08
- Contract: packages/contracts/src/entities.ts `Decision.action_json`
- Change: add `export const DecisionAction = z.object({ op: z.string(), input: z.unknown(), when: z.union([z.string(), z.boolean(), z.number()]).optional(), undo: z.object({ op: z.string(), input: z.unknown() }).optional() })` and type `action_json` as `DecisionAction.nullable()`. Semantics: `"$value"` anywhere in `input` is replaced by the final value; `when` gates the action on the final value; `undo` is the inverse op run by `decisions.undo`.
- Why: `decisions.resolve` must know whether the chosen value means "do it" (a yes/no pick of `open = true` must not run `roles.archive`), and `decisions.undo` needs an inverse op. Without `when`, accepting fixture `dc_0001` as picked (open = true) would archive an open role.
- Shim: lane I parses these optional keys from the existing Json column (`packages/resolver/src/actions.ts`).
- Status: open

### Per-question actions on AskRequest
- Lane: I
- Date: 2026-10-08
- Contract: packages/contracts/src/resolver.ts `AskRequest`
- Change: add `actions: z.record(z.string(), DecisionAction).optional()` (keyed by question id).
- Why: every `decision` row carries `action_json`, and `ask()` writes the rows, so callers need a way to pass the action in.
- Shim: `resolver.ask(req, { actions })` takes them as an optional second argument (still assignable to `AskFn`).
- Status: open

### Fixture: `dc_0001` should gate its archive on `open = false`
- Lane: I
- Date: 2026-10-08
- Contract: packages/fixtures/src/data.ts `dc_0001`, `dc_0101`
- Change: `action_json: { op: 'roles.archive', input: {...}, when: false, undo: { op: 'roles.move', input: { role_id, to: <previous status> } } }`.
- Why: see first request. `dc_0101` (auto + undo) has no inverse op today, so `decisions.undo` can only mark it undone and emit `decision_undone`.
- Shim: tests patch the rows in a temp db.
- Status: open

### Decision repository ownership
- Lane: I
- Date: 2026-10-08
- Contract: packages/engine/db (lane A)
- Change: none to contracts. Wave 2 should either adopt `packages/resolver/src/store.ts` (`DecisionStore`) as the decision repository or have lane A's repository implement that interface.
- Why: two writers for `decision` would drift.
- Shim: the resolver takes the store by injection.
## Lane E requests

### Per-component data schemas
- Lane: E
- Date: 2026-10-08
- Contract: packages/contracts/src/entities.ts (`ProfileComponent.data_json`)
- Change: export `COMPONENT_DATA_SCHEMAS: Record<ProfileComponentKey, z.ZodType>` (loose objects) plus `CriteriaWeights`, `V1Section`; validate `data_json` per `key`. Source of truth today: `packages/engine/profile/components.ts`.
- Why: UI (You screen), MCP JSON schemas, lane F (reads Terms/Work mode/Dealbreakers/Company fields) and lane A (v1 import) all need the same shape. Today `data_json` is `Record<string, unknown>`.
- Shim: schemas live in engine/profile and are applied by lane E handlers only.
- Status: open

### Criterion weights live on components (CRITERION_OWNER)
- Lane: E
- Date: 2026-10-08
- Contract: enums.ts / entities.ts (profile)
- Change: add `CRITERION_OWNER: Record<Criterion, ProfileComponentKey>` = c1,c7 team; c2 company; c3,c9 craft; c4,c5 domain; c6 terms; c8 growth. Each owner stores `data_json.criteria_weights` (points of 100); weighted `weight` column = owned sum / 100. Terms (filter) keeps `weight` null but carries `criteria_weights.c6`.
- Why: `onboard.calibrate` outputs 9 criterion weights but a component has one `weight`; lane F needs one function `rubricWeights(components)` to build the score rubric from a profile version.
- Shim: `rubricWeights`, `weightsByComponent` exported from engine/profile; lane F can import them.
- Status: open

### onboard_session table
- Lane: E
- Date: 2026-10-08
- Contract: migration 002 (lane A) + entities.ts
- Change: `onboard_session(id TEXT PK, started_at, updated_at, step, scope_json, draft_json, sources_json, answered_json, calibration_json, version_id)`.
- Why: onboarding state spans many ops and must survive restarts; migration 001 has nowhere to put it.
- Shim: `OnboardStore` interface; file store at `$PP_HOME/onboarding.json` (JSON, not markdown), memory store in tests.
- Status: open

### onboard.start + onboard.samples ops
- Lane: E
- Date: 2026-10-08
- Contract: ops/registry.ts
- Change: `onboard.start` (low) input `{ components?: ProfileComponentKey[] }` (omit = full onboarding; given = re-interview only those, then confirm) output `OnboardState`; `onboard.samples` (low, readOnly) output `{ samples: { id, title, company, criteria: Record<Criterion, 1..5> }[] }`.
- Why: blueprint requires re-interviewing one component without redoing the rest; the calibration screen needs the 12 cards. Neither is reachable through current ops.
- Shim: `startComponentInterview()` and `calibrationSamples()` functions.
- Status: open

### onboard.confirm output: proposed_diffs
- Lane: E
- Date: 2026-10-08
- Contract: ops/registry.ts `onboard.confirm.output`
- Change: add `proposed_diffs: ProfileDiff[]` (default []).
- Why: when an agent re-runs onboarding over an existing profile, filter changes are held back as pending high-impact diffs; callers should see them.
- Shim: handler returns them; contract output parse strips the field (visible through `profile.get` pending_diffs).
- Status: open

### AskRequest.action
- Lane: E (also affects I, B, F, G, H)
- Date: 2026-10-08
- Contract: resolver.ts `AskRequest`
- Change: optional `action?: { op: OpName; input: Record<string, unknown> }` written to `decision.action_json` for each question (or per-question `action`).
- Why: `decisions.resolve` runs `action_json` when a human accepts, but no caller can set it through `ask()`.
- Shim: injected `attachAction(decisionId, action)` (test shim updates `decision.action_json` directly).
- Status: open

### profile.undo_diff (or decisions.undo dispatch)
- Lane: E
- Date: 2026-10-08
- Contract: ops/registry.ts
- Change: `profile.undo_diff` (low, emits none or a new `profile_diff_undone`) input `{ diff_id }` output `{ version: ProfileVersion }`; lane I's `decisions.undo` calls it for `profile.apply_diff` decisions. Or document that `decisions.undo` dispatches to engine/profile `undoDiff`.
- Why: weighted diffs apply as auto + 24h undo; undo must create v+1 restoring the prior data and mark the diff `undone`.
- Shim: `undoDiff(deps, diffId, ctx)`.
- Status: open

### profile.learn op
- Lane: E
- Date: 2026-10-08
- Contract: ops/registry.ts
- Change: `profile.learn` (low; emits `profile_diff_proposed`, `profile_diff_applied`) input `{ event_id: Id }` output `{ proposed: ProfileDiff[], applied: {diff_id, version_id}[], queued: {diff_id, decision_id}[] }`.
- Why: the learn loop must be triggerable by schedules, the inbox monitor and MCP through the one ops registry.
- Shim: `learnFromEvent(deps, eventId, ctx)`.
- Status: open

### ProfileDiff.event_id meaning
- Lane: E
- Date: 2026-10-08
- Contract: entities.ts `ProfileDiff.event_id` (doc only)
- Change: document as "the event that caused the diff; the proposal event when there is no cause". Applied versions copy it to `profile_version.event_id`.
- Why: fixtures point it at the proposal event; the learn loop needs the causing event for traceability.
- Shim: implemented as described.
## Lane F requests

### Pin the score formula (scale) in the rubric snapshot
- Lane: F
- Date: 2026-10-08
- Contract: `entities.ts` Score.rubric_json; fixtures `RUBRIC`
- Change: add a typed `RubricSnapshot` (zod) with `scale: 'v1' | 'zero_based'`, `weights` (c1..c9 lower case, sum 100), `bands`, `affinity_cap`, `company_active_cap`, `profile_version_id`, `weights_source`. Default scale `v1` (`round(sum(c_i*w_i)/5)`, range 20..100), which is what v1 scorer.py used and what green 75 / yellow 55 were calibrated on. Regenerate fixture scores with `v1` (they use `zero_based` today, which puts all-4s at 75 instead of 80).
- Why: totals from the two formulas are not comparable; the per-company cap ranks roles by latest total, so a mixed db ranks wrong. Lane A imports v1 totals in the v1 scale.
- Shim: `packages/engine/scoring/rubric.ts` supports both and writes `scale` into `rubric_json`; handler tests pass `scale: 'zero_based'` to match the fixtures.
- Status: open

### Where calibrated criterion weights live in a profile version
- Lane: F (needs E)
- Date: 2026-10-08
- Contract: profile component `data_json` shapes (lane E schemas)
- Change: `data_json.criterion_weights: Partial<Record<Criterion, number>>` on the owning weighted component: team (c1, c7), craft (c2, c3, c9), domain (c4, c5), terms (c6), growth (c8). Missing criteria fall back to the v1 weights; result normalized to 100. Also type the filter keys scoring reads: `work_mode.modes`, `terms.comp_floor`, `terms.comp_floor_hard` (bool; comp is a C6 penalty unless true), `company.affinity` (slug -> int), `company.watchlist` (slugs).
- Why: `profile_component.weight` is one number per component, not per criterion; blueprint says weights come from the profile version and calibration derives criterion weights.
- Shim: `CRITERION_OWNER` + `profileCriterionWeights()` in `scoring/rubric.ts`.
- Status: open

### roles.score: optional profile version in, cap moves out
- Lane: F
- Date: 2026-10-08
- Contract: `ops/registry.ts` rolesScore
- Change: input `profile_version_id?: Id` (Learn loop rescoring under a new version; default latest). Output `cap: Array<{ role_id, from: 'active'|'held', to: 'active'|'held' }>` (other roles the per-company cap moved, so UI and agents can show the bump).
- Why: today the version can only be injected by the caller's deps, and bumped roles are visible only as events.
- Shim: `ScoringDeps.profileVersionId`; handler returns `{ output, eventIds, cap }`.
- Status: open

### Statuses a rescore may move
- Lane: F
- Date: 2026-10-08
- Contract: `enums.ts`
- Change: export `RESCORE_MOVABLE = ['inbox','active','held']` and `RESCORE_REVIVABLE_ARCHIVE = ['below_threshold','dealbreaker']`. `on-deck` is not in `PROTECTED_STATUSES`, but a rescore moving a human pick back to active/archived is a downgrade, so scoring keeps on-deck too.
- Why: lanes B (roles.move), E (learn rescore) and F must agree on what an automated rescore may touch.
- Shim: `isMovable()` in `scoring/handler.ts`.
## Lane G requests

### AskRequest carries the action a human accept runs
- Lane: G
- Date: 2026-10-08
- Contract: `packages/contracts/src/resolver.ts` `AskRequest`
- Change: add `action: z.object({ op: z.string(), input: z.record(z.string(), z.unknown()) }).optional()`; the resolver copies it into `decision.action_json` when it writes the decision row.
- Why: `decision.action_json` ("the op to run when this decision is applied") is written by the resolver, but `AskRequest` has no way to pass it. Freshness needs `{ op: 'roles.archive', input: { role_id, reason: 'closed' } }` on every `freshness.closed` decision so Needs-you accept works; inbox and others will need the same.
- Shim: `FreshnessStore.attachDecisionAction(decisionId, action)` (`sqlite-store.ts`) sets `action_json` right after `ask()` returns, only when it is still null.
- Status: open

### roles.check_freshness output lists skipped ids
- Lane: G
- Date: 2026-10-08
- Contract: `packages/contracts/src/ops/registry.ts` `rolesCheckFreshness.output`
- Change: add `skipped: z.array(Id).default([])`: requested `role_ids` that were not checked because they are outside `FRESHNESS_SCOPE` (applied or later, archived, inbox) or unknown.
- Why: a caller passing an applied role id today gets silently fewer results; the UI and agents should see "skipped, out of scope" rather than infer it.
- Shim: `checkFreshness()` returns `skipped` next to `output`; the handler drops it to match the frozen schema.
## Lane H requests

### people.find: skill hints + LinkedIn company slug
- Lane: H
- Date: 2026-10-08
- Contract: packages/contracts/src/ops/registry.ts `peopleFind.input`
- Change: add `hints: z.array(z.object({ name, headline?: string|null, linkedin_url?: url|null, email?: email|null, source: 'jd'|'company_site'|'manual' })).max(20).optional()` and `linkedin_company_slug: z.string().regex(/^[a-z0-9-]+$/).optional()`.
- Why: the blueprint lists the JD and company team page as people sources, but no op can create a contact other than people.find, and people.link needs an existing contact_id. The LinkedIn vanity slug often differs from the PP company slug.
- Shim: `PeopleFindInput` in packages/engine/people/find.ts extends the contract input with both fields.
- Status: open

### people.classify: say whether the tier was applied
- Lane: H
- Date: 2026-10-08
- Contract: `peopleClassify.output`
- Change: add `outcome: PolicyOutcome` (or `applied: boolean`).
- Why: when the resolver routes to `human`, the link keeps its provisional tier and the decision waits in Needs you; callers (skill, UI) cannot tell this from the output today.
- Shim: callers read `decision.policy_outcome` by `decision_id`.
- Status: open

### people.classify decision action
- Lane: H
- Date: 2026-10-08
- Contract: decision `action_json` convention (lane I) for kind `people.classify`
- Change: when a human resolves a people.classify decision, apply it via `people.link { contact_id, role_id, degree, tier, is_hiring_team, via_contact_id, company_id }` built from the chosen role. Lane I's resolver should set `action_json` accordingly, or decisions.resolve should call a lane H helper.
- Why: otherwise the human pick never reaches contact_link.
- Shim: none; tests assert the decision stays pending with the provisional tier.
- Status: open

### config.linkedin: mode, driver, per-run caps
- Lane: H
- Date: 2026-10-08
- Contract: `PolicyConfig.linkedin` / `DEFAULT_CONFIG.linkedin`
- Change: add `mode: 'off'|'dry-run'|'live'` (default `'off'`), `driver: 'playwright'|'claude-in-chrome'` , `max_pages_per_run: 6`, `max_mutual_expansions: 3`.
- Why: live LinkedIn reads must be opt-in per install; per-run caps are hard-coded defaults in the adapter today.
- Shim: adapter options + defaults in packages/engine/integrations/linkedin/index.ts; deps decide whether a LinkedIn source is injected.
## Lane C requests

### `companies.get` read op
- Lane: C
- Date: 2026-10-08
- Contract: packages/contracts/src/ops/registry.ts (`OPS`)
- Change: add `companies.get` { input: `{ company_id: Id }`, output: `{ company: Company, roles: RoleSummary[], dossier_md: string | null }`, impact low, readOnly, emits [], owner B }.
- Why: the MCP "company" resource (lane C brief) has no op to read one company. A company with no roles, or its dossier, cannot be served.
- Shim: `pp://companies/{company_id}` calls `roles.list({ company_id, limit: 500 })` and returns the first item's company plus the roles; not found when the company has no roles.
- Status: open
