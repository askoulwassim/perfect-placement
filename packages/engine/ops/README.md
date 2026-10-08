# packages/engine/ops

**Owner: lane B** (`docs/v2/lanes/`). Only lane B writes here.

`runOp(name, input, ctx)`: validate (zod), policy via resolver, write `event` rows, return `OpOutcome`. Handlers for every op owned by B; other lanes register theirs.
