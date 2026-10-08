# Lane H: Connect (people + outreach)

**Branch / worktree:** `v2/lane-h`  
**Owns (writes only here):** packages/engine/people/**, packages/engine/integrations/{linkedin,gmail}/**, skills/connect/**  
**Starts after:** Wave 0 merged  
**Inputs:** blueprint.md (Connect tiers), decisions.md #6, v1 writing style rules (no em dashes; hook, reframe, close)

## Build

- Contact model + contact_link (degree, tier, via, is_hiring_team).
- LinkedIn browser adapter (Playwright attached to Wassim's signed-in browser profile, or Claude in Chrome): connections, company People page, mutuals for a target. Read-only, config-capped per day, randomized delays, only for picked roles.
- Tier classifier via resolver (Choice: hiring manager / hiring team / recruiter / peer / unrelated).
- Draft templates per tier (warm hiring, warm other, bridge, cold hiring) as Hook / Proof / Ask, grounded in Story and Voice.
- Gmail adapter: create draft only. `outreach.send` stays unimplemented.

## Done when

- On one real picked role (Wassim present), produces correct tiers and four drafts in Gmail drafts.
- Adapter respects caps; dry-run mode for tests.

## Never

- Never send, connect, or message on LinkedIn. Never store more than name, headline, URL, relationship.
- Never commit personal data. Never edit `packages/contracts` directly: add a request to `CONTRACT_CHANGES.md`.
- Never submit an application or send an email.
