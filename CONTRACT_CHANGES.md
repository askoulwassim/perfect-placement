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
- Status: open
