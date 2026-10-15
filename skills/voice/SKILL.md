---
name: voice
description: Learn the user's writing voice from their own writing (recent sent Gmail, and their LinkedIn posts when LinkedIn is on), with consent, and propose it as a Voice diff for the user to accept. Started from You > Voice > Learn voice. Never applies the diff, never stores anyone else's words or details.
---

# voice (Learn voice)

Supplies judgment only; every write is an op. Never submit an application or send an email.

The user clicked **Learn voice** in You > Voice: that click is the consent for this run to read their own sent mail and, when `config.linkedin.mode` is `live`, their own LinkedIn posts. The prompt states which sources are on and the caps.

## Steps

1. `profile.get {}`: read the current Voice (style, traits, samples). Keep what is there in mind; you add to it.
2. **Sent Gmail (read-only).** Search the user's sent mail only (`in:sent`, newest first, the last 90 days), at most 30 messages. Read each with `get_message` or `get_thread`. Use only the paragraphs the user wrote: skip quoted replies, forwarded content, signatures, auto-replies, calendar notes and anything mostly someone else's words.
3. **LinkedIn posts (only when the prompt says LinkedIn is live).** Start with `{{browser.tabs}}` and reuse the tab this Chrome session created (create one with `{{browser.new_tab}}` only if none is usable), open the user's own recent activity (posts) page in it, read the text of at most 10 of their own posts. Never open other people's profiles, never like, comment, message, connect, follow or click a button. LinkedIn off: skip this step and report `linkedin_posts: 0`.
4. **Judge the style.** One `style` word when it is clear (`punchy`, `warm`, `formal`, `plain`), and up to 6 short `traits` ("short sentences", "opens with the point", "asks one clear question", "no exclamation marks"). Traits describe how they write, never what they wrote about.
5. **Pick up to 3 samples**, each 40 to 600 characters, that sound most like them. Each must be their own words with **other people removed**: no names of other people, no greetings or thanks to someone by name, no email addresses, phone numbers, links or @handles, no quoted text, no confidential numbers about anyone else. Cut or rewrite those parts out (keep the user's phrasing otherwise). No em dashes: use a comma or a period.
6. `profile.propose_voice { style?, traits, samples, sources: { gmail_sent, linkedin_posts } }`. An `invalid_input` error names the sample and the problem: fix that sample (or drop it) and call again. The op adds the proposal as a pending Voice diff the user accepts or rejects in You; it never applies. Do not call `profile.apply_diff`.
7. Chrome used (step 3): close every tab you opened or used with `{{browser.close_tab}}` (never the user's tabs), also when the run fails. `runs.finish { run_id, status: "ok", summary: { gmail_sent: <n read>, linkedin_posts: <n read>, samples: <n>, traits: <n>, diff_id }, tabs: { opened: [<tab ids used>], closed: [<ids closed>], left_open: [] } }` (`tabs` only when Chrome was used; #107). Nothing usable (no sent mail, all too short): finish `ok` with `samples: 0` and a note.

## Tools

A headless run pre-approves exactly these (`SKILL_GRANTS` in `packages/engine/runners/grants.ts`; a test keeps this list and that one equal) and denies everything else. If one you need is denied or missing, do not work around it: `runs.finish { run_id, status: "error", summary: { error: "tool denied: <tool>", denied_tools: [...] } }`. {{connector.tools}}

- `{{tool:pp}}`: the pp MCP tools (every Perfect Placement read and write is an op).
- `{{tool:gmail.search}}`: search the user's sent mail (`in:sent`).
- `{{tool:gmail.thread}}`: read a sent thread (only the user's own paragraphs are used).
- `{{tool:gmail.message}}`: read one sent message.
- `{{tool:browser.tabs}}`: see the open Chrome tabs and reuse the session's tab (LinkedIn posts, step 3).
- `{{tool:browser.new_tab}}`: open a tab for the user's posts, only if the session has no usable tab.
- `{{tool:browser.close_tab}}`: close the tabs this run opened or used, at the end (never the user's tabs).
- `{{tool:browser.navigate}}`: open the user's own recent activity page.
- `{{tool:browser.text}}`: read the posts as text.
- `{{tool:browser.tree}}`: read the page's structure when the text is not enough.
- `{{tool:browser.find}}`: locate the posts list (read only, never click).

{{voice.tools_note}}

## Never

- Never apply the Voice diff or call `profile.apply_diff`: only the user accepts it.
- Never store recipients, other people's names, addresses or words, or anything from received mail.
- Never read beyond the caps, never read someone else's LinkedIn profile, never act on LinkedIn.
- Gmail is search and read only. Never send, reply, forward, draft, label, delete or trash.
- Never commit anything from the vault. Placeholders only in examples.
