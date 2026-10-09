# packages/engine/people

**Owner: lane H** (`docs/v2/lanes/`). Only lane H writes here.

Contacts, contact_link, tier classification via resolver, outreach drafts (Hook / Proof / Ask + sign-off, sent to Gmail as a natural email).

## Files

| File | What |
| --- | --- |
| `index.ts` | Public surface + `handlers` map (op name -> handler); the engine registers them in `ops/lanes/people.ts`. |
| `find.ts` | `people.find`: picked roles only; the agent's LinkedIn read (hints with `source: 'linkedin'`, #82: `/in/<slug>` URLs only, daily budget, mutual cap, page-cap flag, config `live` only) + the recorded adapter in tests + Gmail contacts + other skill hints; upsert contacts, provisional links (a hiring-team signal sets `is_hiring_team`), `contact_found`, run row with honest provenance (`linkedin_mode: agent | dry-run | off`, `linkedin_people`, `linkedin_reason`, budget). |
| `email.ts` | `people.find_email` (#37): known address first (hints from Gmail, LinkedIn, public pages; JD; dossier), else the company's learned address format, MX check (injected `mx`, never SMTP), ranked candidates; the top pick is a `people.email` decision; `draftRecipient` decides a Gmail draft's To. `dns.ts`: the default MX lookup. |
| `classify.ts` | `people.classify` (resolver Choice, kind `people.classify`, low impact; `role` input = a human's pick via the decision action `role: "$value"`) and `people.link` (tier must equal degree x hiring team). |
| `outreach.ts` | `outreach.draft` (vault md + row + `outreach_drafted`), `outreach.to_gmail` (Gmail draft only, idempotent), `outreach.send` (always `unimplemented`), `composeAndDraft` writer pipeline. |
| `templates.ts` | Per-tier templates; LLM writer prompt with CONTEXT (contact headline, role JD, dossier highlights; facts about them) apart from STORY (the only facts about the user) and VOICE (style, notes, every writing sample as a tone exemplar); deterministic natural-shape fallback. |
| `style.ts` | Mechanical writing checks: no em/en dashes, length limits, Proof at most 3 sentences, Proof numbers in Story, Hook numbers in Story or CONTEXT, no stock flattery; `composeBody` (greeting, Hook, Proof, Ask, sign-off). |
| `tier.ts` | `tierFor(degree, hiringTeam)`. |
| `queries.ts` | Row access over lane A repositories, runOp's emitter and staged vault. |

## Handler contract

`handler(input, ctx: OpContext, deps: PeopleDeps) -> OpOutcome<OpOutput<name>>`. `PeopleDeps` is built per op call by the engine: `{ repos, vault, emit, ask, record, config, linkedin?, gmail?, gmailContacts?, writer?, mx?, emailProvider? }` (adapters from `EngineServices`). Handlers honor `ctx.dryRun` (and `people.find`'s `dry_run`). `outreach.to_gmail` is medium impact: an agent goes through the grid with `ctx.confidence`. `outreach.send` has no handler (unimplemented by contract).

Production adapters: the engine has no LinkedIn driver or Gmail client (decisions #4, #5 put both in the agent session: Claude in Chrome and the Gmail connector). The `connect` run reads LinkedIn with Chrome's read and navigate tools and passes people as `source: 'linkedin'` hints (#82); `linkedin_mode` is `agent` only then. `outreach.to_gmail` records a draft the calling agent already created with its own Gmail tool (`gmail_draft_id`, Gmail via agent); without that id and with no client it answers `backend_unavailable`. Live run with Wassim: `skills/connect/RUNBOOK.md`.
