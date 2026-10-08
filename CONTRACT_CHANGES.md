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

