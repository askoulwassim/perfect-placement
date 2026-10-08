# OpenUI verdict (lane J spike, 2026-10-08)

**Verdict: ADAPT.** Use `@openuidev/react-lang` + `@openuidev/lang-core` (MIT, 0.3.2, pinned exact) as the parser, prompt generator and streaming `<Renderer>` for Ask replies, with **our components only, id-only props, our own prompt rules, telemetry and devtools switched off**. Do not adopt `@openuidev/react-ui` (its chat layouts and built-in component library fight `design.md`).

## What was tested

RoleCard, ScoreRadar, ContactCard (= ContactAvatar + name) and ProfileDiff (= DiffBlock) registered with zod props, plus Reply (root), Group, Text. Five recorded replies stream token by token into an Ask panel shell and render as cards hydrated from `@perfect-placement/fixtures`. 17 checks pass (`pnpm check`). No API key was available, so latency is an estimate (600 ms first token, 60 tok/s) and token counts use o200k_base as a proxy for Claude's tokenizer.

## Numbers (5 replies, totals)

| Format | Tokens | vs JSON-UI tree |
| --- | --- | --- |
| OpenUI Lang, ids only | **376** | **-21%** |
| JSON-UI tree `{"component","props"}`, ids only | 475 | baseline |
| OpenUI Lang, inline data | 688 | -16% vs JSON inline (821) |
| Hand-rolled tuple JSON `["RoleCard","id"]`, ids only | 271 | -43% |

- **Ids beat syntax.** Sending ids instead of titles, scores and names cuts 45% of tokens, twice what the language saves. It also means the model can't misquote a score: cards look facts up, and an unknown id renders "No role", never an invented card.
- **The 52 to 67% claim does not hold for us.** Thesys's benchmark uses data-heavy UIs (tables, forms). Our replies are a few small cards, where named statements (`r1 = ...`) cost tokens. A custom tuple JSON is smaller still, so the language is not the moat. The streaming parser, the prompt generator and the forgiving renderer are.
- **Latency.** First card at about 1.35 s for OpenUI vs 1.37 s for JSON (root-first ordering emits group shells before cards). Full reply 1.85 s vs 2.18 s (-15%). Client cost is negligible: about 10 ms to stream-parse all five replies chunk by chunk, and 7.5 ms to stream and render a full reply with no network delay.
- **Fixed prompt:** 789 tokens (generated) vs 713 for a JSON-schema prompt. It's cacheable, so it's a wash.
- **Bundle:** about 72 KB minified for lang-core + react-lang (React and zod are already in the app).

## Composability

- **Good:** `.ref` unions nest cards in Groups cleanly. The prompt is generated from the same zod schemas, and `toJSONSchema()` gives a JSON Schema for free (MCP). Bad output degrades gracefully: unknown components are dropped and reported (`unknown-component`), and partial ids show "..." while streaming.
- **Fragile:** arguments are positional. Swapping `ContactCard(contactId, roleId)` silently resolves to nothing (tested). The fix is id prefixes plus a `Missing` state, plus `onError` feeding a retry loop.
- Cards needing data use a React context (`GenuiDataContext`). In Wave 2 that becomes the ops client.

## Risks found (why "adapt", not "adopt")

1. **Install telemetry.** The `@openuidev/lang-core` postinstall sends a pseudonymous PostHog ping (opt-out: `OPENUI_TELEMETRY_DISABLED=1`). The root workspace's `onlyBuiltDependencies` already blocks it, and genui sets `neverBuiltDependencies`. Runtime telemetry is opt-in only.
2. **Devtools from a CDN.** When `NODE_ENV=development` (Vite dev), react-lang auto-mounts devtools fetched from cdn.jsdelivr.net. The Wave 2 Vite config must define production or alias `@openuidev/devtools` to an empty module.
3. **Pre-1.0 churn.** The docs have already drifted: the README says `createParser(library)`, but the real signature is `createParser(library.toJSONSchema(), root)`. Pin exact versions.
4. **The generated prompt adds generic rules** ("tables for comparisons, charts for trends") and contains an em dash. It is model-facing only, but our `additionalRules` must override it.

## Adapt plan for Wave 2

Keep `askLibrary` and `askSystemPrompt()` as the single wrapper. Swap the stand-ins for lane D's components. Back `GenuiData` with ops (`roles.get`, scores, people, profile diffs). Map `onAction` to `runOp` only for ops in `PRIMARY_ACTIONS` (never submit or send). Exit path: the parsed tree is plain `{typeName, props}`, so dropping OpenUI later means swapping only the parser and prompt.
