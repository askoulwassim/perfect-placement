---
name: connect
description: Find people who can open doors for a picked role, classify each one (hiring manager, hiring team, recruiter, peer, unrelated), and write outreach drafts (Hook / Proof / Ask + sign-off, in the user's voice) that land as Gmail drafts. Use after a role is picked (on-deck or later). Never sends, never connects or messages on LinkedIn.
---

# connect

**Owner: lane H.** Stage 06 of the flow: runs on pick, outputs contacts + Gmail **drafts**.

You supply judgment (who is in the JD, who you read on LinkedIn, the draft text). Code does mechanics (URL allowlist, caps, budget, dedupe, tiers, files). Every write is an op.

## Steps

1. **Check the role is picked.** `roles.get { role_id }`. Starting Connect (`runs.start` or `people.find`) on an `active` or `held` role picks it (-> on-deck, `role_picked`, #105); `inbox` and `archived` roles are refused.
2. **Collect hints (judgment).** Read the JD (`roles/<role_id>.md`) and, if useful, the company team page. List people named there: name, headline, URL or email if shown. Do not search for personal emails (the email step below looks for work addresses only).
3. **Read LinkedIn (judgment, read-only, #82).** Only when the prompt's LinkedIn line says it is on (`config.linkedin.mode: "live"`) and only for this picked role. Use Claude in Chrome's read and navigate tools (listed under Tools); nothing that clicks, types or runs script is granted. Start with `tabs_context_mcp` and reuse the tab this Chrome session created (`navigate` it); create one with `tabs_create_mcp` only if none is usable, so no empty extra tab is left. Then, waiting the stated delay (`min_delay_s` to 2x) before every page, read in this order and stop at the page cap (`max_pages_per_run`) or the profile budget the prompt states:
   - **Your 1st-degree connections at the company:** `https://www.linkedin.com/search/results/people/?keywords=<Company>&network=["F"]`.
   - **The company People page,** filtered by the role title's keywords: `https://www.linkedin.com/company/<linkedin-slug>/people/?keywords=<title keywords>`.
   - **Mutuals** for the top 2nd-degree candidates (at most `max_mutual_expansions`): the "N mutual connections" link on their card (a `/search/results/people/` URL).
   - **Hiring team:** if the posting is on LinkedIn and lists "Meet the hiring team", note those names (`hiring_team: true`).
   Read only names, headlines, profile URLs (`https://www.linkedin.com/in/<slug>`), the degree badge (1st, 2nd, 3rd+) and the mutual. Never open a profile, messaging, invitation, follow or feed page; never press Connect, Message, Follow, Like or any button. A sign-in wall, checkpoint, captcha or "unusual activity" page: stop at once, read nothing more, and report it (`skipped: "checkpoint"` or `"signed_out"`). No Chrome tools in this session (Codex, Cursor, no extension): `skipped: "no_browser"`.
4. **Find.** `people.find { role_id, hints, linkedin: { pages_opened, skipped? } }`. Hints:
   - From the JD and team page: `{ name, headline?, linkedin_url?, email?, source: "jd" | "company_site" }`.
   - From your LinkedIn read: `{ name, headline, linkedin_url, source: "linkedin", degree: "1" | "2" | "cold", via?: { name, headline, linkedin_url, tie? } (2nd degree, the mutual), hiring_team?: true }`.
   - `via.tie` (judgment, #98): `{ same_company, same_industry, history }`, how close the mutual is to this person: `same_company` when the mutual's headline puts them at the target's company, `same_industry` when it is the same industry, `history` when you saw they worked or talked together. Omit what you did not see (default false).
   Always pass `linkedin.pages_opened` (0 if you opened none) and, if you read nothing, `skipped` (`no_browser`, `signed_out`, `checkpoint`, `capped`, `not_found`, `error`). The engine keeps only `/in/<slug>` profile URLs, counts every person and mutual against the daily budget, drops hints beyond it (`capped: true`: stop for today, do not work around it) and records `linkedin_mode: "agent"` only when you really read LinkedIn. Add `dry_run: true` first if the user wants a preview.
5. **Classify.** For each found contact: `people.classify { contact_id, role_id }`. The resolver answers; low confidence lands in Needs you with the pick shown. Tier is mechanics:

   | | Hiring team (hiring manager, hiring team, recruiter) | Not hiring team |
   | --- | --- | --- |
   | 1st degree | `warm_hiring`: ask for a conversation about the role | `warm_other`: coffee chat, or intro to the hiring manager |
   | 2nd degree | `bridge`: note to the mutual + forwardable blurb (or a direct note, see below) | same |
   | Cold | `cold_hiring`: their problem, one proof, one ask | `cold_other`: skip unless the user asks |

6. **Pick the best path.** A 2nd-degree hiring-team contact with a mutual has two paths (#98), ranked by code in `roles.get` (`contacts[].paths`): **direct** (a note to the target, tier `cold_hiring`) or **bridge** (an intro ask to the mutual, tier `bridge`). Direct wins when the target's email is confirmed or likely and the mutual is a weak tie; bridge only for a strong mutual with an email; a bridge to a mutual with no email is `blocked` while a direct path exists. Draft the `chosen` path (the user may have switched it with `people.set_path`); the other open path may be drafted too when the user asks (both are kept). `outreach.draft` refuses a blocked bridge. Run the email step for the target first: their address decides whether direct is reachable. Then draft for the top contact per tier, in order warm_hiring, warm_other, bridge, cold_hiring. Usually one to four drafts per role. Skip `cold_other` unless asked. No usable contact (none found, or every one is `cold_other`): follow "No usable contact" below; the role must never stall in Connect.
7. **Email (judgment: what you saw; code: the guess and the check).** For each contact you will draft to (bridge: the mutual; a 2nd-degree hiring target: the target and the mutual, so the paths rank on real addresses), find addresses, read-only:
   - **Gmail** (read-only here: `mcp__claude_ai_Gmail__search_threads`, `mcp__claude_ai_Gmail__get_thread`, `mcp__claude_ai_Gmail__get_message`): threads with the person (`from:` / `to:` their name) and signatures.
   - **Inbox peers (#99):** search the user's own mail for `@<domain>` and note real addresses at the company domain in the from / to / cc headers, each with the display name when the header shows one. Keep only the address (and that name, to infer the format); never copy a subject, body or anything else.
   - **Public pages**: the JD, the company team page, talks, GitHub, a personal site.
   Then call `people.find_email { contact_id, role_id, hints: [{ email, name?, source: "gmail" | "linkedin" | "public" }], evidence: [{ kind: "inbox_peer" | "public_mention", address, source, url?, name? }], domain? }`. `hints` = addresses that are this person's (or that you saw with whose they are); `evidence` = inbox peers (`source: "gmail"`) and public mentions (`source`: the page, `url`). Pass `domain` when the company has none on file (dossier or website). The op keeps a known address, else learns the format (`first.last`, `flast`, `first`, `firstl`, `f.last`, `last`), ranks candidates and checks each one passively: syntax, the domain's MX (or A) record, disposable / role / free lists, and the evidence (peers in the candidate's format, an exact sighting). An exact match, or 2+ peers agreeing with none conflicting, is confirmed without asking; a domain with no mail records drops the candidate; anything else is stored as a guess and goes to Needs you, where the user checks it by hand. If the result is not confirmed, look for the exact candidate addresses (`candidates[].email`) in the user's mail (`"<address>"`) and on public pages you can read, and call `people.find_email` again with what you found as `evidence` (it replaces the pending pick). Never guess the address yourself.
   **Never contact mail servers or verification sites:** no SMTP, no mailbox probe, no test email, no email-checker or verification website or API, no paid finder. The user does the manual check in Needs you.
8. **Write the draft (judgment).** The draft must read like a real email from the user, in their voice. Gather the writer inputs, keeping the two kinds of facts apart:
   - **CONTEXT** (facts about them, usable for the hook): the contact's headline, the role's JD (`roles/<role_id>.md`, the JD section), the company dossier (`companies/<slug>/dossier.md`: snapshot, why, hooks, news). Never present CONTEXT as a fact about the user.
   - **STORY** (`profile/story.md` plus the Story component data): the only source of facts about the user.
   - **VOICE** (`profile/voice.md` plus the Voice component: `style`, `rules`, `signoff`, `samples`): tone only. Treat every writing sample as a style exemplar: match its tone, rhythm and phrasing; never reuse its facts, names or numbers. Use all of them, even when voice.md has text.

   The engine's own writer prompt (`buildWriterPrompt` in `packages/engine/people/templates.ts`) uses exactly these inputs and rules. Write:
   - **Hook**: opens with a greeting ("Hi Maya,"), then one or two lines about their world from CONTEXT (reframe what they care about). Max 320 chars. A number here must appear in STORY or CONTEXT.
   - **Proof**: two or three sentences, first person, from STORY only, tied to what the role needs. At most 3 sentences, max 560 chars. Never a number that is not in STORY.
   - **Ask**: one small, specific ask (the close). Max 240 chars; bridge max 560 (includes the forwardable blurb).
   - **Sign-off**: in the user's voice, max 80 chars. Default: Voice `signoff`, else "Thanks," plus the first name from Story (omit `signoff` to get the default).
   - **Subject**: short, plain. Max 80 chars.
   - No em dashes, no en dashes. No flattery ("huge fan", "I admire", "amazing team" are refused). No facts beyond STORY.
   Bridge drafts are addressed to the mutual, not the target. A direct note to a 2nd-degree target is a `cold_hiring` note to them (no mention of the mutual needed).
9. **Save.** `outreach.draft { contact_id, role_id, tier, subject, hook, proof, ask, signoff? }`. `contact_id` is the target; the engine files the draft under the person it is addressed to (a bridge intro under the mutual, with `about_contact_id` = the target), one draft per recipient. Agent-written drafts pass the same `checkDraft` as engine-written ones: it refuses rule breaks with the exact issue (`em_dash`, `too_long`, `too_many_sentences`, `ungrounded_number`, `flattery`, `empty`); fix and call again.
10. **To Gmail.** For each saved draft, follow "Gmail draft step" below in this same run (`mcp__claude_ai_Gmail__create_draft` is granted to every `connect` run). It creates a Gmail **draft** and stops. The user opens Gmail and sends. A draft whose recipient's address is a guess waiting in Needs you (`outreach.get`'s `to.decision_id` is set) gets **no** Gmail draft now (#99): leave it saved in the vault; once the address is confirmed the engine queues the Gmail draft step for it with To filled.

## Chrome tabs

At the end of a run that used Chrome (done or failed, #107): close every tab you opened or used with `tabs_close_mcp`, never a tab the user already had open, and report them on the finish: `runs.finish { run_id, status, tabs: { opened: [<every tab id you used>], closed: [<ids you closed>], left_open: [] } }`. The run log lists them. A connect run leaves no tab open.

## No usable contact

When `people.find` returns nobody usable, Connect falls back automatically (#78). You find (judgment); `people.fallback` picks (code), in this order:

1. **Hiring team or recruiting address.** Search the JD, the careers page, the dossier (`companies/<slug>/dossier.md`) and the company site for a team mailbox (`recruiting@`, `talent@`, `jobs@`, `careers@`, `hiring@`) or a named recruiter with a work address. Public pages only; never a personal address.
2. **The likely hiring leader.** From the dossier: who this role most likely reports to (e.g. the CPO or VP Product), with headline and LinkedIn URL if the dossier has it.
3. Call `people.fallback { role_id, team_inbox: [{ email, name?, source: "jd" | "careers" | "dossier" | "company_site", url? }], leader?: { name, headline?, linkedin_url? }, domain?, email_hints?, reason? }` with everything you found (or nothing). The engine also scans the JD and dossier for team mailboxes, keeps only addresses at the company domain, and then:
   - **`team_inbox`**: a contact "Hiring team" (or the named recruiter), `email_source: public`, linked `cold_hiring`. Draft to it.
   - **`cold_leader`**: the leader as a `cold_hiring` contact; `people.find_email` guesses the address (flagged as a guess; an unsure one waits in Needs you, so the Gmail draft has no To until confirmed). Draft to them.
   - **`skipped`**: nothing usable; the application moves from Connect to Fill. Stop: no draft. (`apply.skip_connect { role_id, reason }` does the same on its own; the UI's **Skip** calls it.)
4. **Fallback draft (judgment).** The draft is a shortened version of the tailored **cover letter** (`applications/<role_id>/cover_letter.md`), in the user's voice: Hook = greeting ("Hi <Company> team," for a team inbox, else the first name) plus why this role; Proof = two or three first-person sentences from the cover letter; Ask = team inbox: pass it to the hiring manager; leader: a short call. The cover letter counts as a fact source next to STORY for these drafts only (it passed the tailor fact check); everything else in step 8 applies, and `outreach.draft` runs the same `checkDraft`. Then the Gmail draft step as usual.

## Gmail draft step

The engine has no Gmail client. You create the draft with your own Gmail draft tool, then record it. This works from any MCP client that has a Gmail draft tool next to the `pp` server: Claude Code uses the claude.ai Gmail connector (`mcp__claude_ai_Gmail__create_draft`); Codex and Cursor need their own Gmail MCP server configured for this step. A full `connect` run does this step itself for each draft it saved. The web UI's **Create Gmail draft** starts a headless `connect` run for one outreach (`runs.start { skill: "connect", outreach_id }`) that does only this step (for a draft saved earlier, or one the user edited).

1. **Read the draft.** `outreach.get { outreach_id }`: subject, hook, proof, ask, signoff and `body`. No subject: the role title plus " at " and the company (`roles.get`).
2. **Recipient.** `outreach.get` returns `to`: the contact, or the mutual for bridge drafts (never the target). To = `to.email`. When `to.decision_id` is set (a guessed address waiting in Needs you), create nothing: the engine queues this step once the address is confirmed (`outreach.to_gmail` and `runs.start` refuse it meanwhile). When `to.email` is null otherwise (no address found), leave To empty: `to.reason` says why. Never use `to.guess`.
3. **Create a Gmail DRAFT.** Body = the `body` field exactly as returned: greeting line, blank line, Hook, blank line, Proof, blank line, Ask, blank line, sign-off (plain text, built from the stored blocks, which the user may have edited). Never send, reply or forward. No Gmail draft tool: stop and finish the run as `error` with a note.
4. **Record it.** `outreach.to_gmail { outreach_id, gmail_draft_id, confidence }`. Medium impact: with `confidence` the policy grid decides; without it, or unsure, it waits in Needs you. It re-checks the writing rules, stores the id, sets the outreach `in_gmail` and moves the application to Fill.
5. **Finish** (headless run): `runs.finish { run_id, status: "ok", summary: { outreach_id, gmail_draft_id, to, to_reason } }` (`to` null and `to_reason` set when the draft has no To).

## Gmail To step

A Gmail draft created with no To (before #99, or while its address was still a guess) is fixed once the address is confirmed: the engine queues `runs.start { skill: "connect", outreach_id }` for it and that run is this step only (`summary_json.step: "gmail_to"`). It is the only run granted the Gmail connector's get draft and update draft tools (not part of the full `connect` allowlist below); create, send, reply, forward, delete, trash and labels stay denied.

1. `outreach.get { outreach_id }`: the draft id is `outreach.gmail_draft_id`, To = `to.email`.
2. Read the Gmail draft and keep its subject and body exactly as they are (the user may have edited them in Gmail).
3. Update that same draft with To = `to.email`. Never send.
4. `outreach.to_gmail { outreach_id, gmail_draft_id, confidence }` with the same id: the engine stores the To.
5. `runs.finish { run_id, status: "ok", summary: { outreach_id, gmail_draft_id, to } }`.

## Tools

A headless run pre-approves exactly these (`SKILL_TOOLS` in `packages/engine/ops/runner.ts`; a test keeps this list and that one equal) and denies everything else. If one you need is denied or missing, do not work around it: `runs.finish { run_id, status: "error", summary: { error: "tool denied: <tool>", denied_tools: [...] } }`.

- `mcp__pp`: the pp MCP tools (every Perfect Placement read and write is an op).
- `mcp__claude_ai_Gmail__search_threads`: search Gmail for threads with a contact or the company domain.
- `mcp__claude_ai_Gmail__get_thread`: read a thread (addresses, signatures).
- `mcp__claude_ai_Gmail__get_message`: read one message.
- `mcp__claude_ai_Gmail__create_draft`: create the Gmail **draft** (Gmail draft step). Never send.
- `mcp__claude-in-chrome__tabs_context_mcp`: see the open Chrome tabs and reuse the session's tab (LinkedIn read, step 3).
- `mcp__claude-in-chrome__tabs_create_mcp`: open a tab for the LinkedIn read, only if the session has no usable tab.
- `mcp__claude-in-chrome__tabs_close_mcp`: close the tabs this run opened or used, at the end (never the user's tabs).
- `mcp__claude-in-chrome__navigate`: open an allowlisted LinkedIn people page.
- `mcp__claude-in-chrome__get_page_text`: read the people cards as text.
- `mcp__claude-in-chrome__read_page`: read the page's structure when the text is not enough.
- `mcp__claude-in-chrome__find`: locate the people list or a "mutual connections" link (read only, never click).

The Chrome tools load with `--chrome` only when `config.linkedin.mode` is `live` (`off` or `dry-run`: no Chrome, report `skipped`). Every Chrome tool that clicks, types, fills a form, runs script, uploads or records (`computer`, `form_input`, `javascript_tool`, `browser_batch`, ...) is denied, as are Bash and file writes. Every other Gmail write (send, reply, forward, draft update / delete, trash, spam, labels) is denied. Other MCP clients (Codex, Cursor) use the Gmail MCP server the user configured for them and have no Chrome: they report `skipped: "no_browser"`.

## Never

- Never send an email. `outreach.send` is unimplemented on purpose.
- Never connect, message, follow, like or InMail on LinkedIn, and never click a LinkedIn button. Read people listings only, within the caps; do not try another way.
- Never store more than name, headline, URL, relationship and email (with its source and confidence).
- Gmail is search, read and draft only. Never send, reply, forward, delete, trash or label.
- Never contact a mail server or a verification site (SMTP, mailbox probes, test emails, email checkers). Evidence is passive: the user's own mail (addresses only) and public pages.
- Never run people.find on a role the user has not picked (an inbox or archived role); starting Connect on an active or held role is the pick.
- Never commit anything from the vault. Placeholders only in examples.

First live LinkedIn run (owner present): see `RUNBOOK.md`.
