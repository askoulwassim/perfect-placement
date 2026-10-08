# packages/engine/scoring

**Owner: lane F** (`docs/v2/lanes/F-scoring-v2.md`). Only lane F writes here.

Scoring v2 mechanics. The score skill supplies judgment (C1..C9, facts); this code does the rest.

| File | What |
| --- | --- |
| `rubric.ts` | Weights from the profile version (`criterion_weights` on the owning component, v1 weights as fallback, normalized to 100), bands, scale, `rubricSnapshot()` for `score.rubric_json`. |
| `math.ts` | Total, capped affinity, band, dealbreakers (no company bypass), verdict. |
| `cap.ts` | Per-company cap: top `company_active_cap` stay active, rest held; promotion when a slot frees. |
| `blind.ts` | Brand masking and the two resolver requests (blind C1 C2 C3 C4 C9, open C5..C8); `judgeCriteria()`. |
| `source-mix.ts` | Scout source mix: watchlist queries at most `scout.watchlist_share_max`. |
| `handler.ts` | `rolesScoreHandler` (op `roles.score`) and `rebalanceCompany` (lane B's `moveRole` and freshness closes call it after every move, archive or close). |
| `store.ts` | `ScoringStore` seam; the engine implements it over lane A repos and runOp's emitter (`ops/lanes/scoring.ts`). |
| `backtest.ts`, `backtest-cli.ts` | Read-only replay of v1 judgments through v2 mechanics. |

## Rules

- `total = clamp(round(sum(c_i * w_i) / 5) + affinity_mod, 0, 100)` (scale `v1`; `zero_based` also supported). Green >= `green_min`, yellow >= `yellow_min`.
- `affinity_mod = clamp(affinity, -affinity_cap, +affinity_cap)`; affinity from the profile version's Company component, else the company row.
- Dealbreakers gate before the band and nothing bypasses them: remote required (onsite, `remote_ok === false`, hybrid without remote), comp floor only when `terms.comp_floor_hard`, and any `facts.dealbreaker_hits` the skill judged. Unknown remote or comp is a `verify` flag, never a hit.
- A rescore moves only `inbox`, `active`, `held` (`RESCORE_MOVABLE`), and archives with reason `below_threshold` or `dealbreaker`. On-deck and later keep their status (#13; the score row still records the decision and `facts_json.status_kept`), and profile-change rescores skip them entirely. The per-company cap counts `active` (and `held`) only, never on-deck.
- `notes` (rationale per criterion, any subset) are appended to the role markdown, never the db.
- Every score row records `profile_version_id` and the rubric snapshot. Rows are append-only.

## Backtest method

Input: v1 `pipeline.json`, `scores.json` (latest record per role) and `rubric.json`, read only. The stored C1..C9 are replayed with the v1 weights through the v2 rules: capped affinity (two scenarios: dream companies at the cap, and neutral), no dream-company dealbreaker bypass (v1 `dream-exception` and v1 forced-archive reasons count as not remote), per-company cap, and the rescore-movable rule above. Output: active-set company mix before vs after (roles, companies, top-5 share, max per company, dream share), status transitions, band shifts, averages, and the list of roles that change state.

Limitation: blind scoring changes the judgment itself. A replay of stored criteria cannot show that part; measure it on the next live scoring run.

```
node packages/engine/dist/scoring/backtest-cli.js --v1 <v1 repo> --out <dir outside this repo>
```

The report names companies and roles, so the CLI refuses to write inside this repo. Never commit it.
