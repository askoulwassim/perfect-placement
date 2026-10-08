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
- Status: open
