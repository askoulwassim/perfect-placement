---
name: fill
description: Classify a draft-ready role's real application-portal questions (portal fills, standard, written), draft only the written answers in the user's voice from Story, the JD and dossier, and save them with the `apply.fill` op, which fills standard answers from the saved Application defaults, fact-checks the written ones and flags only what needs the user, each with a reason. With the fill assist (Open and fill) it then uploads the rendered resume and cover letter PDFs and fills the answer fields in the portal tab, stops before Submit and reports with `apply.fill_done`. Never submits; the role stays draft-ready.
---

# Fill

Strong, truthful answers to the application's **actual** questions, and nothing the user has to wade through.

## When

After tailor, while the role is `draft-ready`. Read the real questions; never answer hypothetical ones.

## Inputs

- The portal's questions, from one of two places:
  - **Pasted** (the prompt says so, and `roles.get` lists a `questions` path): the user pasted them on the Answers tab (`apply.set_questions`). Read them with `vault.read { path }` (that file is in the vault; skill files are never in the vault) and answer exactly those. Do not open the portal for questions.
  - **The portal**, read through {{browser.name}} (below).
- `roles.get { role_id }`: the role (JD in its file) and the application paths (resume, cover letter, fit map, dossier).
- `profile.get`: Story (the only source of facts), Voice (style). Standard answers are the code's job (below); do not copy them yourself.

## Reading the portal

Questions often sit on other tabs or steps of the same page (Application, Questions, Voluntary disclosures). Read them all; while reading, never act on the page.

