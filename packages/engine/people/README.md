# packages/engine/people

**Owner: lane H** (`docs/v2/lanes/`). Only lane H writes here.

Contacts, contact_link, tier classification via resolver, outreach drafts (Hook / Proof / Ask).

## Files

| File | What |
| --- | --- |
| `index.ts` | Public surface + `handlers` map (op name -> handler) for lane B's `runOp`. |
| `find.ts` | `people.find`: picked roles only; LinkedIn (capped) + Gmail contacts + skill hints; upsert contacts, provisional links, `contact_found`, run row (carries the daily LinkedIn budget). |
| `classify.ts` | `people.classify` (resolver Choice, kind `people.classify`, low impact) and `people.link` (tier must equal degree x hiring team). |
| `outreach.ts` | `outreach.draft` (vault md + row + `outreach_drafted`), `outreach.to_gmail` (Gmail draft only, idempotent), `outreach.send` (always `unimplemented`), `composeAndDraft` writer pipeline. |
| `templates.ts` | Per-tier Hook / Proof / Ask templates, LLM writer prompt (Story + Voice only), deterministic fallback. |
| `style.ts` | Mechanical writing checks: no em/en dashes, length limits, Proof numbers must appear in Story. |
| `tier.ts` | `tierFor(degree, hiringTeam)`. |
| `repo.ts`, `ids.ts` | WAVE2-SHIM row access, event/run writes and ULIDs until lanes A/B land. |
| `testkit.ts` | WAVE2-SHIM temp vault + db (migration 001 + fixture seed) and a fake resolver. Tests only. |

## Handler contract

`handler(input, ctx: OpContext, deps: PeopleDeps) -> OpOutcome<OpOutput<name>>`. `PeopleDeps` = `{ db, vaultDir, ask, config, linkedin?, gmail?, gmailContacts?, writer?, newId? }`. Handlers honor `ctx.dryRun` (and `people.find`'s `dry_run`): no db, vault, Gmail or budget writes.

## Wave 2

- Lane B: register `handlers` in `runOp`, build `PeopleDeps` per vault; move event/run writes out of `repo.ts` into `runOp` (handlers already return `eventIds`).
- Lane A: replace `repo.ts` row helpers and `ids.ts` with the shared repository layer.
- Lane I: real `ask`. In `people.classify`, `auto_second` / `auto_undo` / `auto` apply the tier; `human` leaves the provisional tier and the decision waits in Needs you. When a human resolves it, re-run `people.classify` or `people.link` (see CONTRACT_CHANGES request).
- Lane E: `profile.get` for Story/Voice instead of the direct `profile_component` read.
- Live run with Wassim: `skills/connect/RUNBOOK.md`.
