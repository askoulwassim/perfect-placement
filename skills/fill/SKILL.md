---
name: fill
description: Classify a draft-ready role's real application-portal questions (portal fills, standard, written), draft only the written answers in the user's voice from Story, the JD and dossier, and save them with the `apply.fill` op, which fills standard answers from the saved Application defaults, fact-checks the written ones and flags only what needs the user, each with a reason. Never submits; the role stays draft-ready.
---

# Fill

Strong, truthful answers to the application's **actual** questions, and nothing the user has to wade through.

## When

After tailor, while the role is `draft-ready`. Open the live portal and read the real questions; never answer hypothetical ones.

## Inputs

- The portal's questions (read in the user's browser).
- `roles.get { role_id }`: the role (JD in its file) and the application paths (resume, cover letter, fit map, dossier).
- `profile.get`: Story (the only source of facts), Voice (style). Standard answers are the code's job (below); do not copy them yourself.

## Steps

1. `runs.start { skill: "fill", role_id }`.
2. Classify every question (your judgment):
   - `autofill`: identity and upload fields. `field`: `name`, `email`, `phone`, `linkedin`, `github`, `website`, `resume`, `cover_letter`, else `other`. No answer needed; the op lists them once as **Portal fills** with the profile values.
   - `standard`: the questions every portal asks. `field`: `sponsorship`, `work_authorization` (set `country`), `relocation` (set `country` when it names one), `start_date`, `notice_period`, `comp_expectation`, `in_office`, `location`, `eeo` (any demographic question), else `other`. Leave `answer` empty: the op answers from the saved **Application defaults** (Terms), Work mode and Terms. With nothing saved it flags the question with the reason ("no saved work authorization for Canada"); you may put a suggestion in `answer`.
   - `written`: real questions ("Why us?", "Have you maintained an open source project?"). Draft from Story + CONTEXT (JD, dossier) in Voice: specific stories and metrics, 80 to 150 words, hook, reframe, close. Set `confidence` (0 to 1) for how well Story supports it.
3. Flag (`needs_human: true` + a one-line `reason`) **only** a legal or personal question that no saved default covers (criminal record, non-compete, a former-employee question) or something only the user can say. Do not flag standard questions, identity fields or grounded drafts: the op flags what it cannot answer, every unsupported fact (each also becomes a keep / remove / edit decision in Needs you) and any answer below the policy's confidence threshold.
4. `apply.fill { role_id, portal_url, answers: [{ question, kind, field?, country?, answer?, confidence?, needs_human?, reason? }] }`. The op writes `applications/<role_id>/answers.md` grouped **Needs you / Written / Standard / Portal fills** and advances the application to the submit stage. Report `counts` and every needs-you `reason`.
5. `runs.finish { run_id, status: "ok" }`.

You may pre-fill portal fields in the user's browser. **Stop before the final submit.** Applications end at Open portal.

## Tools

A headless run pre-approves exactly these (`SKILL_TOOLS` in `packages/engine/ops/runner.ts`; a test keeps this list and that one equal) and denies everything else. If one you need is denied or missing, do not work around it: `runs.finish { run_id, status: "error", summary: { error: "tool denied: <tool>", denied_tools: [...] } }`.

- `mcp__pp`: the pp MCP tools (every Perfect Placement read and write is an op).
- `WebFetch`: read the real portal questions (a headless run has no browser).

## Rules

- Truth only. Never state a fact Story does not hold; never reword a number to pass the check.
- No em dashes; punchy (hook, reframe, close).
- Standard answers are set once (onboarding, or You > Terms > Application defaults) and reused; never re-ask them per application.
- Never submit an application or send an email. After the user submits, the inbox skill moves the role to `applied` from the confirmation email.
