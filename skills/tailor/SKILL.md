---
name: tailor
description: Tailor the resume, write a matching cover letter and a fit map for one role from the full JD and the user's Story and Voice components, then save the package with the `apply.tailor` op, which moves the role to draft-ready. Truth only, no em dashes. Never submits.
---

# Tailor

A role-specific resume and cover letter that map the user's real evidence to the JD, truthfully.

## When

A role is `active` or `on-deck` (or `draft-ready`, to re-tailor) and you have the **full JD**. If `roles.get` shows only a title or header, open the posting and capture the full JD first. If the posting is closed, stop: freshness (`roles.check_freshness`) archives dead postings, not this skill.

## Inputs

- `roles.get { role_id }`: role, company, `md_body` (the JD), application.
- `profile.get`: **Story** and the kept source resume (`story.source_path`, read it with `vault.read`; the kept resume is a vault file) are the only sources of facts and metrics; **Voice** is the style.
- The company dossier (`company.md_path`) if research ran.

## Steps

1. `runs.start { skill: "tailor", role_id }`.
2. Parse the JD: mandate, top 6 to 10 requirements, must-have keywords, seniority.
3. Fit map: each requirement -> the strongest real evidence, **citing the source line** it comes from (the resume line or Story entry, quoted); mark gaps honestly.
4. Resume: adjust the summary to the role, reorder and emphasize bullets, weave keywords in truthfully. Every number, year, date, title, employer and degree must appear in the source resume or Story exactly as written: no totals, no rounding, no "N years" unless the source says it. Role headings stay `Company - Title - Dates` as in the source. About two pages.
5. Cover letter in Voice: hook, two or three proof points, confident close.
6. `apply.tailor { role_id, resume_md, cover_letter_md, fit_map_md }`. The op fact-checks the resume and cover letter against the sources: an unsupported number, year, date, degree or role heading is rejected (`invalid_input` lists each claim; fix it from the source, never by rewording the number), and an unsupported title or employer in prose comes back in `fact_check.needs_you` and is queued for the user in Needs you as an `apply.fact_check` decision (keep, remove or edit the line; a re-tailor replaces the pending ones). It appends the claim -> source line table to the fit map. The op writes `applications/<role_id>/{resume,cover_letter,fit_map}.md`, upserts the application and moves the role to `draft-ready` (a freed company slot promotes a held role automatically).
7. `runs.finish { run_id, status: "ok" }`. Next: the fill skill for the real portal questions.

## Tools

A headless run pre-approves exactly these (`SKILL_TOOLS` in `packages/engine/ops/runner.ts`; a test keeps this list and that one equal) and denies everything else. If one you need is denied or missing, do not work around it: `runs.finish { run_id, status: "error", summary: { error: "tool denied: <tool>", denied_tools: [...] } }`.

- `mcp__pp`: the pp MCP tools (every Perfect Placement read and write is an op).
- `WebFetch`: capture the full JD from the posting when only a title is on file.

## Rules

- Truth only: reframe and emphasize, never invent. Gaps go in the fit map, not the resume.
- Years of experience only if the source states it. Never compute it from dates.
- Writing in the user's voice: no em dashes; punchy (hook, reframe, close).
- Every write is an op. Never submit an application or send an email. The user reviews and submits; `apply.mark_submitted` is human only.
