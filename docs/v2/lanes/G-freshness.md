# Lane G: Freshness

**Branch / worktree:** `v2/lane-g`  
**Owns (writes only here):** packages/engine/integrations/ats/**, packages/engine/freshness/**, skills/freshness/**  
**Starts after:** Wave 0 merged  
**Inputs:** blueprint.md (Freshness), contracts.md (roles.check_freshness, events)

## Build

- ATS adapters: Greenhouse, Lever, Ashby public posting APIs (detect ATS from URL; capture full JD at intake too).
- Page fallback: fetch, detect 404 / redirect to listing / closed phrases.
- Resolver question: Noulli 'still accepting applications?' with the page text as state.
- Outcomes: open (last_checked_at), closed (archive reason closed, medium impact), unsure (human), age > 45 days (flag).
- Daily run over active, held, on-deck, draft-ready; run log.

## Done when

- Adapters tested against recorded fixtures (no live calls in CI).
- Backfill dry-run report over the migrated vault lists open / closed / unsure.

## Never

- Never touch applied or later roles.
- Never commit personal data. Never edit `packages/contracts` directly: add a request to `CONTRACT_CHANGES.md`.
- Never submit an application or send an email.
