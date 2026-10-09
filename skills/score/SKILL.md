---
name: score
description: Score inbox roles. Call roles.score without criteria so Kev judges C1..C9 (blind for C1, C2, C3, C4, C9); judge them yourself only when Kev is unavailable. The engine does totals, bands, dealbreakers, affinity, the per-company cap and status moves.
---

# score

**Owner: lane F.** You supply judgment. `roles.score` supplies mechanics. Never compute a total, band, affinity, cap or status yourself.

## Inputs

- Roles in `inbox` (`roles.list { status: 'inbox' }`) or roles a profile change asks to rescore. A run started for one role (`role_id` given) scores that role only; a run without one scores every inbox role.
- The JD for each role (`roles/<role_id>.md` in the vault; capture the full JD first if only a title is on file).
- The current profile (`profile.get`): Craft, Domain, Team, Growth, Terms, Work mode, Dealbreakers.

## Steps per role

1. **Facts.** Extract, never guess: `workplace` (remote | hybrid | onsite | flexible | unspecified), `remote_ok` (true | false | null), `location` (where the role sits, as the JD says it, e.g. "New York, NY"), `comp_min`, `comp_max`, and `dealbreaker_hits` (hard nos from the Dealbreakers component the JD clearly hits; empty if none). Do not put work mode in `dealbreaker_hits`: the engine applies Work mode itself (accepted places, mode hard nos, remote only only when the profile sets `remote_only`). Unknown stays null; the engine flags it to verify.
2. **Let Kev judge (preferred).** Call `roles.score { role_id, facts, brand_terms?, notes? }` **without `criteria`**. The engine asks the decision layer: one Kev call with the masked JD for C1, C2, C3, C4, C9 (company, products, domain and URLs replaced by `[company]`; add product names or founders in `brand_terms`) and one with the full state for C5..C8. Every criterion becomes a decision row (backend, p, latency) linked from the score.
3. **Kev unavailable.** If the call answers `backend_unavailable` ("Kev did not answer"), judge C1..C9 yourself:
   - Blind pass (C1, C2, C3, C4, C9): mask the company name, products, domain and URLs as `[company]` and score from the masked JD only.
   - Open pass (C5, C6, C7, C8): now use the company: domain fit, comp vs Terms, team and leaders, growth ceiling.
   - Call `roles.score { role_id, criteria: { c1..c9 }, criteria_p?: { c1: 0.8, ... }, facts, notes }`. Each criterion is recorded as an `agent` decision (p from `criteria_p`, else your call's `confidence`, else 0.75). When Kev answers it gives a second opinion; gaps over one point are flagged on the score (`facts_json.disagreements`) and the Role screen.
4. **No agent and no Kev** (a human calling the op): the nine questions go to Needs you and the op answers `requires_human`. Once they are resolved, `roles.score` again uses the human answers.
5. **Notes** hold one line per criterion and go to the role markdown.

## Criteria (1 to 5)

| Id | Label | Blind | 1 | 5 |
| --- | --- | --- | --- | --- |
| c1 | Decisions | yes | far from strategy | at the table |
| c2 | 0-to-1 | yes | maintenance | greenfield |
| c3 | External | yes | internal only | customer or market facing |
| c4 | Data | yes | incidental | data or AI is the product |
| c5 | Domain | no | poor fit | ideal problem space |
| c6 | Comp | no | well below floor | at or above target |
| c7 | Team | no | weak | exceptional |
| c8 | Growth | no | capped | open |
| c9 | Shape | yes | wrong function or level | exact |

## What the engine does (do not repeat it)

- Weights from the profile version; total, band (green 75, yellow 55).
- Company affinity nudge, capped at `config.scoring.affinity_cap`. A company you love does not raise C1..C9.
- Dealbreakers gate first. **No company bypasses a dealbreaker**, dream company or not. Work mode: hybrid in an accepted place passes; hybrid elsewhere is a verify flag unless the profile says fail; a mode hard no fails; unknown mode is a verify flag.
- After a Work mode change, `roles.reevaluate_filters { dry_run: true }` lists work-mode archives that now pass; without `dry_run` it queues a Needs-you restore per role. Never restore a role yourself.
- Per company, the top `config.scoring.company_active_cap` roles stay `active`; the rest go `held` and are promoted automatically when a slot frees.
- Never moves on-deck or later backwards. Records profile version and rubric snapshot on every score.
- Records who judged each criterion in `facts_json.criteria_source` (`kev`, `agent` or `human`, with p and the decision id) and, for agent criteria, `second_opinion` (`kev` or `unavailable`) and `disagreements`.

## Rules

Supply judgment only; every write is an op. Never submit an application or send an email.
