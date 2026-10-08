# packages/engine/profile

**Owner: lane E** (`docs/v2/lanes/E-profile-onboarding.md`). Only lane E writes here.

11 component schemas, versions + diffs, onboarding (interview + calibration), learn loop, v1 profile converter.

| File | What |
| --- | --- |
| `components.ts` | zod data schema per component (loose: unknown fields kept), criterion ownership, rubric weights, impact tiers |
| `store.ts` | profile repository over better-sqlite3 (**Wave 2 shim**: lane A repositories) |
| `profile-ops.ts` | `profile.get`, `profile.history`, `profile.propose_diff`, `profile.apply_diff`, `profile.reject_diff`, `undoDiff` |
| `questions.ts` | onboarding question bank with skip logic |
| `resume.ts` | heuristic resume -> Story + Craft drafts (fallback when no LLM is injected) |
| `calibration.ts` | 12-sample calibration -> criterion weights |
| `onboard.ts`, `onboard-store.ts` | `onboard.*` ops; session store (**Wave 2 shim**: JSON file, no table yet) |
| `learn.ts` | learn loop: event -> resolver -> LLM diff -> policy |
| `convert-v1.ts`, `convert-v1-cli.ts` | v1 profile converter + coverage check + report |
| `handlers.ts` | op handlers keyed by op name, for lane B's `runOp` |
| `deps.ts` | injected interfaces (db, emit, ask, llm, store) + id/event shims |
| `testing.ts` | **Wave 2 shims / test helpers**: temp db, fake resolver, decision action attacher |
| `synthetic.ts` | synthetic v1-shaped inputs and resume for tests (a made-up person) |

## Component data

`profile_component.data_json` is validated per key by `COMPONENT_DATA_SCHEMAS`. Every component may also carry
`criterion_weights`, `criteria` (rubric anchors), `notes`, `open_questions`, `v1_sections` (verbatim v1 text).

**Criterion ownership** (each C1..C9 weight lives on exactly one component):

| Criterion | Owner |
| --- | --- |
| c1 Decisions, c7 Team | team |
| c2 0-to-1 | company |
| c3 External, c9 Shape | craft |
| c4 Data, c5 Domain | domain |
| c6 Comp | terms (filter: weight column stays null) |
| c8 Growth | growth |

`weight` column of a weighted component = sum of its owned criterion weights / 100. `rubricWeights(components)`
returns the 9 weights (integers summing to 100) that lane F scores with.

## Diffs and impact

`diff_json = { before, after }` over top-level keys of the component data. Apply sets `after` keys and removes keys only in
`before`. A diff applies if its base version is still current, else only if the touched keys still equal `before`.

| Kind | Components | Impact | Routing for an agent |
| --- | --- | --- | --- |
| filter | work_mode, terms, dealbreakers | high | always human. Hard guard in code, whatever the resolver says |
| weighted | craft, domain, company, team, growth | medium | auto + 24h undo if p >= 0.90, else human |
| asset | story, voice, network | low | auto if p >= 0.90, auto if 0.70 to 0.90 and a second backend agrees, else human |

A human actor, or a decision a human resolved (`ctx.decisionId` with `human_choice`/`resolved_at`), applies directly.
Applying a weighted or filter diff returns the unapplied roles to rescore (`active`, `held`, `on-deck`); asset diffs return none.

## Onboarding

1. `onboard.ingest_resume` parses Story + Craft (LLM if injected, else heuristic). Draft is seeded from the current profile.
2. `onboard.answer` walks `QUESTION_BANK` in component order. A question is skipped when the draft already answers it
   (resume, profile, earlier answer). Follow-ups are conditional (`when`). `startComponentInterview([key])` re-asks one
   component and goes straight to confirm.
3. `onboard.calibrate` records yes / no / maybe on 12 samples (default: scored roles, round-robin across bands).
4. `onboard.confirm` writes a new version with all 11 components. When a profile exists and the actor is not human,
   changed filters are not written; they become pending high-impact diffs.

Confidence: 0.2 empty, kept from profile, 0.7 from resume, 0.8 answered, +0.1 for calibrated weighted components.

### Calibration method

```
y_j   = 1 yes, 0.5 maybe, 0 no                      for each judged sample j
r_i   = Pearson(level_i, y) over judged samples      0 when either has no variance
s     = n / (n + 4)                                  evidence strength (n = 12 -> 0.75)
w_i   = prior_i * exp(2 * s * r_i), clamped to [2, 35]
w     = renormalized to integers summing to 100 (largest remainder)
```

The prior is the stated preference: current profile weights (or neutral), nudged by interview answers (external facing
c3 x1.25, decision proximity c1 x1.2, ranked domains c5 x1.1, upward trajectory c8 x1.1, high equity c6 x1.1).
Choices win: with 12 judged samples a perfectly predictive criterion is multiplied by 4.5, an anti-predictive one by 0.22.

## Learn loop

`learnFromEvent(deps, eventId, ctx)`: ignores non-`LEARNING_EVENTS`; asks 11 Noulli questions (`profile.learn`, low);
for each confident yes the LLM drafts `{ before, after, evidence }` (`before` is always recomputed from the data);
`profile.propose_diff`; then `routeDiff` asks `profile.apply_diff` with the component's impact and applies, rejects
(confident no) or queues. Every queued decision gets `action_json = { op: 'profile.apply_diff', input: { diff_id } }`.

## v1 converter

`convertV1Profile(inputs)` maps `01_Profile/{perfect_role,positioning,application_defaults,stories,resume_master}.md` and
`00_System/rubric.{json,md}` into the 11 components plus `config.scoring` bands, a version reason and provenance.
Every markdown section is kept verbatim in its routed component's `v1_sections`; structured fields are extracted on top.
`verifyCoverage` proves nothing was dropped (every non-empty line found in the output; every rubric.json leaf mapped).
Dry run: `node packages/engine/dist/profile/convert-v1-cli.js <v1-root> <out-dir-outside-any-repo>`.
