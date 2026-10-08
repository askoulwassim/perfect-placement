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

## Lane J requests

### Zod prop schemas for the four generated-UI cards
- Lane: J
- Date: 2026-10-08
- Contract: packages/contracts/src/ui.ts (new export, e.g. `GENUI_PROPS`)
- Change: add zod schemas, id-only: `RoleCard: z.object({ roleId: z.string() })`, `ScoreRadar: z.object({ roleId: z.string() })`, `ContactCard: z.object({ contactId: z.string(), roleId: z.string().optional() })`, `ProfileDiff: z.object({ diffId: z.string() })`. Key order is part of the contract (OpenUI maps positional args by key order).
- Why: OpenUI generates the model prompt and parses replies from these schemas; lane D's components and the MCP tool schema should share one source instead of `COMPONENTS` prop strings.
- Shim: defined locally in `apps/web/genui/src/library.tsx`.
- Status: open

### Fold apps/web/genui into the build (not a contract; Wave 2 integration)
- Lane: J
- Date: 2026-10-08
- Contract: pnpm-workspace.yaml / apps/web/package.json / apps/web vite config
- Change: either add `@openuidev/react-lang@0.3.2`, `@openuidev/lang-core@0.3.2`, `react`, `react-dom` to apps/web and include `genui/src` in its build, or add `apps/web/genui` to `pnpm-workspace.yaml`. Keep `@openuidev/lang-core` OUT of `onlyBuiltDependencies` (its postinstall sends install telemetry). In the apps/web Vite config, alias `@openuidev/devtools` to an empty module (react-lang loads it from cdn.jsdelivr.net when NODE_ENV=development).
- Why: genui is a standalone package with its own lockfile during Wave 1 because lane D owns apps/web's package.json.
- Shim: `cd apps/web/genui && pnpm install --ignore-workspace && pnpm check` (see genui/README.md).
- Status: open
