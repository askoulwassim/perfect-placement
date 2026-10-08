# @perfect-placement/web

**Owner: lane D** (`genui/`: lane J, folded into this package in Wave 2). Screens and components per `docs/v2/design.md`, `docs/v2/design-handoff.md`, and the `UI` exports in `packages/contracts/src/ui.ts`. Tokens from `@perfect-placement/contracts/tokens.css`. Dark only.

## Run against `pp up` (live, the default)

The UI is a client of the ops registry: every read and every button is `POST /api/ops/:name` with the op input as the JSON body, answered with an `OpOutcome` (`ok`, `requires_human`, `error`), actor human.

```sh
export OPENUI_TELEMETRY_DISABLED=1   # OpenUI install telemetry opt-out (also in ~/.zshrc)
pnpm i && pnpm build                 # builds apps/web/dist
pp up                                # serves the API at /api and the built UI at / (127.0.0.1:4317)
```

Dev server with hot reload against a running `pp up`:

```sh
pp up                                                # terminal 1
pnpm --filter @perfect-placement/web dev             # terminal 2: http://localhost:5178, /api proxied to 127.0.0.1:4317
PP_API_PORT=4400 pnpm --filter @perfect-placement/web dev     # pp up on another port
VITE_PP_API=http://127.0.0.1:4400/api pnpm --filter @perfect-placement/web dev   # or call another base directly (CORS: localhost only)
```

- `requires_human`: the toast says "Queued for you" and every read refetches, so the Needs-you badge and queue pick up the new decision.
- `error`: a short toast (`Offline` when the API is unreachable or answers something that is not an `OpOutcome`).
- `runs.start` buttons (Research, Tailor, Connect, Fill, Scout now, Draft for ...) start a headless agent run; the UI polls `runs.get` until it finishes, then refreshes (a connect run opens the draft named by `summary_json.outreach_id`).

## Run against the mock (read-only fixtures)

```sh
pnpm --filter @perfect-placement/web dev:mock        # vite --mode mock
```

Synthetic fixtures only. Reads work; every write answers `unimplemented` (the mechanics live in the engine). Use it to look at screens, not to click through flows.

## Test

```sh
pnpm --filter @perfect-placement/web test
```

Screen and click-path tests render the app on the live HTTP client with a fake `fetch` that serves `POST /api/ops/:name` from a real engine over a temp copy of the fixture vault (`src/test/live.ts`; no sockets, no network, never the real `PP_HOME`). `genui/src/*.test.tsx` runs in the same vitest run.

## Layout

- `src/client/`: `OpClient` (`run(name, input)`), HTTP client (`http.ts`), read-only fixtures mock (`mock.ts`, `--mode mock` only), React hooks (`useOp` reads, `useAct` writes, `watchRun`).
- `src/components/`: the component library (`COMPONENTS` names), ported 1:1 from the Claude Design prototype. `theme.ts` maps prototype values to contract tokens.
- `src/layout.tsx`: desktop (rail + header primary top right) vs phone frame below 720px (primary pinned above the tab bar).
- `src/screens/`: Now, Needs you, River, Role, People, Outreach draft, You, Onboarding, Ask (Cmd+K overlay), Settings.
- `genui/`: Ask replies as generated UI (OpenUI Lang), rendered with the components above. See `genui/README.md`.
- Every `<button>` carries `data-op` (an op name, `nav`, or `local`); tests assert it, and that no button says Send or Submit.
