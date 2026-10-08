# apps/web/genui

**Owner: lane J** (OpenUI spike). Registers RoleCard, ScoreRadar, ContactCard and ProfileDiff with Thesys OpenUI (`@openuidev/react-lang`) and renders streamed Ask replies as those cards on fixtures. The verdict is in [`VERDICT.md`](./VERDICT.md). Lane D's components are imported in Wave 2; the files in `src/standins/` are temporary.

## Standalone package

`pnpm-workspace.yaml` covers `apps/*` only, so this folder is **not** a workspace package (Wave 2 decides how to fold it in; see `CONTRACT_CHANGES.md`, Lane J requests). The root `pnpm build && pnpm test && pnpm lint` stays green without it: checks are named `*.check.ts(x)`, so `apps/web`'s vitest never picks them up, and biome lints these sources from the root.

```sh
# from the repo root, once: build contracts + fixtures (genui links their dist)
pnpm i && pnpm build
cd apps/web/genui
pnpm install --ignore-workspace   # own lockfile; lang-core postinstall telemetry is blocked (neverBuiltDependencies)
pnpm check                        # tsc + 17 vitest checks (happy-dom)
pnpm measure                      # token / latency table used in VERDICT.md
pnpm demo                         # Ask panel at a realistic pace (600 ms TTFT, 60 tok/s) on fixtures
```

## Layout

| Path | What |
| --- | --- |
| `src/library.tsx` | OpenUI library: Reply (root), Group, Text, RoleCard, ScoreRadar, ContactCard, ProfileDiff; `askSystemPrompt()` |
| `src/data.ts` | `GenuiData`: id lookups the cards hydrate from (fixtures now, ops client in Wave 2) |
| `src/AskPanel.tsx` | Ask panel shell + `AskReply` (the `<Renderer>` slot for lane D's CommandBar) |
| `src/standins/` | **Stand-ins** for lane D's RoleCard, ScoreRadar, ContactAvatar, DiffBlock. Delete in Wave 2. |
| `src/replies.ts`, `src/ask.ts`, `src/stream.ts` | Recorded replies, scripted Ask backend, token-paced stream (no API key) |
| `src/measure.ts`, `src/tokens.ts` | Tokens (OpenUI vs JSON, ids vs inline), first-card latency, parse cost |
| `src/checks/` | vitest checks |
| `demo/` | Vite demo page |

Ids, not data: the model emits `RoleCard("linear_product-lead-insights")` and the card looks the facts up. A wrong id renders "No role", never an invented card.
