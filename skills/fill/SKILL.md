---
name: fill
description: Draft answers to a draft-ready role's real application-portal questions in the user's voice, grounded in the Story component and the tailored package, flag anything that needs the user's personal or legal decision, and save them with the `apply.fill` op. Never submits; the role stays draft-ready.
---

# Fill

Strong, truthful answers to the application's **actual** questions.

## When

After tailor, while the role is `draft-ready`. Open the live portal and read the real questions; never answer hypothetical ones.

## Inputs

- The portal's questions (read in the user's browser).
- `roles.get { role_id }`: application paths (resume, fit map, dossier).
- `profile.get`: Story (facts), Voice (style), Work mode and Terms (standard answers: location, in-office, start date, comp, work authorization).

## Steps

1. `runs.start { skill: "fill", role_id }`.
2. For each question: answer from real evidence (specific metrics and stories, not platitudes), 80 to 150 words, in Voice. Standard fields come from the profile components.
3. Set `needs_human: true` on anything that is the user's call: work authorization, legal attestations, demographic questions, salary expectations, and essays a company wants in the user's own words.
4. `apply.fill { role_id, portal_url, answers: [{ question, answer, needs_human }] }`. The op writes `applications/<role_id>/answers.md` and advances the application to the submit stage.
5. `runs.finish { run_id, status: "ok" }`.

You may pre-fill portal fields in the user's browser. **Stop before the final submit.** Applications end at Open portal.

## Rules

- Truth only. Never inflate beyond Story.
- No em dashes; punchy (hook, reframe, close).
- Never submit an application or send an email. After the user submits, the inbox skill moves the role to `applied` from the confirmation email.
