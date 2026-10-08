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
- Status: open
