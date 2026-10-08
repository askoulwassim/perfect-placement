---
name: onboard
description: Build or refresh the user's profile. Resume in, short adaptive interview by component, 12-role calibration, confirm. Use for first run, or to re-interview one component (for example Terms or Growth) without redoing the rest.
---

# onboard

**Owner: lane E.** Supplies judgment only; every write is an op. Never submit an application or send an email.

## Steps

1. **Resume in.** Call `onboard.ingest_resume` with `{ file_path }` (vault-relative, e.g. `files/resume.md`) or `{ text }`.
   If the user gives a PDF, extract its text first; do not paraphrase or add facts. The op returns the onboarding state.
2. **Interview.** While `state.next_question` is not null, show it as given (label, chips, slider) and call
   `onboard.answer` with `{ question_id, value }`:
   - `chips`: one option string. `multi_chips`: array of option strings (order = rank). `slider`: a number in `[min, max]`.
     `text`: a short string.
   - Never ask a question the op did not return. The op already skips what the resume or profile answers.
   - Do not invent answers. If the user skips, stop and leave the session; it resumes later.
3. **Calibrate** (`state.step == 'calibrate'`). Show each of the 12 sample roles (title, company, key facts) and record
   the user's gut call with `onboard.calibrate` `{ sample_id, choice: 'yes' | 'no' | 'maybe' }`. Show the returned
   weights only as a radar or bars, no commentary. `remaining` reaches 0 -> step `confirm`.
4. **Confirm.** Show the profile card (from `profile.get` after confirm, or the draft). On the user's OK call
   `onboard.confirm` `{}`. That writes profile v1 (or v+1).

## Re-interview one component

Ask the engine to start a scoped session for that component (`startComponentInterview`, exposed as an op in Wave 2),
then loop step 2 and confirm. Calibration is skipped.

## Rules

- The user is the only source of preferences. If you run this as an agent (not on the user's behalf in a live session),
  any change to Work mode, Terms or Dealbreakers becomes a pending diff for the user, never a direct write.
- UI copy: labels of one to three words, no tips, one primary action per screen.
- Writing in the user's voice: no em dashes.
