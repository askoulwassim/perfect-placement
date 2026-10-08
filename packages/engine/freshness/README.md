# packages/engine/freshness

**Owner: lane G** (`docs/v2/lanes/`). Only lane G writes here.

Daily freshness ladder for `FRESHNESS_SCOPE` (active, held, on-deck, draft-ready): ATS API -> page fetch -> resolver Noulli. Outcomes open / closed / unsure, stale flag.

| File | What |
| --- | --- |
| `run.ts` | `checkFreshness(input, ctx, deps)`: the `roles.check_freshness` handler body. `rolesCheckFreshnessHandler(deps)` in `index.ts` wraps it with contract validation. |
| `ladder.ts` | Rungs 1 + 2 (ATS API, page) -> `Evidence`. |
| `page.ts` | Page fallback: 404/410, redirect to listing, closed phrases, Ashby `posting:null`; bot walls are inconclusive. |
| `store.ts` | `FreshnessStore`: every read/write the run makes. |
| `sqlite-store.ts` | **Wave 2 shim**: direct SQL over an injected better-sqlite3 handle. Replace with an ops-backed store (lane A repos, lane B `roles.archive` + event writer). |
| `backfill.ts` | Dry-run backfill (no writes, no resolver) over a store, plus a v1 `pipeline.json` reader. |
| `cli.ts` | `node dist/freshness/cli.js dry-run (--db pp.db | --v1 pipeline.json) --out <dir outside repo>`. |
| `report.ts` | Run log (`runs/<date>_freshness.md`) and dry-run report markdown. |

Deps are injected: `store`, `fetch` (`FetchLike`), resolver `ask`, `config.freshness`. Tests use recorded ATS fixtures (`../integrations/ats/__fixtures__`), a temp db from migrations + fixture seed, and a fake resolver.
