# Lane D: Web UI

**Branch / worktree:** `v2/lane-d`  
**Owns (writes only here):** apps/web/** (except apps/web/genui/**)  
**Starts after:** Wave 0 merged  
**Inputs:** design.md (import the Claude Design prototype via /design-login), claude-design-prompt.md, packages/contracts tokens + ops, packages/fixtures

## Build

- Component library matching the prototype (see design.md component list), on the contracts tokens.
- Screens: Now, Needs you, River, Role, People, Outreach draft, You, Onboarding, Ask (Cmd+K shell), Settings; mobile layout for Now, Needs you, Role.
- Data access only through a typed client that calls ops over the local API. Start on a fixtures-backed mock client; switch to live in Wave 2.
- Keyboard flows from the prototype (Needs you: A/C/S, arrows).

## Done when

- Every screen and every click path in claude-design-prompt.md works on fixtures.
- Visual diff against the prototype reviewed by Wassim.
- No text beyond labels; no external Send/Submit buttons.

## Never

- No explanatory copy. Don't invent screens; propose them to Wassim.
- Never commit personal data. Never edit `packages/contracts` directly: add a request to `CONTRACT_CHANGES.md`.
- Never submit an application or send an email.
