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
- Status: open
