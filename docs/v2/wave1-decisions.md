# Wave 1 decisions (2026-10-08)

Wassim's answers to the questions the ten Wave 1 lanes raised. Wave 2 applies these. Where one changes a locked decision, `decisions.md` logs it.

## UI (lane D)
1. The real Claude Design prototype was pulled to `pp-lanes/_private-reports/d/prototype/` (outside every repo; `pp-data.js` holds real data and must never be committed).
2. Lane D **ports the prototype faithfully**: markup, styles, SVGs, motion and layout 1:1, keeping the typed op client and tests. The prototype wins over earlier lane D choices: River has a **Held column** plus stacked "+N held" tiles; **tone chips only switch the draft text locally** (no op).

## People + outreach (lane H)
3. Live run role: the **top-fit role already picked** (on-deck or draft-ready) at migration time, confirmed with Wassim on the day.
4. LinkedIn driver: **Claude in Chrome** on Wassim's signed-in Chrome. Not Playwright.
5. Gmail drafts: through the **Gmail connector (MCP)** behind the draft-only interface. No OAuth app.
6. LinkedIn people-reads are **on by default** (still read-only, capped, slow, picked roles only, never message or connect). Anonymous checks of public LinkedIn job pages for freshness are allowed.

## Decision backends (lane I)
7. **Kev only** (no Jev). Kev is the default System One backend. Changes decisions.md #7.
8. Model: **kev-4b** (MLX), tested on this 16 GB M1 Pro; fall back to kev-0.8b if it swaps or is slow.
9. **No Anthropic API key.** All LLM work happens in a Claude (or Codex / Cursor) session over MCP. UI buttons and schedules start **headless agent runs**; `runs.start` launches the configured runner. The resolver order becomes rule -> Kev -> calling agent / human; the `llm` backend means "ask the calling agent session". Unattended decisions with no agent attached use Kev or go to Needs you.
   - **Agent-agnostic requirement:** everything must work from Claude Code, Codex and Cursor. Runner is configurable (`claude -p`, `codex exec`, `cursor-agent`); AGENTS.md + MCP are the shared surface; test MCP tool names (dotted vs underscore) in all three.

## Scoring + profile (lanes A, E, F)
10. Dream-company affinity: **+3** (cap +/-5, no dealbreaker bypass).
11. Score formula: **keep v1's** `round(sum(c*w)/5)`; bands 75 / 55 unchanged. Regenerate Wave 0 fixtures to match.
12. Comp floor: **C6 penalty** as in v1, not a hard gate. Unknown comp gets a verify flag. Changing the floor stays high impact.
13. On-deck: **protected** from automated rescoring; **does not count** toward the per-company cap (active only).
14. Asset diffs (Story, Voice, Network): **medium impact** (auto + 24h undo when confident).
15. **Full re-onboard** (all 11 components + calibration) once v2 is live, rather than patching gaps.

## Pipeline behavior (lanes A, B, G)
16. A confident confirmation email **revives an archived role to applied**, auto + 24h undo.
17. Agent moves and archives **follow the policy grid** once the resolver is wired; no confidence attached means Needs you.
18. Closing a draft-ready role follows the **policy grid** (auto + undo at p >= 0.92), no special rule.
19. (Void, #26.) The two applied roles missing `applied_at`: **search Gmail read-only at cutover** for the confirmations; leave null if none.
20. (Void, #26.) The four green-scored roles v1 archived for unconfirmed remote: **migrate as archived / dealbreaker** tagged `verify_remote` (keeps 84 archived), revisit at the approved v2 rescore.

## OpenUI (lane J)
21. **Adapt**: OpenUI parser + streaming renderer (pinned 0.3.2) with our own cards and id-only props. Keep install scripts blocked; stub the CDN devtools.
22. Telemetry: opted out machine-wide with `OPENUI_TELEMETRY_DISABLED=1` in `~/.zshrc`. Wave 2 also documents it in AGENTS.md.
23. Ask replies **carry action buttons**, limited to ops in `PRIMARY_ACTIONS`; never submit or send; high impact still goes to Needs you.

## Lane D rework follow-ups
24. **Policy grid: the prototype's cells become the policy, with hard exclusions.** New grid (rows = impact; columns = p >= auto, second_opinion <= p < auto, p < second_opinion):
    - low: auto | auto | auto + undo
    - medium: auto | auto if a second backend agrees | you
    - high: auto + undo | you | you
    Hard exclusions, always `you` and not tunable from Settings: submit an application, send an email, delete anything, change a dealbreaker, change the comp floor. Note: with Kev as the only System One backend, "second backend agrees" needs a second opinion source (the calling agent session or a second Kev question); otherwise it falls to `you`. Changes decisions.md #4 and `POLICY_GRID` in contracts (Wave 2 contract change; the DB check `impact <> 'high' OR policy_outcome = 'human'` must be relaxed to the exclusion list).
25. **Craft stays weighted** (blueprint wins over the prototype's asset coloring).

## Fresh start (cleanup)
26. **Fresh start: no v1 data is imported; v1 migration code removed in this cleanup; decisions #19 and #20 are void.** Gone: `pp migrate`, the v1 importer, the v1 profile converter, the scoring backtest, the freshness `--v1` dry run and the resolver eval's v1 loaders. Migration 003 drops archive reason `legacy`, role source `migration`, flag `verify_remote` and the `v1_sections` profile field. The first real run follows `wave2-plan.md`, "Fresh-start runbook".

## First launch
27. **First-visit cues: one-time spotlight on the primary action with a 1-3 word label; logged exception to design.md 'no tips' rule, owner-approved 2026-10-08.** Soft scrim plus an emerald halo on the screen's primary action, dismissed by any click or key, never shown again. Seen cues persist in the vault (`config.ui.cues_seen`); Settings "Show cues" resets them. No paragraphs, no multi-step tour.

## Onboarding interview
28. **Interview questions are full sentences; the one to three word rule is for buttons and labels.** Clarifies design.md "labels of one to three words" (#23, first-use feedback 2026-10-09: "Warm companies" read as a riddle). Every onboarding question is a complete, plain sentence a first-time user understands without context, with an optional one-line example under it, and every question has an "I don't know" answer. No two questions in one run ask for the same thing (Company: "Which companies would you love to work at?"; Network, right after: "Where do you already know people who could introduce you?"). The interview adapts to the resume (#22): what the resume implies with high confidence is confirmed ("Looks like ... Right?", Yes / Edit), not asked.
