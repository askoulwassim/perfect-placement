# packages/engine/db

**Owner: lane A** (`docs/v2/lanes/`). Only lane A writes here.

Migrations (numbered SQL in `migrations/`), typed repository layer over better-sqlite3, vault helpers (PP_HOME, frontmatter), `system.doctor`.

001_init.sql was written by Wave 0 and matches `packages/contracts` TABLES (tested in packages/fixtures). New migrations are 002+. 002_wave2.sql (Wave 2 Phase 1) adds `onboard_session`, archive reason `duplicate` and backend `agent`, and narrows the decision CHECK to `kind <> 'apply.submit' OR policy_outcome = 'human'`; it rebuilds `role` and `decision` with SQLite's 12-step procedure, so `applyMigrations` runs with foreign keys off and checks `foreign_key_check` before each commit. 003_fresh_start.sql (#26) drops the migration-only values (archive reason `legacy`, role source `migration`) with the same `role` rebuild, mapping any leftover rows to `passed` / `manual` first. 005_fact_check.sql (#54) adds decision kind `apply.fact_check` with the same 12-step `decision` rebuild as 002. 006_contact_email.sql (#37) adds `contact.email_source` and `contact.email_confidence` (ALTER TABLE ADD COLUMN, backfilled for existing addresses) and decision kind `people.email` (same `decision` rebuild). Schema changes that alter contracts go through CONTRACT_CHANGES.md.

## Lane A surface (Wave 1)

- `connection.ts`: `openDb(file)` (FKs on, WAL, applies pending migrations), `applyMigrations`.
- `repo.ts`: `repos(db).<table>` with `get/list/count/insert/insertIfAbsent/update`; validates with contract zod schemas, converts `*_json` + boolean columns; `score`/`event` refuse updates.
- `vault.ts`: `resolvePpHome`, `initVault`, `readConfig`, frontmatter `renderMd/parseMd/readMd/writeMd` (no-clobber), `findGitRoot`, `findClaudeMdInParents`.
- `doctor.ts`: `doctor({ home, cwd })` returns the `system.doctor` op output.
- `repo.ts` also has `select(where, params)` for read-only conditions; every write goes through `insert` / `update`. Lane A repositories are the only db access: op handlers get them from `runOp` (`h.repos`), and lane I's `DecisionStore` is implemented over them (`ops/decision-store.ts`).
