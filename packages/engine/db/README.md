# packages/engine/db

**Owner: lane A** (`docs/v2/lanes/`). Only lane A writes here.

Migrations (numbered SQL in `migrations/`), typed repository layer over better-sqlite3, vault helpers (PP_HOME, frontmatter), `pp migrate` importer, `system.doctor`.

001_init.sql was written by Wave 0 and matches `packages/contracts` TABLES (tested in packages/fixtures). New migrations are 002+. 002_wave2.sql (Wave 2 Phase 1) adds `onboard_session`, archive reason `duplicate` and backend `agent`, and narrows the decision CHECK to `kind <> 'apply.submit' OR policy_outcome = 'human'`; it rebuilds `role` and `decision` with SQLite's 12-step procedure, so `applyMigrations` runs with foreign keys off and checks `foreign_key_check` before each commit. Schema changes that alter contracts go through CONTRACT_CHANGES.md.

## Lane A surface (Wave 1)

- `connection.ts`: `openDb(file)` (FKs on, WAL, applies pending migrations), `applyMigrations`.
- `repo.ts`: `repos(db).<table>` with `get/list/count/insert/insertIfAbsent/update`; validates with contract zod schemas, converts `*_json` + boolean columns; `score`/`event` refuse updates.
- `vault.ts`: `resolvePpHome`, `initVault`, `readConfig`, frontmatter `renderMd/parseMd/readMd/writeMd` (no-clobber), `findGitRoot`, `findClaudeMdInParents`.
- `doctor.ts`: `doctor({ home, cwd })` returns the `system.doctor` op output.
- `v1/`: `migrateV1({ from, home, dryRun })` = `planV1Import` (read-only, deterministic ids) + `applyPlan` (insert-if-absent, write-if-absent). The profile comes from lane E's `convertV1Profile` (structured components, verbatim v1 sections, criterion weights). Dream companies get affinity `DREAM_AFFINITY` (+3, #10). A green score v1 archived without confirmed remote stays `archived / dealbreaker` and is tagged `flags_json.verify_remote = true` (#20). Never run against real data from automation (stop line).
- `repo.ts` also has `select(where, params)` for read-only conditions; every write goes through `insert` / `update`. Lane A repositories are the only db access: op handlers get them from `runOp` (`h.repos`), and lane I's `DecisionStore` is implemented over them (`ops/decision-store.ts`).
- `testing/synthetic-v1.ts`: writes a synthetic v1 repo for tests (test-only, excluded from the build).
