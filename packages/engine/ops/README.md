# packages/engine/ops

**Owner: lane B** (`docs/v2/lanes/`). Only lane B writes here.

`runOp(name, input, ctx)` is the only way anything writes `pp.db` or the vault.

| File | What |
| --- | --- |
| `runtime.ts` | `createEngine` / `runOp`: lookup, zod input, gate, one transaction, staged vault writes, output check, event ids. `OpHandler` is the plug-in shape for every lane. |
| `handlers/` | Lane B handlers: roles.add/move/archive/get/list, pipeline.summary, companies.dossier.write, apply.tailor/fill/mark_submitted, inbox.ingest, runs.start/finish/list/get, config.get/update. |
| `handlers/shared.ts` | `moveRole` (status machine + log line + events + held promotion), `promoteHeld`, application upsert. Lanes F and G should move roles through these. |
| `dedupe.ts` | url normalization, ATS job id inference, fuzzy titles. |
| `vault.ts` | PP_HOME, frontmatter render, staged writes, config.json. |
| `ports.ts` | `DecisionPort` (lane I stand-in). |
| `_shim/` | Wave 1 stand-ins for lanes A and I and requested contract ops. See `_shim/README.md`. |

## Gate (runtime)

- `humanOnly` op from a non-human actor -> queued high-impact decision, `requires_human`.
- medium op from agent/schedule without an authorizing `ctx.decisionId` (a live decision whose `action_json.op` is this op) -> queued, `requires_human`.
- `dynamicImpact` ops and handlers with `selfGated` (inbox.ingest) apply policy per item themselves.

## Plugging in another lane

```ts
import { ops } from '@perfect-placement/engine';
engine.register('roles.score', ops.defineHandler('roles.score', {
  prepare: async (input, p) => ({ /* network, resolver.ask: no writes */ }),
  run(input, h, prepared) { /* sync, inside one transaction; h.emit, h.vault, ops.moveRole(h, role, to, { via: 'score' }) */ },
}));
```

Handlers without an implementation answer `unimplemented` ("owned by lane X, not merged yet").
