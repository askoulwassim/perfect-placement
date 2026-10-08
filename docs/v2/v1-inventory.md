# v1 inventory -> v2 mapping

Everything below lives in the v1 repo (this repo, `PerfectPlacement`). Personal data must move to the vault only, never into the system repo.

| v1 path | What | v2 home | Lane |
| --- | --- | --- | --- |
| `CLAUDE.md` | v1 operating manual | replaced by `AGENTS.md` in the system repo; delete in v1 when cut over | W0 |
| `00_System/rubric.json`, `rubric.md` | weights, bands, dealbreakers, dream list | profile components (weighted + filters) + `config.json` scoring | A + E + F |
| `00_System/validate.py` | ledger checker | `pp doctor` (`system.doctor` op) | A |
| `00_System/routines.md` | v1 scheduled task prompts (paused) | new schedules at Wave 2 | W2 |
| `01_Profile/resume_master.md`, `stories.md` | Story | vault `profile/story.md` + component | A + E |
| `01_Profile/perfect_role.md` | target definition | Craft, Domain, Work mode, Company, Team, Growth, Dealbreakers | A + E |
| `01_Profile/positioning.md`, `application_defaults.md` | Voice + standard answers | Voice component + `profile/voice.md` | A + E |
| `02_Pipeline/data/pipeline.json` | 158 roles, statuses, flags | `role`, `company` rows | A |
| `02_Pipeline/data/scores.json` | `{meta, scores[]}` C1..C9, total, band, decision, rubric_version | `score` rows (keep history) | A |
| `02_Pipeline/<status>/*.md` | per-role notes | vault `roles/<id>.md` | A |
| `02_Pipeline/runs/*.md` | audit logs | `run` rows + vault `runs/` | A |
| `03_Applications/<company>/company_dossier.md` | dossiers | vault `companies/<slug>/dossier.md` | A |
| `03_Applications/<company>/<date>_<role>/` | resume, cover, fit map, answers, docx | vault `applications/<role_id>/` | A |
| `04_Interviews/_TEMPLATE_*.md` | templates | system repo `skills/interview/templates/` (generic only) | W3 |
| `05_Skills/role-scout/` (`scout.py`, SKILL.md, templates) | scout | `skills/scout/` + `roles.add` | B + F |
| `05_Skills/role-scorer/` (`scorer.py`) | scoring + filing | `roles.score` + `skills/score/` | B + F |
| `05_Skills/inbox-monitor/` (`monitor.py`) | Gmail classification + moves | `inbox.ingest` + `skills/inbox/` | B |
| `05_Skills/company-researcher/` | dossier | `skills/research/` | B |
| `05_Skills/resume-tailor/` | package | `skills/tailor/` + `apply.tailor` | B |
| `05_Skills/application-filler/` | answers | `skills/fill/` + `apply.fill` | B |
| `.obsidian/` | v1 vault config | not carried; vault is openable in Obsidian | none |
| `WassimAskoul Resume.pdf` | resume | vault `files/` | A |

v1 status folders: `inbox, active, on-deck, draft-ready, applied, interviews, offers, archive`. v2 adds `held` and makes archive reasons explicit (v1 archived = below-threshold + passed + parked; infer reason from flags/score where possible, else `legacy`).

v1 counts at last local snapshot: active 68, applied 3, on-deck 3, draft-ready 0, interviews 0, offers 0, archived 84 (158 total). Migration must reproduce these before any rescore.
