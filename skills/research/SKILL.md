---
name: research
description: Build or refresh a company dossier for a picked role (mission, products, stage, funding, leadership, news, culture, risks, remote and comp reality, authentic hooks, interview themes) and save it with the `companies.dossier.write` op. Reuses an existing dossier unless a refresh is asked for or an interview is near. Starting it picks an active or held role (on-deck).
---

# Research

A crisp, current, sourced dossier that feeds tailoring, outreach and interview prep. One dossier per company, shared by all of its roles.

## When

On pick (starting Research, Tailor or Connect moves an active or held role to on-deck, "In progress", #105), before tailoring, or before an interview (refresh time-sensitive facts only).

## Skip check (first)

`roles.get { role_id }` returns the company. If `company.md_path` is set, a dossier exists: **reuse it**. Only write when there is none, the user asks for a refresh, or an interview is scheduled (then refresh funding, news, leadership).

## Steps

1. `runs.start { skill: "research", role_id }`.
2. Research (web search and fetch; cite and date every time-sensitive fact):
   1. Basics: what they do, products, founding, HQ, size.
   2. Current: latest funding and investors, news from the last 6 to 12 months, leadership and the hiring team, trajectory.
   3. Stage and a legitimacy verdict for unknown companies: go, caution or avoid.
   4. Remote and comp reality against the Work mode and Terms components.
   5. Culture and how they interview.
   6. Authentic fit hooks mapped to the Story component (for the cover letter and outreach).
   7. Interview themes and 3 to 5 sharp questions to ask.
3. `companies.dossier.write { company_id, markdown, role_id }`. The op writes `companies/<slug>/dossier.md`, sets the company's `md_path` and links the dossier into every open application at that company.
4. `runs.finish { run_id, status: "ok" }`.

## Tools

A headless run pre-approves exactly these (`SKILL_GRANTS` in `packages/engine/runners/grants.ts`; a test keeps this list and that one equal) and denies everything else. If one you need is denied or missing, do not work around it: `runs.finish { run_id, status: "error", summary: { error: "tool denied: <tool>", denied_tools: [...] } }`.

- `{{tool:pp}}`: the pp MCP tools (every Perfect Placement read and write is an op).
- `{{tool:web.search}}`: find sources for the dossier.
- `{{tool:web.fetch}}`: read each source.

## Rules

- Never fabricate funding, news or people. Flag anything stale or unverifiable.
- The dossier never changes a role's status beyond the pick: `runs.start` (or `companies.dossier.write` with `role_id`) moves an active or held role to on-deck; later statuses are never touched.
- Every write is an op. Never submit an application or send an email.
