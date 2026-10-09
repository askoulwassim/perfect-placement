---
name: fill
description: Classify a draft-ready role's real application-portal questions (portal fills, standard, written), draft only the written answers in the user's voice from Story, the JD and dossier, and save them with the `apply.fill` op, which fills standard answers from the saved Application defaults, fact-checks the written ones and flags only what needs the user, each with a reason. Never submits; the role stays draft-ready.
---

# Fill

Strong, truthful answers to the application's **actual** questions, and nothing the user has to wade through.

## When

After tailor, while the role is `draft-ready`. Read the real questions; never answer hypothetical ones.

## Inputs

- The portal's questions, from one of two places:
  - **Pasted** (the prompt says so, and `roles.get` lists a `questions` path): the user pasted them on the Answers tab (`apply.set_questions`). Read them with `vault.read { path }` (that file is in the vault; skill files are never in the vault) and answer exactly those. Do not open the portal for questions.
  - **The portal**, read through Claude in Chrome (below).
- `roles.get { role_id }`: the role (JD in its file) and the application paths (resume, cover letter, fit map, dossier).
- `profile.get`: Story (the only source of facts), Voice (style). Standard answers are the code's job (below); do not copy them yourself.

## Reading the portal (read-only)

Questions often sit on other tabs or steps of the same page (Application, Questions, Voluntary disclosures). Read them all; never act on the page.

1. Open the apply page in a new tab (`tabs_create_mcp`, then `navigate` to the portal URL: the role's `portal_url`, else its posting URL and its Apply link).
2. Read it with `get_page_text` and `read_page` (the accessibility tree often holds hidden tab panels too).
3. Find every tab and step link with `find` ("Application tab", "Next step") and `navigate` to each URL (`#questions`, `?step=2`, `/application`). There is no click tool: a tab or step with no URL of its own stays unread.
4. Never click, type, fill a field, upload, run script or submit. You may only read and navigate.
5. Questions still unreadable (behind a login, a button with no URL): do not guess them. Finish with `runs.finish { run_id, status: "error", note: "portal questions unreadable" }`; the user pastes them on the Answers tab (**Add questions**), which reruns Fill.

## Steps

1. `runs.start { skill: "fill", role_id }`.
2. Classify every question (your judgment):
   - `autofill`: identity and upload fields. `field`: `name`, `email`, `phone`, `linkedin`, `github`, `website`, `resume`, `cover_letter`, else `other`. No answer needed; the op lists them once as **Portal fills** with the profile values.
   - `standard`: the questions every portal asks. `field`: `sponsorship`, `work_authorization` (set `country`), `relocation` (set `country` when it names one), `start_date`, `notice_period`, `comp_expectation`, `in_office`, `location`, `eeo` (any demographic question), else `other`. Leave `answer` empty: the op answers from the saved **Application defaults** (Terms), Work mode and Terms. With nothing saved it flags the question with the reason ("no saved work authorization for Canada"); you may put a suggestion in `answer`.
   - `written`: real questions ("Why us?", "Have you maintained an open source project?"). Draft from Story + CONTEXT (JD, dossier) in Voice: specific stories and metrics, 80 to 150 words, hook, reframe, close. Set `confidence` (0 to 1) for how well Story supports it.
3. Flag (`needs_human: true` + a one-line `reason`) **only** a legal or personal question that no saved default covers (criminal record, non-compete, a former-employee question) or something only the user can say. Do not flag standard questions, identity fields or grounded drafts: the op flags what it cannot answer, every unsupported fact (each also becomes a keep / remove / edit decision in Needs you) and any answer below the policy's confidence threshold.
4. `apply.fill { role_id, portal_url, answers: [{ question, kind, field?, country?, answer?, confidence?, needs_human?, reason? }] }`. The op writes `applications/<role_id>/answers.md` grouped **Needs you / Written / Standard / Portal fills** and advances the application to the submit stage. Report `counts` and every needs-you `reason`.
5. `runs.finish { run_id, status: "ok" }`.

**Never submit, and never fill a field in the portal: only read its questions.** Applications end at Open portal; the user fills and submits.

## Answers from Ask

The user can also work a question out in Ask (Cmd+K). When they want that answer kept, the Ask session saves it with `apply.fill { role_id, answers: [{ question, kind: "written", answer }] }` for the role in focus (draft-ready only). Its MCP server marks it `source: "ask"`: the answer merges into the role's Answers (same question replaced, others kept), is fact-checked like any written answer, and shows **Saved from Ask**. A later Fill run keeps Ask answers to questions it does not answer.

## Tools

A headless run pre-approves exactly these (`SKILL_TOOLS` in `packages/engine/ops/runner.ts`; a test keeps this list and that one equal) and denies everything else. If one you need is denied or missing, do not work around it: `runs.finish { run_id, status: "error", summary: { error: "tool denied: <tool>", denied_tools: [...] } }`.

- `mcp__pp`: the pp MCP tools (every Perfect Placement read and write is an op).
- `WebFetch`: read a plain posting page (a JD or apply link) without the browser.
- `mcp__claude-in-chrome__tabs_context_mcp`: see the open tabs.
- `mcp__claude-in-chrome__tabs_create_mcp`: open the portal in a new tab.
- `mcp__claude-in-chrome__navigate`: go to the portal and to each tab or step URL.
- `mcp__claude-in-chrome__get_page_text`: read a page's text.
- `mcp__claude-in-chrome__read_page`: read the accessibility tree (hidden tab panels included).
- `mcp__claude-in-chrome__find`: find the tab and step links.

Denied outright (`--disallowedTools`): every Chrome tool that acts on a page (`computer` clicks and types, `form_input`, `javascript_tool`, `file_upload`, `upload_image`, `browser_batch`, `shortcuts_execute`, `gif_creator`), every Gmail write, and Bash / Write / Edit. Codex and Cursor have no Chrome: they read with WebFetch, or answer the pasted questions.

## Rules

- Truth only. Never state a fact Story does not hold; never reword a number to pass the check.
- No em dashes; punchy (hook, reframe, close).
- Money: `$212.5k` / `$300k` or in full `$300,000`; never a `k` after a full number (`300,000k`).
- Standard answers are set once (onboarding, or You > Terms > Application defaults) and reused; never re-ask them per application.
- Never submit an application or send an email. After the user submits, the inbox skill moves the role to `applied` from the confirmation email.
