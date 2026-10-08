/*
 * SYNTHETIC inputs for lane E tests. A made-up person ("Jordan Example"); shaped like the
 * v1 files so the converter and resume parser are exercised. Never real data.
 */

export const SYNTH_RESUME = `# Jordan Example - Master Resume

**Title:** Principal Product Manager, Data Platforms
**Contact:** jordan@example.com • 555.010.0000 • linkedin.com/in/jordan-example

## Profile

Product leader who builds data platforms and ML products. Ten years across startups and a public company.

## Experience

### Acme Data — Principal Product Manager, Analytics — Mar 2022–Present
- **Self-serve analytics:** Launched a self-serve analytics product used by 120 teams.
- **Cost:** Cut warehouse spend 30% with usage-based pricing.
- Mentored four PMs.

### Widget Labs — Senior Product Manager — 2018–2022
- Grew API revenue from 1M to 6M ARR.

### Early roles — Analyst — 2016–2018
- Built the first churn model.

## Skills & Toolkit
- SQL, Python, dbt
- Experimentation

## Education & Continuous Learning
- BS, Example State University
`;

export const SYNTH_PERFECT_ROLE = `# The Perfect Role (Target Definition)

> The target that everything scores against. Seeded from a synthetic interview.

**Status:** v1 (synthetic).
**Last updated:** 2026-01-01

---

## One-line target

> A **growth-stage** company where I own an **external-facing data product** with real ownership.

## What excites me (in my words)

- **Customer-facing work.** Revenue and customers, front and center.
- **Close to the call.** Few layers between me and the decision makers.
- **Data infrastructure.** I want to stay close to the data layer.

## Role shape

- **Primary:** Product Management.
- **Adjacent I'm open to:** data / ML-focused roles, possibly hands-on.
- **Forward Deployed Engineer:** curious, not sold. Explore only.

## Hard constraints

- **Remote.** Not open to hybrid or relocating.

## Likely dealbreakers

- Onsite roles that require relocation.
- Purely internal tooling with no customer line.

## Still open (ask me)

- Comp floor and the no-brainer number.
- Team archetype I thrive under.

## Calibration confirmed (2026-01-01)

- **Facing:** external strongly preferred, still flexible.
- **Stage:** stage-agnostic if greenfield; true pull = **data infra / ML platforms / observability**.
- **Remote:** remote default; no exceptions.
- **Comp:** floor ~$190K base; target $210–230K+; flexible with equity.

## Target space (from the scan)

Sweet spot = **data infra companies**, senior product role, remote. Reference companies from the scan that fit the space: Examplesoft, Datacorp, Pipeworks. (Signal only.)
`;

export const SYNTH_RUBRIC_JSON = JSON.stringify(
  {
    version: 'v1',
    updated: '2026-01-01',
    note: 'Synthetic rubric.',
    weights: { C1: 14, C2: 10, C3: 12, C4: 14, C5: 10, C6: 12, C7: 8, C8: 10, C9: 10 },
    criteria: {
      C1: 'proximity-to-decisions',
      C2: '0->1 scope',
      C3: 'external-facing',
      C4: 'data-fundamentals',
      C5: 'domain-excitement',
      C6: 'comp-and-equity',
      C7: 'team-and-leaders',
      C8: 'growth-ceiling',
      C9: 'role-shape',
    },
    bands: { green_min: 75, yellow_min: 55 },
    decision_rule: 'decision = active if (total >= green_min AND clears dealbreakers) else archived',
    dealbreakers: {
      remote_required_unless_dream_co: true,
      comp_floor: 190000,
      comp_heavy_penalty_below: 170000,
      comp_note: 'Comp is a C6 penalty only.',
    },
    dream_companies: ['Examplesoft'],
  },
  null,
  2,
);

export const SYNTH_RUBRIC_MD = `# Role Scoring Rubric

> How we decide whether a role is worth pursuing (synthetic).

**Version:** v1

---

## How scoring works

Score each criterion 1-5. Weighted sum to 0-100.

| Band | Score | Action |
| --- | --- | --- |
| Pursue | 75-100 | Apply. |
| Pass | < 55 | Archive. |

## Dealbreakers (auto-pass unless noted)

1. **Not remote** and the company is not on the dream list.
2. **Base comp < ~$170K** with no equity.

### Dream-Company Exception list
- Examplesoft (synthetic dream company)
- Bytehaus (added later)
- _add more dream companies here_

## Criteria & weights (sum = 100)

| # | Criterion | Weight | 1 (poor) | 3 (ok) | 5 (ideal) |
| --- | --- | --- | --- | --- | --- |
| 1 | **Proximity to decision-making** | 14 | Many layers | A layer out | Direct line |
| 4 | **Data fundamentals** | 14 | Shallow data | Solid data | Data is the core |

## Change log

- 2026-01-01 - synthetic v1 seeded.
`;

export const SYNTH_POSITIONING = `# Positioning & Narrative

> How I frame myself (synthetic).

## Core positioning (hypothesis)

The product leader who turns raw data into products customers pay for.

## Differentiators (the "only I" list)

- Builder: ships SQL and specs in the same week.
- Pricing instinct: moved two products to usage-based pricing.

## Proof points (map claims -> evidence)

| Claim | Evidence |
| --- | --- |
| Ships revenue products | API revenue 1M to 6M |

## Gaps / things to strengthen

- Public writing.

## Elevator pitches (draft)

- **10-second:** "I turn data platforms into products."
`;

export const SYNTH_DEFAULTS = `# Application Default Answers

> Standard answers (synthetic).

- **Require visa sponsorship:** No.
- **Earliest start:** 2 weeks.
- **Location:** Springfield, Example State. City and state only.
- **Relocation:** Open to discussing.
`;

export const SYNTH_STORIES = `# Story Bank

> Reusable stories (synthetic).

## How we use this

- Before each interview, pick the best-matching stories.

## Story 1 — Self-serve analytics (DRAFT)
**Themes:** 0->1, scale
- **S:** Teams waited weeks for reports.
- **T:** Make analytics self-serve.
- **A:** Shipped a governed self-serve layer.
- **R:** 120 teams onboarded.
- **Confirm:** exact team count.

## Tell me about yourself arc (DRAFT)

Analyst, then PM, then platform lead.

## Evergreen questions to ask the interviewer

- What does success look like in 90 days?
`;

export const SYNTH_V1 = {
  perfect_role: SYNTH_PERFECT_ROLE,
  rubric_json: SYNTH_RUBRIC_JSON,
  rubric_md: SYNTH_RUBRIC_MD,
  positioning: SYNTH_POSITIONING,
  application_defaults: SYNTH_DEFAULTS,
  stories: SYNTH_STORIES,
  resume_master: SYNTH_RESUME,
};
