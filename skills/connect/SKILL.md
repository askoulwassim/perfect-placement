---
name: connect
description: Find people who can open doors for a picked role, classify each one (hiring manager, hiring team, recruiter, peer, unrelated), and write outreach drafts (Hook / Proof / Ask + sign-off, in the user's voice) that land as Gmail drafts. Use after a role is picked (on-deck or later). Never sends, never connects or messages on LinkedIn.
---

# connect

**Owner: lane H.** Stage 06 of the flow: runs on pick, outputs contacts + Gmail **drafts**.

You supply judgment (who is in the JD, the draft text). Code does mechanics (LinkedIn reads, caps, dedupe, tiers, files, Gmail). Every write is an op.

## Steps

1. **Check the role is picked.** `roles.get { role_id }`. Status must be `on-deck` or later (not archived). `people.find` refuses anything else.
2. **Collect hints (judgment).** Read the JD (`roles/<role_id>.md`) and, if useful, the company team page. List people named there: name, headline, URL or email if shown. Do not search for personal emails (the email step below looks for work addresses only).
3. **Find.** `people.find { role_id, hints?: [{ name, headline?, linkedin_url?, email?, source: "jd" | "company_site" }] }`.
   Add `dry_run: true` first if the user wants a preview. The LinkedIn adapter reads 1st-degree connections at the company, the company People page filtered by the role title, and mutuals for a few 2nd-degree people. It is capped per day (`config.linkedin.max_profiles_per_day`) and slow (`min_delay_s` .. 2x between pages). `capped: true` means try again tomorrow; do not work around it.
4. **Classify.** For each found contact: `people.classify { contact_id, role_id }`. The resolver answers; low confidence lands in Needs you with the pick shown. Tier is mechanics:

   | | Hiring team (hiring manager, hiring team, recruiter) | Not hiring team |
   | --- | --- | --- |
   | 1st degree | `warm_hiring`: ask for a conversation about the role | `warm_other`: coffee chat, or intro to the hiring manager |
   | 2nd degree | `bridge`: note to the mutual + forwardable blurb | same |
   | Cold | `cold_hiring`: their problem, one proof, one ask | `cold_other`: skip unless the user asks |

5. **Pick the best path.** Draft for the top contact per tier, in order warm_hiring, warm_other, bridge, cold_hiring. Usually one to four drafts per role. Skip `cold_other` unless asked.
6. **Email (judgment: what you saw; code: the guess).** For each contact you will draft to (bridge: the mutual), find addresses, read-only:
   - **Gmail** (your Gmail tool, search and read only: `search_threads`, `get_thread`, `get_message`): threads with the person (`from:` / `to:` their name) and signatures; also any addresses at the company domain (`@<domain>`), which teach the company's format.
   - **LinkedIn** contact info for 1st-degree connections, inside the same caps (never message or connect).
   - **Public pages**: the JD, the company team page, talks, GitHub, a personal site.
   Then call `people.find_email { contact_id, role_id, hints: [{ email, name?, source: "gmail" | "linkedin" | "public" }], domain? }`. Pass every address you saw at the company with whose it is when you know; pass `domain` when the company has none on file (dossier or website). The op keeps a known address, else learns the format (`first.last`, `flast`, `first`, `firstl`, `f.last`, `last`), checks the domain's MX record and ranks candidates: a confident pick is stored as confirmed; an unsure one is stored as a guess and goes to Needs you with the alternatives. Never guess the address yourself, never probe a mail server, never send a test email, and never use a paid finder.
7. **Write the draft (judgment).** The draft must read like a real email from the user, in their voice. Gather the writer inputs, keeping the two kinds of facts apart:
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
   Bridge drafts are addressed to the mutual, not the target.
8. **Save.** `outreach.draft { contact_id, role_id, tier, subject, hook, proof, ask, signoff? }`. Agent-written drafts pass the same `checkDraft` as engine-written ones: it refuses rule breaks with the exact issue (`em_dash`, `too_long`, `too_many_sentences`, `ungrounded_number`, `flattery`, `empty`); fix and call again.
9. **To Gmail.** Follow "Gmail draft step" below. It creates a Gmail **draft** and stops. The user opens Gmail and sends.

## Gmail draft step

The engine has no Gmail client. You create the draft with your own Gmail draft tool, then record it. This works from any MCP client that has a Gmail draft tool next to the `pp` server: Claude Code uses the Gmail connector (`create_draft`); Codex and Cursor need their own Gmail MCP server configured for this step. The web UI's **Create Gmail draft** starts a headless `connect` run for one outreach (`runs.start { skill: "connect", outreach_id }`) that does only this step.

1. **Read the draft.** `outreach.get { outreach_id }`: subject, hook, proof, ask, signoff and `body`. No subject: the role title plus " at " and the company (`roles.get`).
2. **Recipient.** `outreach.get` returns `to`: the contact, or the mutual for bridge drafts (never the target). To = `to.email`. When `to.email` is null, leave To empty: `to.reason` says why (no address found, or an unconfirmed guess waiting in Needs you). Never use `to.guess`.
3. **Create a Gmail DRAFT.** Body = the `body` field exactly as returned: greeting line, blank line, Hook, blank line, Proof, blank line, Ask, blank line, sign-off (plain text, built from the stored blocks, which the user may have edited). Never send, reply or forward. No Gmail draft tool: stop and finish the run as `error` with a note.
4. **Record it.** `outreach.to_gmail { outreach_id, gmail_draft_id, confidence }`. Medium impact: with `confidence` the policy grid decides; without it, or unsure, it waits in Needs you. It re-checks the writing rules, stores the id, sets the outreach `in_gmail` and moves the application to Fill.
5. **Finish** (headless run): `runs.finish { run_id, status: "ok", summary: { outreach_id, gmail_draft_id, to, to_reason } }` (`to` null and `to_reason` set when the draft has no To).

## Never

- Never send an email. `outreach.send` is unimplemented on purpose.
- Never connect, message, follow or InMail on LinkedIn. The adapter cannot; do not try another way.
- Never store more than name, headline, URL, relationship and email (with its source and confidence).
- Gmail is search, read and draft only. Never send, reply, forward, delete or trash.
- Never run people.find on a role the user has not picked.
- Never commit anything from the vault. Placeholders only in examples.

Wave 2 live run: see `RUNBOOK.md`.
