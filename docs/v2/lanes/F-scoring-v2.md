# Lane F: Scoring v2

**Branch / worktree:** `v2/lane-f`  
**Owns (writes only here):** packages/engine/scoring/**, skills/score/**, skills/scout/plan.md  
**Starts after:** Wave 0 merged  
**Inputs:** blueprint.md (Scoring v2), v1 00_System/rubric.md + rubric.json, v1 05_Skills/role-scorer/scorer.py, decisions.md #5

## Build

- Scoring math: weights from the profile version, total, band, decision; affinity modifier capped at config.scoring.affinity_cap; no dealbreaker bypass.
- Blind scoring: the state sent to the resolver for C1, C2, C3, C4, C9 has the company name and brand terms masked.
- Per-company cap -> held, with automatic promotion.
- Scout source-mix rule (watchlist share max) in the scout plan.
- Backtest on v1 scores.json (158 records): company distribution and band shifts before vs after; written report.

## Done when

- Backtest report shows the company mix change and lists roles that would change state.
- Scores record profile version and rubric snapshot.

## Never

- Don't rescore real data without Wassim's go; the backtest is read-only.
- Never commit personal data. Never edit `packages/contracts` directly: add a request to `CONTRACT_CHANGES.md`.
- Never submit an application or send an email.
