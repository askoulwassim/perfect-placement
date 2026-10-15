# packages/engine/integrations/linkedin

Read-only browser adapter on the user's signed-in session. Capped per day, randomized delays, picked roles only. Never message, connect or send.

## Shape

- `LinkedInDriver` = `open(url)` + `readPeopleCards()`. No click, type or evaluate: the adapter cannot act.
- `assertReadOnlyUrl` allowlist: `/search/results/people/` and `/company/<slug>/people/` only; refuses messaging, invite, connect, compose, send, follow, inmail, mynetwork paths and any non-linkedin.com origin.
- `createLinkedInAdapter({ driver, mode, minDelayS })`: reads connections search, People page, then up to 3 mutual lists; budget = remaining daily profiles (each card read = 1); max 6 pages per call; random delay `min_delay_s .. 2x` before every page.
- Output per person: name, headline, canonical profile URL, degree (`1 | 2 | cold`), via mutual. Nothing else.
- `mode: 'dry-run'` with the recorded driver (`createRecordedDriver`, `SYNTHETIC_RECORDING`) is the only mode: tests and fixtures. Anything else throws.

## Live reads are agent-side (#82)

There is no engine-side live driver (wave1-decisions #4: Claude in Chrome). A `connect` run launches with `--chrome` and only the Chrome read and navigate tools (`SKILL_GRANTS.connect.browser` in `packages/engine/runners/grants.ts`); the agent opens the same allowlisted pages (`connectionsSearchUrl`, `companyPeopleUrl`, the mutuals search), reads people cards and passes them to `people.find` as hints with `source: 'linkedin'` (name, headline, profile URL, degree, via mutual, hiring-team signal). `people.find` keeps only `/in/<slug>` profile URLs (`canonicalProfileUrl`), the daily budget (`max_profiles_per_day`, each person or mutual = 1), `max_mutual_expansions` and flags runs over `max_pages_per_run`. Runbook: `skills/connect/RUNBOOK.md`. Selector notes from a supervised run go here, never names or URLs.
