# packages/engine/people

**Owner: lane H** (`docs/v2/lanes/`). Only lane H writes here.

Contacts, contact_link, tier classification via resolver, outreach drafts (Hook / Proof / Ask).

## Files

| File | What |
| --- | --- |
| `index.ts` | Public surface + `handlers` map (op name -> handler); the engine registers them in `ops/lanes/people.ts`. |
| `find.ts` | `people.find`: picked roles only; LinkedIn (capped) + Gmail contacts + skill hints; upsert contacts, provisional links, `contact_found`, run row (carries the daily LinkedIn budget). |
| `classify.ts` | `people.classify` (resolver Choice, kind `people.classify`, low impact; `role` input = a human's pick via the decision action `role: "$value"`) and `people.link` (tier must equal degree x hiring team). |
| `outreach.ts` | `outreach.draft` (vault md + row + `outreach_drafted`), `outreach.to_gmail` (Gmail draft only, idempotent), `outreach.send` (always `unimplemented`), `composeAndDraft` writer pipeline. |
| `templates.ts` | Per-tier Hook / Proof / Ask templates, LLM writer prompt (Story + Voice only), deterministic fallback. |
| `style.ts` | Mechanical writing checks: no em/en dashes, length limits, Proof numbers must appear in Story. |
| `tier.ts` | `tierFor(degree, hiringTeam)`. |
| `queries.ts` | Row access over lane A repositories, runOp's emitter and staged vault. |

## Handler contract

`handler(input, ctx: OpContext, deps: PeopleDeps) -> OpOutcome<OpOutput<name>>`. `PeopleDeps` is built per op call by the engine: `{ repos, vault, emit, ask, record, config, linkedin?, gmail?, gmailContacts?, writer? }` (adapters from `EngineServices`). Handlers honor `ctx.dryRun` (and `people.find`'s `dry_run`). `outreach.to_gmail` is medium impact: an agent goes through the grid with `ctx.confidence`. `outreach.send` has no handler (unimplemented by contract).

Production adapters: the engine has no LinkedIn driver or Gmail client by default (decisions #4, #5 put both in the agent session: Claude in Chrome and the Gmail connector). Without them `people.find` uses the skill's hints and Gmail contacts only, and `outreach.to_gmail` answers `backend_unavailable`. Live run with Wassim: `skills/connect/RUNBOOK.md`.
