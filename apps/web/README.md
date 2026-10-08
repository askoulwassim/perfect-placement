# @perfect-placement/web

**Owner: lane D** (except `genui/`: lane J). Screens and components per `docs/v2/design.md`, `docs/v2/design-handoff.md`, and the `UI` exports in `packages/contracts/src/ui.ts`. Tokens from `@perfect-placement/contracts/tokens.css`. Dark only.

## Run

```
pnpm --filter @perfect-placement/web dev        # http://localhost:5178 on fixtures
VITE_PP_API=/api pnpm --filter @perfect-placement/web dev   # live ops API (Wave 2)
pnpm --filter @perfect-placement/web test
```

## Layout

- `src/client/`: `OpClient` (`run(name, input)`), fixtures mock, HTTP client, React hooks (`useOp` reads, `useAct` writes). Shim reads not yet in the registry are typed in `types.ts` (`ShimOps`) and filed in `CONTRACT_CHANGES.md`.
- `src/components/`: the component library (`COMPONENTS` names), ported 1:1 from the Claude Design prototype (markup, inline styles, SVG geometry, ppBounce/ppIn). `theme.ts` maps prototype values to contract tokens; extras live in `X`. Lane J imports from `@perfect-placement/web/components`.
- `src/layout.tsx`: desktop (rail + header primary top right) vs phone frame below 720px (primary pinned above the tab bar).
- `src/screens/`: Now, Needs you, River, Role, People, Outreach draft, You, Onboarding, Ask (Cmd+K overlay), Settings.
- Every `<button>` carries `data-op` (an op name, `nav`, or `local`); tests assert it.
