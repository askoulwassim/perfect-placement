# @perfect-placement/resolver

**Owner: lane I.** The decision layer. Every judgment a human would otherwise make goes through `ask()`; the human sees the pick and its p, never a blank question.

Interface: `packages/contracts/src/resolver.ts`. Policy grid + config: `packages/contracts/src/policy.ts`.

## Pieces

| File | What |
| --- | --- |
| `src/policy.ts` | `decide()` = the #24 grid lookup; `policyOutcome()` = hard exclusions (`isHardHuman`) + grid + per-kind `confident_outcome` (auto -> auto + undo); bands, per-kind + per-call overrides, impact floors per kind, second-opinion agreement, undo windows. |
| `src/resolver.ts` | `createResolver({ config, backends, store, runOp?, hardHuman? })`. Routing (#7, #9): rule (numbers, dates) -> `backends.default` (Kev) -> `backends.fallback` (agent) -> agent -> llm (only when enabled) -> human queue. Second opinion for the medium middle band: the attached agent first, then other enabled adapters, else human. `record()` logs an externally judged answer through the same policy (`forceHuman` option). Writes one `decision` row per question; runs `action_json` for auto outcomes only when given a `runOp` (the engine does not: callers apply). |
| `src/backends/systemone.ts` | One HTTP adapter for Jev (`https://api.typesafe.ai`, `jev-latest`, bearer `JEV_API_KEY`) and Kev (`http://127.0.0.1:8009`, `kev-latest`). |
| `src/backends/rule.ts` | Deterministic rules keyed by question id: `meets_comp_floor`, `posting_stale`, `posting_age_days`, plus custom. p = 1. |
| `src/backends/llm.ts` | Anthropic SDK, structured outputs, answers typed questions only. Transport is injectable. |
| `src/backends/agent.ts` | The calling agent session (#9). Never calls an API: answers only with what the agent supplied for the op call (`confidence` for a single yes/no), otherwise yields to a human. |
| `src/backends/human.ts` | Last resort: p = 0 placeholders so everything lands in the Needs-you queue. |
| `src/ops.ts` | Handlers for `decisions.queue`, `decisions.resolve`, `decisions.undo` over an injected store + `RunOp`. |
| `src/store.ts` | The `DecisionStore` interface. Lane A's repository implements it in the engine (`packages/engine/ops/decision-store.ts`); a SQLite double lives in `test-helpers.ts` for this package's tests. |
| `src/config.ts` | `backendsFromConfig(config, { env, agent? })`. Kev always; agent only when attached; Jev only when `backends.jev.enabled` and its key is set; the Anthropic adapter only when `backends.llm.enabled` and `ANTHROPIC_API_KEY` is set. |
| `src/eval/` | Eval harness (accuracy vs label, agreement, Brier, ECE, auto rate, latency), synthetic data + mocked transports, v1 loaders, CLI. |
| `docs/kev-setup.md` | Running kev-4b via MLX on Apple Silicon. |

## action_json

`{ op, input, when?, undo? }`. `"$value"` anywhere in `input` becomes the final value. `when` gates the action on the final value (e.g. archive only when `open` is false). `undo` is the inverse op used by `decisions.undo`.

## Guarantees

- Hard exclusions are always `human` whatever the grid says: submit (`apply.submit`, impact floor high, db CHECK), send (`outreach.send`), delete, Dealbreakers diffs, comp floor diffs. Other high-impact decisions follow the #24 grid (confident = auto + undo).
- `decisions.resolve` on medium or high impact needs `actor: human`.
- System One backends never produce text: the adapter only sends typed questions and reads numbers.

## Eval

```sh
pnpm --filter @perfect-placement/resolver build
node packages/resolver/dist/eval/cli.js                    # synthetic, mocked -> eval-reports/synthetic/
node packages/resolver/dist/eval/cli.js --live --v1 <02_Pipeline> --rubric <rubric.md> --out <outside the repo>
```

`eval-reports/synthetic/` is committed (synthetic only). v1 output must stay outside the repo; the CLI enforces it.
