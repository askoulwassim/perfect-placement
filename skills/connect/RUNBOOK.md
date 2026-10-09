# Connect: first live run (Wave 2, Wassim present)

Lane H "done when": on one real picked role, correct tiers and four drafts in Gmail drafts. Wave 1 shipped everything in dry-run only. This is the exact live procedure. Nothing here runs without Wassim at the keyboard.

## Before (decide with Wassim)

1. **Role.** One role Wassim picked (status `on-deck` or `draft-ready`), at a company where he expects at least one 1st-degree connection.
2. **Browser driver** (implements `LinkedInDriver`: `open(url)` + `readPeopleCards()` only):
   - **A. Playwright** `chromium.launchPersistentContext(<copy of Wassim's Chrome profile dir>, { headless: false, channel: 'chrome' })`. Uses his signed-in session. Chrome must be closed (profile lock), or use a dedicated profile he signs into once.
   - **B. Claude in Chrome** (extension in his own Chrome). Driver = an agent loop that calls `navigate` + `get_page_text` and parses cards. No profile copy, but slower and needs site permission for linkedin.com.
3. **Gmail (decided: Gmail via agent).** The engine has no Gmail client. The agent session creates the draft with its own Gmail tool (Claude Code: the claude.ai Gmail connector, `create_draft`) and records it with `outreach.to_gmail { outreach_id, gmail_draft_id }`. A full headless `connect` run (`runs.start { skill: "connect" }`) is granted `mcp__claude_ai_Gmail__create_draft` (#79) and creates the drafts itself; every other Gmail write (send, reply, forward, draft update / delete, trash, spam, labels) is denied. From the web UI, **Create Gmail draft** starts a headless `connect` run for one outreach (`runs.start { skill: "connect", outreach_id }`) that does only that step. Check the connector is connected in Claude Code first. No OAuth app.
4. **Caps for the first run.** `config.linkedin.max_profiles_per_day: 40` (default), `min_delay_s: 20`. Per call: max 6 pages, max 3 mutual expansions. Expected: 3 to 6 page loads over 1 to 4 minutes.

## Run

1. `pp doctor` passes; `PP_HOME` is the real vault (never the repo).
2. Dry preview: `people.find { role_id, dry_run: true }` with the live driver. Wassim eyeballs the list. Nothing is written.
3. `people.find { role_id }`. Reads, in order:
   - `linkedin.com/search/results/people/?keywords=<Company>&network=["F"]` (1st-degree connections)
   - `linkedin.com/company/<slug>/people/?keywords=<title keywords>` (People page)
   - up to 3 "mutual connections" lists for 2nd-degree people
   Stored per person: name, headline, profile URL, degree, via mutual. Nothing else.
4. `people.classify` for each contact. Wassim resolves any Needs-you picks.
5. Wassim confirms the tiers are right (the "correct tiers" check).
6. **Emails** (#37) for each contact to draft (bridge: the mutual): the agent searches Gmail read-only and public pages, then `people.find_email { contact_id, role_id, hints }`. Wassim resolves any `Use <address>?` card in Needs you (pick, type another, or skip: no To).
7. For the best contact in each of warm_hiring, warm_other, bridge, cold_hiring (where one exists): skill writes Hook / Proof / Ask from Story + Voice, `outreach.draft`, Wassim reads the vault file.
8. Gmail draft step for each (SKILL.md "Gmail draft step", or **Create Gmail draft** in the UI). Four Gmail drafts. Wassim opens Gmail, checks To (bridge = the mutual; empty when the address is unconfirmed), edits if needed, sends himself or deletes.

## Stop conditions

- Any LinkedIn checkpoint, captcha, "unusual activity" or sign-in wall: stop, do not retry that day.
- `LinkedInGuardError`: stop and file a bug; never widen the allowlist to get past it.
- `capped: true`: stop for the day.

## After

- Record the run (`run` row is written automatically) and any selector fixes in `packages/engine/integrations/linkedin/README.md`.
- No screenshots, names or URLs from the live run go into the repo.
