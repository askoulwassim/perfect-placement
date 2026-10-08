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
- Status: open
