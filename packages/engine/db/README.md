# packages/engine/db

**Owner: lane A** (`docs/v2/lanes/`). Only lane A writes here.

Migrations (numbered SQL in `migrations/`), typed repository layer over better-sqlite3, vault helpers (PP_HOME, frontmatter), `pp migrate` importer, `system.doctor`.

001_init.sql was written by Wave 0 and matches `packages/contracts` TABLES (tested in packages/fixtures). New migrations are 002+. Schema changes that alter contracts go through CONTRACT_CHANGES.md.
