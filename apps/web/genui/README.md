# apps/web/genui

**Owner: lane J.** Ask replies as generated UI: OpenUI Lang (`@openuidev/react-lang` + `@openuidev/lang-core`, pinned 0.3.2) parsed and streamed into lane D's cards inside the CommandBar. Part of the `apps/web` build, typecheck and vitest run (no package of its own, no lockfile). The spike verdict is in [`VERDICT.md`](./VERDICT.md).

| Path | What |
| --- | --- |
| `src/library.tsx` | OpenUI library: Reply (root), Group, Text, RoleCard, ScoreRadar, ContactCard, ProfileDiff, OpButton; `askSystemPrompt()` |
| `src/reply.tsx` | `GenuiReply`: the `<Renderer>` the Ask screen puts in the CommandBar |
| `src/compose.ts` | Local Ask: a few keyword intents compose an id-only reply from op reads |
| `src/stream.ts` | Paced stream of a reply (model-like token chunks) |
| `src/devtools-stub.ts` | Empty `@openuidev/devtools` (aliased in `apps/web/vite.config.ts`) |
| `src/genui.test.tsx` | Library, parsing, hydration through ops, OpButton, compose |

- **Ids, not data.** Props are the contract's `GENUI_PROPS` (id-only, key order = argument order). Cards fetch through ops (`roles.get`, `contacts.get`, `profile.get`) with the app's client; a wrong id renders "No role", never an invented card.
- **Cards are lane D's**: RoleCard, ScoreRadar, ContactAvatar (+ name), DiffBlock.
- **OpButton** (OpenUI reserves `Action`): one button, one op, limited to the PRIMARY_ACTIONS ops an Ask reply can act on (`runs.start`, `roles.check_freshness`, `outreach.to_gmail`, `profile.apply_diff`); never submit or send, forbidden labels render nothing. Whatever the engine routes to a human comes back as `requires_human` and lands in Needs you.

## Supply chain

- `@openuidev/lang-core` has an install-telemetry postinstall. It stays out of `onlyBuiltDependencies` (root `package.json` `pnpm.onlyBuiltDependencies` for pnpm 9, mirrored in `pnpm-workspace.yaml` for pnpm 10), so pnpm never runs it. Opt out anyway: `export OPENUI_TELEMETRY_DISABLED=1`.
- react-lang auto-mounts its Inspect devtools in development; `@openuidev/devtools` is aliased to `src/devtools-stub.ts`, so nothing loads from a CDN. Production builds drop the block.
