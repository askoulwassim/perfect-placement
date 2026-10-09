---
name: connect
description: Find people who can open doors for a picked role, classify each one (hiring manager, hiring team, recruiter, peer, unrelated), and write Hook / Proof / Ask outreach drafts that land as Gmail drafts. Use after a role is picked (on-deck or later). Never sends, never connects or messages on LinkedIn.
---

# connect

**Owner: lane H.** Stage 06 of the flow: runs on pick, outputs contacts + Gmail **drafts**.

You supply judgment (who is in the JD, the draft text). Code does mechanics (LinkedIn reads, caps, dedupe, tiers, files, Gmail). Every write is an op.

## Steps

1. **Check the role is picked.** `roles.get { role_id }`. Status must be `on-deck` or later (not archived). `people.find` refuses anything else.
2. **Collect hints (judgment).** Read the JD (`roles/<role_id>.md`) and, if useful, the company team page. List people named there: name, headline, URL or email if shown. Do not search for personal emails.
3. **Find.** `people.find { role_id, hints?: [{ name, headline?, linkedin_url?, email?, source: "jd" | "company_site" }] }`.
   Add `dry_run: true` first if the user wants a preview. The LinkedIn adapter reads 1st-degree connections at the company, the company People page filtered by the role title, and mutuals for a few 2nd-degree people. It is capped per day (`config.linkedin.max_profiles_per_day`) and slow (`min_delay_s` .. 2x between pages). `capped: true` means try again tomorrow; do not work around it.
4. **Classify.** For each found contact: `people.classify { contact_id, role_id }`. The resolver answers; low confidence lands in Needs you with the pick shown. Tier is mechanics:

   | | Hiring team (hiring manager, hiring team, recruiter) | Not hiring team |
   | --- | --- | --- |
   | 1st degree | `warm_hiring`: ask for a conversation about the role | `warm_other`: coffee chat, or intro to the hiring manager |
   | 2nd degree | `bridge`: note to the mutual + forwardable blurb | same |
   | Cold | `cold_hiring`: their problem, one proof, one ask | `cold_other`: skip unless the user asks |

5. **Pick the best path.** Draft for the top contact per tier, in order warm_hiring, warm_other, bridge, cold_hiring. Usually one to four drafts per role. Skip `cold_other` unless asked.
6. **Write the draft (judgment).** Read Story (`profile/story.md`) and Voice (`profile/voice.md`). Write:
   - **Hook**: one line about their world (reframe what they care about). Max 280 chars.
   - **Proof**: one fact from Story. Never a number that is not in Story. Max 400 chars.
   - **Ask**: one small, specific ask (the close). Max 240 chars; bridge max 560 (includes the forwardable blurb).
   - **Subject**: short, plain. Max 80 chars.
   - No em dashes, no en dashes. No flattery. No facts beyond Story.
   Bridge drafts are addressed to the mutual, not the target.
7. **Save.** `outreach.draft { contact_id, role_id, tier, subject, hook, proof, ask }`. It refuses rule breaks with the exact issue; fix and call again.
8. **To Gmail.** Follow "Gmail draft step" below. It creates a Gmail **draft** and stops. The user opens Gmail and sends.

## Gmail draft step

The engine has no Gmail client. You create the draft with your own Gmail draft tool, then record it. This works from any MCP client that has a Gmail draft tool next to the `pp` server: Claude Code uses the Gmail connector (`create_draft`); Codex and Cursor need their own Gmail MCP server configured for this step. The web UI's **Create Gmail draft** starts a headless `connect` run for one outreach (`runs.start { skill: "connect", outreach_id }`) that does only this step.

1. **Read the draft.** `outreach.get { outreach_id }`: subject, hook, proof, ask. No subject: the role title plus " at " and the company (`roles.get`).
2. **Recipient.** The contact's email (`contacts.get`). Bridge: the mutual (the link's `via_contact_id`), never the target. No email on file: leave To empty.
3. **Create a Gmail DRAFT.** Body = Hook, blank line, Proof, blank line, Ask, as stored (the user may have edited them). Never send, reply or forward. No Gmail draft tool: stop and finish the run as `error` with a note.
4. **Record it.** `outreach.to_gmail { outreach_id, gmail_draft_id, confidence }`. Medium impact: with `confidence` the policy grid decides; without it, or unsure, it waits in Needs you. It re-checks the writing rules, stores the id, sets the outreach `in_gmail` and moves the application to Fill.
5. **Finish** (headless run): `runs.finish { run_id, status: "ok", summary: { outreach_id, gmail_draft_id } }`.

## Never

- Never send an email. `outreach.send` is unimplemented on purpose.
- Never connect, message, follow or InMail on LinkedIn. The adapter cannot; do not try another way.
- Never store more than name, headline, URL, relationship (plus an email when the JD or Gmail already has it).
- Never run people.find on a role the user has not picked.
- Never commit anything from the vault. Placeholders only in examples.

Wave 2 live run: see `RUNBOOK.md`.
