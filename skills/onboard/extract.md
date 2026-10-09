# Resume extraction (headless onboard run)

The user uploaded a resume. The app kept it in the vault and showed an instant preview. Your job: extract the facts **verbatim** so the user can confirm them. Code checks every value against the resume text and rejects anything that is not in it.

## Steps

1. `onboard.state {}` -> `resume.source_path` (the kept resume text). No `resume`: finish with `runs.finish { status: "error", summary: { error: "no kept resume" } }`.
2. Read the kept resume with `vault.read { path: <resume.source_path> }` (the kept resume is a vault file).
3. Extract into a Story object, copying text exactly as written (same words, numbers, dates, capitalization):
   - `headline`: the title line under the name, if any.
   - `summary`: the profile or summary paragraph, if any.
   - `roles`: one per job, newest first: `{ company, title, dates, summary?, bullets: [...] }`. `company`, `title` and `dates` exactly as written ("Mar 2022 - Present"). Every bullet verbatim.
   - `wins`: up to 8 bullets that carry a metric, verbatim.
   - `skills`, `education`, `recognition`: lists, verbatim.
   - `years`: only if the resume states it ("12 years of experience") with `years_basis: "stated"`, or the span of the role dates with `years_basis: "from dates"` (the app asks the user to confirm it). Otherwise leave both out. Never estimate.
   - Optional `craft`: `functions` (PM, TPM, FDE, Data Science, Engineering), `level` (senior, staff, principal, group, head, director, vp), `mode` (ic, lead, either) when the titles make them plain.
   - Optional `drafts` (judgment, not facts; the user confirms them): per component the resume informs, `{ data, confidence, evidence }`, with `confidence` 0 to 1 and `evidence` up to 6 short resume lines it rests on.
     - `craft`: `functions`, `level`, `mode`, `facing`.
     - `domain`: `ranked` from the options AI infra, developer tools, data platforms, frontier AI, fintech, healthcare, security (strongest first).
     - `growth`: `scope_ceiling` (principal IC, group PM, head of product, VP product, founder) and `trajectory` (up, broader, deeper, steady). Where someone wants to go is theirs to say: keep it below 0.7.
     - `voice`: `style` (punchy, warm, formal, plain) from how the resume itself is written.
     At 0.7 or more the interview asks "Looks like ... Right?" (Yes / Edit); below it pre-fills the question. Be honest: a guess is below 0.7.
4. `onboard.extract { story, craft?, drafts? }`. An `invalid_input` error lists the values that are not in the resume: fix them by copying the exact text (or drop the value), then call again. Never paraphrase to get past it.
5. Optional follow-ups: `onboard.propose_questions { questions: [{ component, label, example?, answer_type: chips | multi_chips | text, options?, reason }] }`, at most 4, only where the resume is silent or ambiguous on something that matters for matching (a career switch, a gap, two very different domains). Each `label` is a full, plain sentence ending in `?`, one thing at a time; `example` is one short line. Do not repeat a bank question (the op rejects near duplicates and lists why). Skip this step when nothing is unclear.
6. `runs.finish { run_id, status: "ok", summary: { roles: <n>, wins: <n>, drafts: <n>, follow_ups: <n> } }`.

## Rules

- Copy, do not summarize, translate or improve. No number, title, employer, date or degree that is not in the resume.
- Leave out what is unclear instead of guessing.
- No em dashes in anything you write yourself.
