# @perfect-placement/resolver

**Owner: lane I.** The decision layer. Every judgment a human would otherwise make goes through `ask()`; the human sees the pick and its p, never a blank question.

Interface: `packages/contracts/src/resolver.ts`. Policy grid + config: `packages/contracts/src/policy.ts`.

## Pieces

| File | What |
| --- | --- |
| `src/policy.ts` | `decide(answer, impact, thresholds)` over `POLICY_GRID`, bands, per-kind + per-call overrides, impact floors per kind, second-opinion agreement, undo windows. |
| `src/resolver.ts` | `createResolver({ config, backends, store, runOp? })`. Routing: rule (numbers, dates) -> Jev -> Kev -> LLM -> human queue. Second opinion for low impact middle band (Kev, then LLM). Writes one `decision` row per question, runs `action_json` for auto outcomes through `RunOp`. |
| `src/backends/systemone.ts` | One HTTP adapter for Jev (`https://api.typesafe.ai`, `jev-latest`, bearer `JEV_API_KEY`) and Kev (`http://127.0.0.1:8009`, `kev-latest`). |
| `src/backends/rule.ts` | Deterministic rules keyed by question id: `meets_comp_floor`, `posting_stale`, `posting_age_days`, plus custom. p = 1. |
| `src/backends/llm.ts` | Anthropic SDK, structured outputs, answers typed questions only. Transport is injectable. |
| `src/backends/human.ts` | Last resort: p = 0 placeholders so everything lands in the Needs-you queue. |
| `src/ops.ts` | Handlers for `decisions.queue`, `decisions.resolve`, `decisions.undo` over an injected store + `RunOp`. |
| `src/store.ts` | Decisions log over a better-sqlite3-compatible handle (`decision` rows, event appends). |
| `src/config.ts` | `backendsFromConfig(config, { env })`. Jev only when its key is set; LLM only with `ANTHROPIC_API_KEY`. |
| `src/eval/` | Eval harness (accuracy vs label, agreement, Brier, ECE, auto rate, latency), synthetic data + mocked transports, v1 loaders, CLI. |
| `docs/kev-setup.md` | Running kev-4b via MLX on Apple Silicon. |

## action_json

`{ op, input, when?, undo? }`. `"$value"` anywhere in `input` becomes the final value. `when` gates the action on the final value (e.g. archive only when `open` is false). `undo` is the inverse op used by `decisions.undo`.

## Guarantees

- High impact is always `human` (grid, impact floor for `apply.submit`, and the db CHECK).
- `decisions.resolve` on medium or high impact needs `actor: human`.
- System One backends never produce text: the adapter only sends typed questions and reads numbers.

## Eval

```sh
pnpm --filter @perfect-placement/resolver build
node packages/resolver/dist/eval/cli.js                    # synthetic, mocked -> eval-reports/synthetic/
node packages/resolver/dist/eval/cli.js --live --v1 <02_Pipeline> --rubric <rubric.md> --out <outside the repo>
```

`eval-reports/synthetic/` is committed (synthetic only). v1 output must stay outside the repo; the CLI enforces it.
