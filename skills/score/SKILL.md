---
name: score
description: Judge C1..C9 and facts for inbox roles (blind for C1, C2, C3, C4, C9), then call roles.score. The engine does totals, bands, dealbreakers, affinity, the per-company cap and status moves.
---

# score

**Owner: lane F.** You supply judgment. `roles.score` supplies mechanics. Never compute a total, band, affinity, cap or status yourself.

## Inputs

- Roles in `inbox` (`roles.list { status: 'inbox' }`) or roles a profile change asks to rescore. A run started for one role (`role_id` given) scores that role only; a run without one scores every inbox role.
- The JD for each role (`roles/<role_id>.md` in the vault; capture the full JD first if only a title is on file).
- The current profile (`profile.get`): Craft, Domain, Team, Growth, Terms, Work mode, Dealbreakers.

## Steps per role

1. **Blind pass (C1, C2, C3, C4, C9).** Replace the company name, product names, domain and URLs with `[company]` before you judge. Score from the masked JD only. If the engine resolver is available, `judgeCriteria()` does the masking and asks the resolver; otherwise mask it yourself and do not look at the company while scoring these five.
2. **Open pass (C5, C6, C7, C8).** Now use the company: domain fit, comp vs Terms, team and leaders, growth ceiling.
3. **Facts.** Extract, never guess: `workplace` (remote | hybrid | onsite | flexible | unspecified), `remote_ok` (true | false | null), `comp_min`, `comp_max`, and `dealbreaker_hits` (hard nos from the Dealbreakers component the JD clearly hits; empty if none). Unknown stays null; the engine flags it to verify.
4. **Call** `roles.score { role_id, criteria: { c1..c9 }, facts, notes }`. Notes hold one line per criterion and go to the role markdown.

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
- Dealbreakers gate first. **No company bypasses a dealbreaker**, dream company or not.
- Per company, the top `config.scoring.company_active_cap` roles stay `active`; the rest go `held` and are promoted automatically when a slot frees.
- Never moves on-deck or later backwards. Records profile version and rubric snapshot on every score.

## Rules

Supply judgment only; every write is an op. Never submit an application or send an email.
