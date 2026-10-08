# Lane A: Data layer + migration

**Branch / worktree:** `v2/lane-a`  
**Owns (writes only here):** packages/engine/db/**, packages/cli/src/commands/migrate.ts, packages/cli/src/commands/doctor.ts  
**Starts after:** Wave 0 merged  
**Inputs:** contracts.md (schema sketch, data home layout), v1-inventory.md, packages/contracts, packages/fixtures

## Build

- Migrations (001 from Wave 0, then yours) and a typed repository layer over better-sqlite3 (no ORM required).
- Vault helpers: resolve PP_HOME, create the tree, read/write markdown with frontmatter `id`.
- `pp migrate --from <v1 repo path>`: import pipeline.json, scores.json (all history), role markdown, runs, 03_Applications (dossiers + packages + docx), 01_Profile + rubric.json into the vault and db. Archive reasons inferred where possible, else `legacy`. Profile files land as v1 profile components using lane E's component keys (stub with raw text if E is not merged yet).
- Idempotent: rerunning migrate changes nothing.
- `pp doctor` (`system.doctor`): db integrity, every md_path exists, no orphan vault files, counts by status, no CLAUDE.md in the cwd parent chain, PP_HOME not inside a git repo.

## Done when

- Against a copy of the v1 repo: 158 roles, counts active 68 / applied 3 / on-deck 3 / archived 84, every score record preserved.
- Fixtures load; doctor green on fixtures and on the migrated vault.
- Tests use temp dirs only; nothing writes to the real ~/.perfect-placement in CI.

## Never

- Never commit v1 personal data. Run real migration only on Wassim's machine.
- Never commit personal data. Never edit `packages/contracts` directly: add a request to `CONTRACT_CHANGES.md`.
- Never submit an application or send an email.
