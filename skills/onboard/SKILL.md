---
name: onboard
description: Build or refresh the user's profile. Resume in, short adaptive interview by component, 12-role calibration, confirm. Use for first run, or to re-interview one component (for example Terms or Growth) without redoing the rest.
---

# onboard

Supplies judgment only; every write is an op. Never submit an application or send an email.

## Steps

1. **Resume in.** Call `onboard.ingest_resume` with `{ file: { name, content_base64 } }` (PDF, DOCX, MD, TXT),
   `{ file_path }` (vault-relative, e.g. `files/resume.pdf`) or `{ text }` (verbatim; never paraphrase or add facts).
   The op keeps the resume in `files/` (original + extracted text, linked from Story as `source_path`), shows an
   instant preview and returns the onboarding state. When a person uploads it, the op also queues a headless
   `onboard` run that extracts the facts verbatim (`extract.md`); in a live session you may do that extraction
   yourself with `onboard.extract`.
2. **Interview.** First show what was pulled from the resume per component (`state.resume_drafts`: component,
   confidence, items). While `state.next_question` is not null, show it as given (the full-sentence label, its
   `example` if any, which component it fills, chips or slider; pre-fill `suggested`) and call `onboard.answer`
   with `{ question_id, value }`, or `{ question_id, skip: true }` when the user says "I don't know":
   - `kind: 'confirm'`: the resume implies the answer with high confidence ("Looks like ... Right?"). `yes` keeps
     it; `edit` asks that component's questions with the resume's draft pre-filled.
   - `kind: 'follow_up'`: a question the onboard agent proposed from the resume; the answer is kept in the
     component's `follow_ups`.
   - `chips`: one option string. `multi_chips`: array of option strings (order = rank). `slider`: a number in `[min, max]`.
     `text`: a short string.
   - `other: true` (persona-dependent questions: Craft functions, level and titles, Domain, Growth scope): the options
     come from the resume's persona (a salesperson sees sales functions and titles), and a free entry (Other, at most
     60 characters) is accepted besides them. Never steer a user back to product options.
   - Voice: the user may skip the whole step (`{ question_id, skip: true, skip_component: true }`); drafts then use
     the neutral default style. Voice can be learned later from their own writing (You > Voice > Learn voice).
   - Never ask a question the op did not return. The op already skips what the resume or profile answers.
   - Free text the user dictated: pass it as `value`; the op strips fillers ("um", "you know") and keeps the raw
     text for provenance. Show the user the cleaned text; if they edit it, pass the edit as `value` and the
     original as `raw`.
   - `story.years` asks the user to confirm a number derived from the role dates (or leave it out). Never guess years.
   - Do not invent answers. If the user skips, stop and leave the session; it resumes later.
3. **Calibrate** (`state.step == 'calibrate'`). Show each of the 12 sample roles (title, company, key facts) and record
   the user's gut call with `onboard.calibrate` `{ sample_id, choice: 'yes' | 'no' | 'maybe' }`. Show the returned
   weights only as a radar or bars, no commentary. `remaining` reaches 0 -> step `confirm`.
4. **Confirm.** Show the profile card (from `profile.get` after confirm, or the draft). On the user's OK call
   `onboard.confirm` `{}`. That writes the first profile version (or the next one).

## Re-interview one component

Ask the engine to start a scoped session for that component (`startComponentInterview`, exposed as an op in Wave 2),
then loop step 2 and confirm. Calibration is skipped.

## Headless run (no user present)

Do only the resume extraction in `extract.md`: read the kept resume, `onboard.extract` (facts plus per-component
drafts with a confidence), optionally `onboard.propose_questions` (follow-ups where the resume is silent or
ambiguous), `runs.finish`. Do not answer interview questions, calibrate or confirm: those are the user's.

## Tools

A headless run pre-approves exactly these (`SKILL_TOOLS` in `packages/engine/ops/runner.ts`; a test keeps this list and that one equal) and denies everything else. If one you need is denied or missing, do not work around it: `runs.finish { run_id, status: "error", summary: { error: "tool denied: <tool>", denied_tools: [...] } }`.

- `mcp__pp`: the pp MCP tools (every Perfect Placement read and write is an op).

## Rules

- The user is the only source of preferences. If you run this as an agent (not on the user's behalf in a live session),
  any change to Work mode, Terms or Dealbreakers becomes a pending diff for the user, never a direct write.
- UI copy: buttons and labels of one to three words, no tips, one primary action per screen. Interview questions
  are full, plain sentences with an optional one-line example (wave1-decisions #28).
- Writing in the user's voice: no em dashes.
- Facts come from the resume or the user, verbatim. Never infer a number.
