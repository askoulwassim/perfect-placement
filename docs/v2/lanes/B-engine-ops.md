# Lane B: Engine ops + status machine

**Branch / worktree:** `v2/lane-b`  
**Owns (writes only here):** packages/engine/ops/**, packages/engine/status/**, packages/cli/** (except migrate/doctor), skills/{scout,research,tailor,fill,inbox}/**  
**Starts after:** Wave 0 merged  
**Inputs:** contracts.md (ops table, events, statuses), v1 skills in 05_Skills/ (scout.py, scorer.py, monitor.py, SKILL.md files)

## Build

- `runOp(name, input, ctx)`: validate with zod, call resolver policy when the op carries a decision, write `event` rows, return typed output.
- Status machine with the no-downgrade guard (automated actors never move a role backwards from draft-ready or later) and `held` promotion when a company slot frees.
- Implement every op in the table except those owned by E, F, G, H (profile.*, onboard.*, scoring math, freshness, people.*, outreach.*). Use their stubs until they land.
- Port v1 mechanics: dedupe (url, ats job id, company+title fuzzy), inbox classification moves (confirmation->applied, interview->interviews, offer->offers, rejection->archived), run logs.
- Rewrite the v1 skills as agent-agnostic SKILL.md files that supply judgment and call ops only.
- `pp` CLI: up (starts API + MCP HTTP + web), scout, score, fresh, inbox, doctor passthrough.

## Done when

- Every op has a unit test on fixtures.
- A full fixture role can go inbox -> active -> draft-ready -> applied -> interviews via ops only.
- No file in the repo edits the db or vault outside ops.

## Never

- No scoring math here (lane F). No direct Gmail send.
- Never commit personal data. Never edit `packages/contracts` directly: add a request to `CONTRACT_CHANGES.md`.
- Never submit an application or send an email.
