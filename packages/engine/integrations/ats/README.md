# packages/engine/integrations/ats

Greenhouse, Lever, Ashby public posting API adapters; ATS detection from URL; JD capture. Recorded fixtures only in CI.

- `detectAts(url, hint?)`: Greenhouse (`boards`, `job-boards`, EU, embed, `gh_jid` with company hint), Lever (US/EU, UUID ids), Ashby (UUID ids, `ashby_jid` with hint).
- `createAtsClient(fetch).check(ref)`: `open` (with full posting), `closed` (gone from a live board), `unknown` (board missing, 429, 5xx, network). Lever and bare Greenhouse 404s confirm the board is alive before saying `closed`. Ashby lists a whole board, memoised per client (one call per board per run).
- `captureJd(url, fetch, hint?)`: full JD at intake (ATS API, else page text).
- `listBoard(ref, fetch)` (`list.ts`, #28): every open posting on a Greenhouse (`/jobs?content=true`), Lever (`?mode=json`) or Ashby board in one call, JD included; `ok` / `missing` (404) / `error`. Workplace inferred from location text when the ATS has no field; Lever salary ranges kept as `comp`. `cachedListBoard` memoises per op call. Used by `scout.watchlist_scan` and the `roles.add` aggregator resolver (`packages/engine/scout/`).
- `__fixtures__/`: responses recorded 2026-10-08 (single postings) and 2026-10-09 (`*_list_*`, whole-board listings) from public boards (Greenhouse `vercel`, Lever `leverdemo`, Ashby `linear`), shortened and scrubbed. `fake-fetch.ts` serves them in tests; unrouted URLs throw.
