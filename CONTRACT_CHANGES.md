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

## Lane D requests

All shims below live in `apps/web/src/client/types.ts` (`ShimOps`) and are served by the fixtures mock (`apps/web/src/client/mock.ts`). They are read-only; every write in the UI already goes through a registry op.

### outreach.get (read op)
- Lane: D
- Date: 2026-10-08
- Contract: packages/contracts/src/ops/registry.ts
- Change: add `outreach.get` { outreach_id } -> { outreach: Outreach, contact: Contact, subject: string | null, hook: string, proof: string, ask: string }; low, readOnly, owner H.
- Why: the Outreach draft screen shows Hook / Proof / Ask, and the Needs-you "Ready for Gmail?" card shows them as evidence. No op returns draft text; markdown must not be parsed by the UI.
- Shim: `ShimOps['outreach.get']`.
- Status: open

### outreach.list (read op) or outreach in roles.get
- Lane: D
- Date: 2026-10-08
- Contract: registry.ts (`roles.get` output or a new op)
- Change: either add `outreach: Outreach[]` to `roles.get` output, or add `outreach.list` { role_id } -> { items: Outreach[] }.
- Why: People list and Role panel need each person's DraftStatusChip (none / drafted / in Gmail / replied).
- Shim: `ShimOps['outreach.list']`.
- Status: open

### contacts.get (read op)
- Lane: D
- Date: 2026-10-08
- Contract: registry.ts
- Change: add `contacts.get` { contact_id } -> { contact: Contact, links: ContactLink[] }; low, readOnly, owner H.
- Why: Needs-you cards for `people.classify` decisions have `subject_type = contact` and need a name and tier.
- Shim: `ShimOps['contacts.get']`.
- Status: open

### vault.read (read op) for package previews
- Lane: D
- Date: 2026-10-08
- Contract: registry.ts
- Change: add `vault.read` { path: VaultPath } -> { markdown: string | null } (frontmatter stripped; path must be one the db references), or `applications.package` { role_id } -> { dossier?, resume?, cover_letter?, fit_map?, answers? } as markdown strings.
- Why: Role screen package tabs (Dossier, Resume, Cover, Fit map, Answers) preview documents. No op returns their content.
- Shim: `ShimOps['vault.read']`.
- Status: open

### onboard.samples and onboard.state (read ops)
- Lane: D
- Date: 2026-10-08
- Contract: registry.ts
- Change: add `onboard.samples` {} -> { items: { id, company, title, criteria: Record<Criterion, 1..5> }[] } (the 12 calibration roles) and `onboard.state` {} -> OnboardState (resume mid-flow).
- Why: Calibrate shows 12 sample roles and `onboard.calibrate` needs their `sample_id`; Onboarding cannot resume without a state read.
- Shim: `ShimOps['onboard.samples']`; state kept in the screen.
- Status: open

### system.backends (read op)
- Lane: D
- Date: 2026-10-08
- Contract: registry.ts
- Change: add `system.backends` {} -> { items: { name: 'jev'|'kev'|'llm', mode: 'hosted'|'local', status: 'ok'|'slow'|'down', latencyMs: number|null }[] }, owner I (or fold into `system.doctor` checks).
- Why: Settings BackendCards show status dots and latency.
- Shim: `ShimOps['system.backends']`.
- Status: open

### runs.start: optional contact_id, connect run summary
- Lane: D
- Date: 2026-10-08
- Contract: registry.ts `runsStart`
- Change: add `contact_id: Id.optional()` to `runs.start` input; document that a `connect` run's `summary_json.outreach_id` names the draft it wrote.
- Why: People primary is "Draft for <best path>" and opens the resulting draft; without contact_id the run cannot target a person the user picked, and the UI needs the outreach id to navigate.
- Shim: mock drafts for the best-path person and returns `summary_json.outreach_id`.
- Status: open

### Schedules on/off
- Lane: D
- Date: 2026-10-08
- Contract: policy.ts `PolicyConfig.schedules`
- Change: allow the literal `'off'` (or add `{ spec, enabled }` per schedule).
- Why: Settings has an on/off toggle per schedule; today the schema only holds a spec string.
- Shim: UI writes `'off'` via `config.update` (passes `z.string()`).
- Status: open

### PRIMARY_ACTIONS wording
- Lane: D
- Date: 2026-10-08
- Contract: ui.ts `PRIMARY_ACTIONS`
- Change: people label `Draft for <name>` (op runs.start); onboarding `Next` is `onboard.answer` only on the Interview step and navigation (null) on Resume and Calibrate (those steps call `onboard.ingest_resume` and `onboard.calibrate` from the drop zone and Y/N/M).
- Why: matches the handoff screen table and the click paths.
- Shim: none needed.
- Status: open

### Local API route shape
- Lane: D
- Date: 2026-10-08
- Contract: contracts.md (local API)
- Change: `POST /api/ops/:name` with the op input as JSON body, response = `OpOutcome` JSON, actor = human.
- Why: `apps/web/src/client/http.ts` targets this; lane B/C should serve it in `pp up`.
- Shim: `VITE_PP_API=/api` switches the UI to it.
- Status: open