1. Start with `{{browser.tabs}}` and reuse the tab this Chrome session created: `{{browser.navigate}}` it to the portal URL (the role's `portal_url`, else its posting URL and its Apply link). Create a tab with `{{browser.new_tab}}` only if none is usable, so no empty extra tab is left.
2. Read it with {{browser.read}} (the accessibility tree often holds hidden tab panels too).
3. Find every tab and step link with `{{browser.find}}` ("Application tab", "Next step") and `{{browser.navigate}}` to each URL (`#questions`, `?step=2`, `/application`). There is no click tool: a tab or step with no URL of its own stays unread.
4. Never click, type, fill a field, upload, run script or submit while reading. You may only read and navigate. (The fill assist, below, fills fields and uploads files afterwards, and only when the prompt says so.)
5. Questions still unreadable (behind a login, a button with no URL): do not guess them. Finish with `runs.finish { run_id, status: "error", note: "portal questions unreadable" }`; the user pastes them on the Answers tab (**Add questions**), which reruns Fill.

## Steps

1. `runs.start { skill: "fill", role_id }`.
2. Classify every question (your judgment):
   - `autofill`: identity and upload fields. `field`: `name` (full name), `first_name`, `last_name`, `preferred_name`, `email`, `phone`, `city` (a City field), `linkedin`, `github`, `website`, `resume`, `cover_letter`, else `other`. No answer needed; the op fills them from the saved contact on Story (You), splitting the full name for First and Last name, the preferred first name for Preferred name, and lists them once as **Portal fills**.
   - `standard`: the questions every portal asks. `field`: `sponsorship`, `work_authorization` (set `country`), `relocation` (set `country` when it names one), `start_date`, `notice_period`, `comp_expectation`, `in_office`, `location` (where you live: the saved city, else Work mode), `eeo` (any demographic question), else `other`. Leave `answer` empty: the op answers from the saved **Application defaults** (Terms), Work mode and Terms. With nothing saved it flags the question with the reason ("no saved work authorization for Canada"); you may put a suggestion in `answer`.
   - `written`: real questions ("Why us?", "Have you maintained an open source project?"). Draft from Story + CONTEXT (JD, dossier) in Voice: specific stories and metrics, 80 to 150 words, hook, reframe, close. Set `confidence` (0 to 1) for how well Story supports it.
3. Flag (`needs_human: true` + a one-line `reason`) **only** a legal or personal question that no saved default covers (criminal record, non-compete, a former-employee question) or something only the user can say. Do not flag standard questions, identity fields or grounded drafts: the op flags what it cannot answer, every unsupported fact (each also becomes a keep / remove / edit decision in Needs you) and any answer below the policy's confidence threshold.
4. `apply.fill { role_id, portal_url, answers: [{ question, kind, field?, country?, answer?, confidence?, needs_human?, reason? }] }`. The op writes `applications/<role_id>/answers.md` grouped **Needs you / Written / Standard / Portal fills** and advances the application to the submit stage. Report `counts` and every needs-you `reason`.
5. Close every tab you opened or used with `{{browser.close_tab}}` (never the user's tabs), then `runs.finish { run_id, status: "ok", tabs: { opened: [<tab ids used>], closed: [<ids closed>], left_open: [] } }` (#107; `tabs` only when Chrome was used, also on a failed run). With the fill assist, step 7 below instead.

**Never submit.** Without the fill assist, never fill a field in the portal: only read its questions. Applications end at Open portal; the user submits.

## Fill assist (Open and fill)

Only when the prompt has a **Fill assist** line (the user clicked **Open and fill**, `runs.start { skill: "fill", assist: true }`), and only with {{browser.name}}. The user is watching; you prepare the application, they submit it.

{{^uploads.off}}1. The PDFs: the engine renders them before launch (`apply.render_documents { role_id, formats: ["pdf"] }`) and the prompt's **Uploads** line gives each one's absolute path (`<PP_HOME>/files/<role_id>/resume.pdf`, `cover_letter.pdf`). The session can read that one folder ({{browser.files_access}}), nothing else of the vault. If the Uploads line says rendering failed, upload nothing, do not render, and list Resume and Cover letter in `skipped` with its reason. Only a prompt with no Uploads line renders here, after `apply.fill`, and uses each returned `abs_path`.{{/uploads.off}}{{#uploads.off}}1. Uploads are unavailable in this run. Do not render or upload documents; report Resume and Cover letter as skipped using the rendering failure reason when provided.{{/uploads.off}}
2. Reuse the portal tab you read (`{{browser.tabs}}`); do not open a second one. Go back to the first step of the form with `{{browser.navigate}}` if needed.
{{^uploads.off}}3. Upload: the resume field gets the resume PDF, a cover letter field the cover letter PDF, with `{{browser.upload}}` (the field's ref from {{browser.locate}}, `{{browser.upload_paths}}: ["<absolute path>"]`, exactly as the Uploads line gives it; never a vault-relative `files/...` path). No cover letter field: skip it.{{/uploads.off}}{{#uploads.off}}3. Skip document uploads; continue filling the saved answer fields.{{/uploads.off}}
4. Fill: each answer field from the saved Answers (`vault.read` the role's `answers` path, that file is in the vault, skill files are never in the vault; Needs you answers that are still empty are skipped), plus the Portal fills (name, first, last and preferred name, email, phone, city, links) from the same file, with `{{browser.fill}}` (ref from {{browser.locate}}). Select and radio fields: the option that matches the answer. A field with no saved answer, a demographic or legal question with no saved default, or anything you are unsure of: leave it empty and list it in `skipped` with a one-line reason.
5. Steps on other pages (a Next button with no URL): you have no click tool. Fill what is on the current page and list the rest in `skipped` ("on step 2").
6. **Stop before Submit.** Never click, press a key, run script or submit; never `{{browser.fill}}` on a Submit, Apply, Send, Next or Finish control. Leave the portal tab open where the user can review; close any other tab you opened or used with `{{browser.close_tab}}`.
7. Report: `apply.fill_done { role_id, filled: [<field labels>], uploaded: {{^uploads.off}}["resume", "cover_letter"]{{/uploads.off}}{{#uploads.off}}[]{{/uploads.off}}, skipped: [{ label, reason }] }` (it refuses a submit-like label), then `runs.finish { run_id, status: "ok", summary: { filled, uploaded, skipped }, tabs: { opened: [<tab ids used>], closed: [<ids closed>], left_open: [<portal tab id>], portal: <portal tab id> } }` (only the portal tab may stay open, #107). The Role screen's primary becomes **Open portal**; the user reviews and submits. After they submit, the inbox skill moves the role to `applied` from the confirmation email.

{{fill.missing}}

## Answers from Ask

The user can also work a question out in Ask (Cmd+K). When they want that answer kept, the Ask session saves it with `apply.fill { role_id, answers: [{ question, kind: "written", answer }] }` for the role in focus (draft-ready only). Its MCP server marks it `source: "ask"`: the answer merges into the role's Answers (same question replaced, others kept), is fact-checked like any written answer, and shows **Saved from Ask**. A later Fill run keeps Ask answers to questions it does not answer.

## Tools

A headless run pre-approves exactly these (`SKILL_TOOLS` in `packages/engine/runners/grants.ts`; a test keeps this list and that one equal) and denies everything else. If one you need is denied or missing, do not work around it: `runs.finish { run_id, status: "error", summary: { error: "tool denied: <tool>", denied_tools: [...] } }`. {{connector.tools}}

- `{{tool:pp}}`: the pp MCP tools (every Perfect Placement read and write is an op).
- `{{tool:web.fetch}}`: read a plain posting page (a JD or apply link) without the browser.
- `{{tool:browser.tabs}}`: see the open tabs and reuse the session's tab.
- `{{tool:browser.new_tab}}`: open a tab for the portal, only if the session has no usable tab.
- `{{tool:browser.close_tab}}`: close the tabs this run opened or used, at the end (fill assist: all but the portal tab; never the user's tabs).
- `{{tool:browser.navigate}}`: go to the portal and to each tab or step URL.
- `{{tool:browser.text}}`: read a page's text.
- `{{tool:browser.tree}}`: read the accessibility tree (hidden tab panels included).
- `{{tool:browser.find}}`: find the tab and step links, and (assist) the upload and answer fields.
- `{{tool:browser.fill}}`: fill assist only: set an answer field's value (no click, no key press, so no submit).
{{^uploads.off}}- `{{tool:browser.upload}}`: fill assist only: upload the rendered resume and cover letter PDFs.
{{/uploads.off}}
{{fill.tools_note}}

## Rules

- Truth only. Never state a fact Story does not hold; never reword a number to pass the check.
- No em dashes; punchy (hook, reframe, close).
- Money: `$212.5k` / `$300k` or in full `$300,000`; never a `k` after a full number (`300,000k`).
- Standard answers are set once (onboarding, or You > Terms > Application defaults) and reused; never re-ask them per application.
- Never submit an application or send an email, and never act on a Submit, Apply or Send control. The fill assist stops before Submit; the human submits. After the user submits, the inbox skill moves the role to `applied` from the confirmation email.
