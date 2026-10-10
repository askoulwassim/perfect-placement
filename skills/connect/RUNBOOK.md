# Connect: first live LinkedIn run (owner present)

Lane H "done when": on one real picked role, correct tiers and four drafts in Gmail drafts. Until #82 every `people.find` recorded `linkedin_mode: "dry-run"` and read no LinkedIn. LinkedIn is now read **agent-side**: the headless `connect` run launches Claude Code with Claude in Chrome (`--chrome`) and only its read and navigate tools; the agent passes the people it read to `people.find` as hints with `source: "linkedin"`. This is the exact first live procedure. Nothing here runs without Wassim at the keyboard.

## Before (with Wassim)

1. **Role.** One role Wassim picked (status `on-deck` or `draft-ready`), at a company where he expects at least one 1st-degree connection. One role only for the first run.
2. **Chrome.** Claude in Chrome extension installed in his own Chrome, signed in to LinkedIn, site permission for `linkedin.com` granted. Close other LinkedIn tabs.
3. **Config** (`pp op config.get`): `linkedin.mode: "live"` (`"off"` disables LinkedIn; `"dry-run"` keeps Chrome off), `max_profiles_per_day: 40`, `max_pages_per_run: 6`, `max_mutual_expansions: 3`, `min_delay_s: 20`. For the first run consider `max_pages_per_run: 3` (`pp op config.update --input '{"patch":{"linkedin":{"max_pages_per_run":3}}}'`).
4. **Tools the run gets** (`SKILL_TOOLS.connect` in `packages/engine/ops/runner.ts`, mirrored in `skills/connect/SKILL.md ## Tools`): pp MCP tools; Gmail `search_threads`, `get_thread`, `get_message`, `create_draft`; Chrome `tabs_context_mcp`, `tabs_create_mcp`, `tabs_close_mcp`, `navigate`, `get_page_text`, `read_page`, `find`. Denied: Chrome `computer` (clicks, typing, screenshots), `form_input`, `javascript_tool`, `browser_batch`, `file_upload`, `upload_image`, `shortcuts_execute`, `gif_creator`; Bash, Write, Edit; every Gmail write but `create_draft`. `--permission-mode dontAsk` denies anything else.
5. **Gmail** (Gmail via agent): the claude.ai Gmail connector is connected in Claude Code. The run creates drafts only.

## Run

1. `pp doctor` passes; `PP_HOME` is the real vault (never the repo).
2. Note today's budget: `pp op runs.list --input '{"op":"people.find"}'` and sum today's `linkedin_profiles_read` (or read the `profiles left today` number in the run prompt).
3. Start the run from the role's Connect button, or `pp op runs.start --input '{"skill":"connect","role_id":"<role_id>"}'` then `pp drain`. Watch Chrome: the session's tab is reused (a new one only if none is usable) and, 20 to 40 s apart, at most `max_pages_per_run` pages load, only these:
   - `linkedin.com/search/results/people/?keywords=<Company>&network=["F"]` (1st-degree connections at the company)
   - `linkedin.com/company/<slug>/people/?keywords=<title keywords>` (People page)
   - up to 3 "mutual connections" lists (`/search/results/people/?...`) for top 2nd-degree people
   No profile page, messaging, invitation, feed or follow page; no clicks. When the run ends, its tabs are closed (Runs > the run: **Tabs**; the log lists their ids), and no blank tab is left.
4. The run calls `people.find { role_id, hints: [... source: "linkedin" ...], linkedin: { pages_opened } }`, then classifies, finds emails and writes drafts as SKILL.md says. Wassim resolves any Needs-you picks and confirms the tiers (the "correct tiers" check).
5. Gmail: up to four drafts (warm_hiring, warm_other, bridge, cold_hiring). A 2nd-degree hiring-team target is drafted on its chosen path (#98): People shows **Path** with the recommended one and the alternative; **Use** switches before drafting. Wassim opens Gmail, checks To (direct = the target; bridge = the mutual), edits, sends himself or deletes. A draft whose address is a guess waiting in Needs you is not in Gmail yet (#99): confirming the address in Needs you queues its Gmail draft with To filled; a draft already in Gmail with no To gets a To update run (the only run granted the connector's update draft tool). A guess the evidence proves (an exact sighting, or 2+ colleagues at the domain in the same format, found read-only in Wassim's own Gmail or on public pages) skips Needs you; otherwise the Needs you card lists each candidate with its evidence, and Wassim clicks **Check** (opens the address checker in his browser, address copied), then **Valid** or **Invalid**. The run never contacts a mail server or a verification site.

## Verify

- **Provenance:** the latest `people.find` run (`runs.list { op: "people.find" }`) has `linkedin_mode: "agent"`, `linkedin_people` > 0, `linkedin_pages_opened` <= `max_pages_per_run`, no `linkedin_over_page_cap`. The People screen shows `LinkedIn: N people` for the role (any other run shows `LinkedIn not read` with the reason).
- **Caps:** `linkedin_profiles_read` (people + their via mutuals) <= the budget the prompt stated; `linkedin_budget_left` = budget minus that; `linkedin_rejected` counts hints the engine dropped (bad URL, over budget). A second run the same day starts with the lower budget.
- **Stored data:** contacts from this run have only name, headline, `https://www.linkedin.com/in/<slug>` URL, source `linkedin` and the role link (degree, tier, via, hiring team). `notes` is empty.
- **Nothing was sent:** the runner log (`$TMPDIR/pp-runs/<run_id>.log`, `permission_denials`) shows no Chrome tool outside the allowlist was used; on LinkedIn, *My Network > Manage > Sent* has no new invitation, *Messaging* has no new message, and no new follows; Gmail *Sent* has nothing new (only *Drafts*).

## Stop conditions

- Any LinkedIn checkpoint, captcha, "unusual activity" or sign-in wall: the agent stops and reports `skipped: "checkpoint"` / `"signed_out"`; do not retry that day.
- A denied tool in the runner log (`tool denied: ...`): stop and file a bug; never widen the allowlist to get past it.
- `capped: true`: stop for the day.

## After

- The `run` row is written automatically. Record selector or page-shape notes (what text the people cards had) in `packages/engine/integrations/linkedin/README.md`.
- No screenshots, transcripts, names or URLs from the live run go into the repo. Fixtures stay synthetic.
