# packages/engine/freshness

Daily freshness ladder for `FRESHNESS_SCOPE` (inbox, active, held, on-deck, draft-ready): ATS API -> page fetch -> resolver Noulli. Outcomes open / closed / unsure, stale flag.

Unverified postings (#77): each unsure check bumps `flags_json.unverified_checks` (an open check clears it). The `UNVERIFIED_CLOSE_AFTER` (2nd) one in a row records a rule `freshness.closed` decision (`resolver.record`, backend `rule`) that replaces the role's pending closes: p by what the check saw (`UNVERIFIED_P`: contradicted closed evidence 0.97, no ATS match or no URL 0.95, bot wall 0.93, a page that loads with nothing decisive 0.75), with a per-call `confident_outcome: 'auto_undo'`, so a confident close is auto + undo and the rest wait in Needs you. `precheck: true` (the pipeline before scoring, `runs.finish`) closes hard closed evidence on a rule decision (p 0.97) without asking a backend.

| File | What |
| --- | --- |
| `run.ts` | `checkFreshness(input, ctx, deps)`: the `roles.check_freshness` handler body. `rolesCheckFreshnessHandler(deps)` in `index.ts` wraps it with contract validation. |
| `ladder.ts` | Rungs 1 + 2 (ATS API, page) -> `Evidence`. |
| `page.ts` | Page fallback: 404/410, redirect to listing, closed phrases, Ashby `posting:null`; bot walls are inconclusive. |
| `store.ts` | `FreshnessStore`: every read/write the run makes. |
| `backfill.ts` | Dry-run backfill (no writes, no resolver) over a read-only store: `rolesFromDb` (lane A repos). |
| `cli.ts` | `node dist/freshness/cli.js dry-run --db pp.db --out <dir outside repo>`. |
| `report.ts` | Run log (`runs/<date>_freshness.md`) and dry-run report markdown. |

The engine registers `roles.check_freshness` in `ops/lanes/freshness.ts`: the `FreshnessStore` is lane A repos + runOp's emitter, closing goes through the status machine and re-applies the company cap, the resolver is the op's (rule -> Kev -> agent -> human), and each decision carries `action_json = { op: 'roles.archive', input, when: false, undo: { op: 'roles.move', input: { role_id, to: <prior status> } } }`. A confident close follows the plain #24 grid (medium + confident = auto, #18); Settings can set `overrides['freshness.closed'].confident_outcome = 'auto_undo'`. The run holds the write lock while it fetches (a daily job). Tests use recorded ATS fixtures (`../integrations/ats/__fixtures__`), a temp fixture vault and a scripted fake Kev.
