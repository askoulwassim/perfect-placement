# packages/engine/integrations/linkedin

**Owner: lane H** (`docs/v2/lanes/`). Only lane H writes here.

Read-only browser adapter on the user's signed-in session. Capped per day, randomized delays, picked roles only. Never message, connect or send.

## Shape

- `LinkedInDriver` = `open(url)` + `readPeopleCards()`. No click, type or evaluate: the adapter cannot act.
- `assertReadOnlyUrl` allowlist: `/search/results/people/` and `/company/<slug>/people/` only; refuses messaging, invite, connect, compose, send, follow, inmail, mynetwork paths and any non-linkedin.com origin.
- `createLinkedInAdapter({ driver, mode, minDelayS })`: reads connections search, People page, then up to 3 mutual lists; budget = remaining daily profiles (each card read = 1); max 6 pages per call; random delay `min_delay_s .. 2x` before every page.
- Output per person: name, headline, canonical profile URL, degree (`1 | 2 | cold`), via mutual. Nothing else.
- `mode: 'dry-run'` only accepts the recorded driver (`createRecordedDriver`, `SYNTHETIC_RECORDING`); `live` refuses it.

## Wave 2

Implement a live driver (Playwright on Wassim's Chrome profile, or Claude in Chrome). `readPeopleCards` must return only `RawPeopleCard` fields from search result / People page cards. Selectors are not in the repo yet: capture them during the RUNBOOK session (`skills/connect/RUNBOOK.md`) with Wassim present.
