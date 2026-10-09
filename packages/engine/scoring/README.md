# packages/engine/scoring

**Owner: lane F** (`docs/v2/lanes/F-scoring-v2.md`). Only lane F writes here.

Scoring v2 mechanics. The score skill supplies judgment (C1..C9, facts); this code does the rest.

| File | What |
| --- | --- |
| `rubric.ts` | Weights from the profile version (`criterion_weights` on the owning component, v1 weights as fallback, normalized to 100), bands, scale, `rubricSnapshot()` for `score.rubric_json`. |
| `math.ts` | Total, capped affinity, band, dealbreakers (no company bypass), verdict. |
| `cap.ts` | Per-company cap: top `company_active_cap` stay active, rest held; promotion when a slot frees. |
| `blind.ts` | Brand masking and the two resolver requests (blind C1 C2 C3 C4 C9, open C5..C8); `judgeCriteria()`. |
| `judge.ts` | #40: `judgeThroughResolver` (no criteria: the resolver judges, Kev first, blind where required) and `recordAgentCriteria` (agent criteria as `agent` decisions + Kev second opinion, gaps over one point flagged); the op wiring is in `ops/lanes/scoring.ts`. |
| `source-mix.ts` | Scout source mix: watchlist queries at most `scout.watchlist_share_max`; `achievedMix` / `mixLine` report a run's adds by source vs the target (`runs.finish`, #67). |
| `handler.ts` | `rolesScoreHandler` (op `roles.score`) and `rebalanceCompany` (lane B's `moveRole` and freshness closes call it after every move, archive or close). |
| `store.ts` | `ScoringStore` seam; the engine implements it over lane A repos and runOp's emitter (`ops/lanes/scoring.ts`). |

## Rules

- `total = clamp(round(sum(c_i * w_i) / 5) + affinity_mod, 0, 100)` (scale `v1`; `zero_based` also supported). Green >= `green_min`, yellow >= `yellow_min`.
- `affinity_mod = clamp(affinity, -affinity_cap, +affinity_cap)`; affinity from the profile version's Company component, else the company row.
- Dealbreakers gate before the band and nothing bypasses them: the work-mode filter (`evaluateWorkMode`, #83), comp floor only when `terms.comp_floor_hard`, and any `facts.dealbreaker_hits` the skill judged. Unknown work mode, place or comp is a `verify` flag (`work_mode`, `location`, `comp`), never a hit.
- Work mode honors the profile (#83). Remote, flexible or `remote_ok` passes. Hybrid or onsite: a mode hard no (Work mode `hard_nos`, or a Dealbreakers hard no naming only the mode, e.g. "onsite only") is `work_mode_hard_no`; explicit `remote_only: true` is `remote_required` (`modes: ['remote']` alone never is); a `by_location` entry for the place decides (`work_mode_location` when the mode is not listed); a place in `locations` passes (NYC / New York City / Manhattan / Brooklyn match New York; country-wide and remote entries name no place); elsewhere is a `location` flag, or `work_mode_location` with `outside_locations: 'fail'`. The place is `facts.location`, else the role row's.
- `roles.reevaluate_filters { dry_run?, role_ids? }` re-checks `dealbreaker` archives whose latest hits were all work-mode hits (`WORK_MODE_HITS`) against the current profile; each one that now passes and is green gets a `roles.move` decision (question id `restore`, medium, always the human) whose action is a `roles.score` rescore with the stored criteria. Never restores on its own.
- A rescore moves only `inbox`, `active`, `held` (`RESCORE_MOVABLE`), and archives with reason `below_threshold` or `dealbreaker`. On-deck and later keep their status (#13; the score row still records the decision and `facts_json.status_kept`), and profile-change rescores skip them entirely. The per-company cap counts `active` (and `held`) only, never on-deck.
- `notes` (rationale per criterion, any subset) are appended to the role markdown, never the db.
- Every score row records `profile_version_id` and the rubric snapshot. Rows are append-only.
