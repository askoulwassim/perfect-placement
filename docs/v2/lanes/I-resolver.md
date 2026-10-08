# Lane I: Resolver + decision models

**Branch / worktree:** `v2/lane-i`  
**Owns (writes only here):** packages/resolver/**  
**Starts after:** Wave 0 merged  
**Inputs:** contracts.md (resolver interface, policy config), decisions.md (policy, backends)

## Build

- System One HTTP adapter shared by Jev (hosted, JEV_API_KEY) and Kev (local base URL). Confirm Jev's request shape from TypeSafe docs; Kev serves POST /v1/systemone.
- Rule backend (numbers, dates), LLM backend (Anthropic), human backend (queues a decision).
- Policy engine: decide(p, impact, thresholds) -> auto | auto_second | auto_undo | human, with per-decision overrides and undo windows.
- Fallback: Jev unreachable -> Kev -> LLM.
- Decisions log + eval harness: replay v1 scores and inbox classifications through Jev, Kev and LLM; agreement and calibration report.
- Kev setup doc: running kev-4b via MLX on Apple Silicon.

## Done when

- Policy engine has table-driven tests covering every cell of the grid.
- Eval report: Jev vs Kev vs LLM vs v1 on the same calls.

## Never

- Never let a System One model write text. Never auto-apply a high-impact decision.
- Never commit personal data. Never edit `packages/contracts` directly: add a request to `CONTRACT_CHANGES.md`.
- Never submit an application or send an email.
