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
- `profile.get`: **Story** is the only source of facts and metrics; **Voice** is the style.
- The company dossier (`company.md_path`) if research ran.

## Steps

1. `runs.start { skill: "tailor", role_id }`.
2. Parse the JD: mandate, top 6 to 10 requirements, must-have keywords, seniority.
3. Fit map: each requirement -> the strongest real evidence from Story; mark gaps honestly.
4. Resume: adjust headline and summary to the role, reorder and emphasize bullets, weave keywords in truthfully, keep every metric exactly as in Story. About two pages.
5. Cover letter in Voice: hook, two or three proof points, confident close.
6. `apply.tailor { role_id, resume_md, cover_letter_md, fit_map_md }`. The op writes `applications/<role_id>/{resume,cover_letter,fit_map}.md`, upserts the application and moves the role to `draft-ready` (a freed company slot promotes a held role automatically).
7. `runs.finish { run_id, status: "ok" }`. Next: the fill skill for the real portal questions.

## Rules

- Truth only: reframe and emphasize, never invent. Gaps go in the fit map, not the resume.
- Writing in the user's voice: no em dashes; punchy (hook, reframe, close).
- Every write is an op. Never submit an application or send an email. The user reviews and submits; `apply.mark_submitted` is human only.
