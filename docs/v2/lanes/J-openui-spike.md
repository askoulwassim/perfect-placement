# Lane J: OpenUI spike

**Branch / worktree:** `v2/lane-j`  
**Owns (writes only here):** apps/web/genui/** only  
**Starts after:** Wave 0 merged  
**Inputs:** design.md components, Thesys OpenUI docs (MIT, React, zod props, OpenUI Lang)

## Build

- Register RoleCard, ScoreRadar, ContactCard, ProfileDiff with OpenUI.
- Stream an agent reply into the Ask panel shell and render it as those components.
- Measure: tokens vs JSON, latency, how well components compose.

## Done when

- Demo in the Ask panel on fixtures.
- One-page verdict: adopt, adapt, or drop, with reasons.

## Never

- Isolated: don't change lane D components; import them.
- Never commit personal data. Never edit `packages/contracts` directly: add a request to `CONTRACT_CHANGES.md`.
- Never submit an application or send an email.
