# packages/engine/integrations/ats

**Owner: lane G** (`docs/v2/lanes/`). Only lane G writes here.

Greenhouse, Lever, Ashby public posting API adapters; ATS detection from URL; JD capture. Recorded fixtures only in CI.

- `detectAts(url, hint?)`: Greenhouse (`boards`, `job-boards`, EU, embed, `gh_jid` with company hint), Lever (US/EU, UUID ids), Ashby (UUID ids, `ashby_jid` with hint).
- `createAtsClient(fetch).check(ref)`: `open` (with full posting), `closed` (gone from a live board), `unknown` (board missing, 429, 5xx, network). Lever and bare Greenhouse 404s confirm the board is alive before saying `closed`. Ashby lists a whole board, memoised per client (one call per board per run).
- `captureJd(url, fetch, hint?)`: full JD at intake (ATS API, else page text). For lane B's `roles.add` in Wave 2.
- `__fixtures__/`: responses recorded 2026-10-08 from public boards (Greenhouse `vercel`, Lever `leverdemo`, Ashby `linear`), shortened and scrubbed. `fake-fetch.ts` serves them in tests; unrouted URLs throw.
