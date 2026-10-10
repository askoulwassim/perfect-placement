# Build decisions (wave 1, 2026-10-08)

Answers to the questions raised while building the first version, cited in code as `wave1-decisions #N`. Where one changes a founding decision, [`decisions.md`](decisions.md) logs it.

## UI
1. The Claude Design prototype is ported from a copy kept outside the repo; its sample data is never committed.
2. The web app **ports the prototype faithfully**: markup, styles, SVGs, motion and layout 1:1, keeping the typed op client and tests. River has a **Held column** plus stacked "+N held" tiles; **tone chips only switch the draft text locally** (no op).

## People and outreach
3. The first live connect run uses one role the owner already picked (on-deck or draft-ready), with the owner present.
4. LinkedIn driver: **Claude in Chrome** on the user's signed-in Chrome. Not Playwright.
5. Gmail drafts go through the **Gmail connector (MCP)** behind the draft-only interface. No OAuth app.
6. LinkedIn people-reads are **on by default** (read-only, capped, slow, picked roles only, never message or connect). Anonymous checks of public LinkedIn job pages for freshness are allowed.

## Decision backends
7. **Kev only.** Kev is the default System One backend (`decisions.md #7`).
8. Model: **kev-4b** (MLX); on a 16 GB machine use kev-0.8b if it swaps or is slow.
9. **No API key.** All LLM work happens in a Claude Code, Codex or Cursor session over MCP. UI buttons and schedules start **headless agent runs**; `runs.start` launches the configured runner. Resolver order: rule -> Kev -> the calling agent -> human. Unattended decisions with no agent attached use Kev or go to Needs you.
   - **Agent-agnostic:** everything works from Claude Code, Codex and Cursor. The runner is configurable (`claude -p`, `codex exec`, `cursor-agent`); AGENTS.md and MCP are the shared surface; MCP tool names use underscores so all three accept them.

## Scoring and profile
10. Dream-company affinity: **+3** (cap +/-5, no dealbreaker bypass).
11. Score formula: `round(sum(c*w)/5)`; bands 75 / 55.
12. Comp floor: a **C6 penalty**, not a hard gate. Unknown comp gets a verify flag. Changing the floor stays high impact.
13. On-deck is **protected** from automated rescoring and **does not count** toward the per-company cap (active only).
14. Asset diffs (Story, Voice, Network): **medium impact** (auto + 24h undo when confident).
15. A **full re-onboard** (all 11 components + calibration) rather than patching gaps.

## Pipeline behavior
16. A confident confirmation email **revives an archived role to applied**, auto + 24h undo.
17. Agent moves and archives **follow the policy grid**; no confidence attached means Needs you.
18. Closing a draft-ready role follows the **policy grid** (auto + undo at p >= 0.92), no special rule.
19. (Void, #26.)
20. (Void, #26.)

## OpenUI
21. **Adapt**: OpenUI parser + streaming renderer (pinned 0.3.2) with our own cards and id-only props. Keep install scripts blocked; stub the CDN devtools.
22. Telemetry: OpenUI's install script is blocked by `pnpm.onlyBuiltDependencies`; contributors can also set `OPENUI_TELEMETRY_DISABLED=1` (AGENTS.md).
23. Ask replies **carry action buttons**, limited to ops in `PRIMARY_ACTIONS`; never submit or send; high impact still goes to Needs you.

## Policy and profile
24. **Policy grid: the prototype's cells are the policy, with hard exclusions.** Rows = impact; columns = p >= auto, second_opinion <= p < auto, p < second_opinion:
    - low: auto | auto | auto + undo
    - medium: auto | auto if a second backend agrees | you
    - high: auto + undo | you | you

    Hard exclusions, always `you` and not tunable from Settings: submit an application, send an email, delete anything, change a dealbreaker, change the comp floor. The second opinion comes from the calling agent session; without one it falls to `you`. The DB check enforces the exclusion list.
25. **Craft stays weighted** ([`architecture.md`](architecture.md) wins over the prototype's asset coloring).

## Fresh start
26. **No v1 data is imported**; the v1 migration code is removed and #19 and #20 are void. Gone: `pp migrate`, the v1 importer, the v1 profile converter, the scoring backtest, the freshness `--v1` dry run and the resolver eval's v1 loaders. Migration 003 drops archive reason `legacy`, role source `migration`, flag `verify_remote` and the `v1_sections` profile field.

## First launch
27. **An automatic guided path, one-sentence step cues, no settings** (2026-10-09; it replaced per-screen first-visit cues). A **Getting started** card on Now, shown until finished, lists six ordered steps, each done from real state, never from clicks on the guide: 1 Profile (a confirmed profile version), 2 Policy (Settings opened; on the phone, which has no Settings, the card's read-only policy summary opened, #65; `config.ui.guide.policy`), 3 First scout (a scout run started), 4 Roles arriving (that run ended ok or partial; the card shows its live state, Queued / Scouting / Failed), 5 Review (roles scored and River or Needs you opened; `config.ui.guide.review`), 6 First role (a role through Research -> Tailor, draft-ready or later). Each step opens its screen; arriving from the card shows one short sentence in the cue styling (scrim + emerald halo), dismissed by any click or key or by leaving that screen. Plain visits show nothing. When every step is done the vault keeps `config.ui.guide.done` and the card never returns. There is no user setting to show, replay or skip it. Dev-only reset: `pp op config.update --input '{"patch":{"ui":{"guide":{"policy":false,"review":false,"done":false}}}}'`.

## Onboarding interview
28. **Interview questions are full sentences; the one to three word rule is for buttons and labels.** Every onboarding question is a complete, plain sentence a first-time user understands without context, with an optional one-line example under it, and every question has an "I don't know" answer. No two questions in one run ask for the same thing (Company: "Which companies would you love to work at?"; Network, right after: "Where do you already know people who could introduce you?"). The interview adapts to the resume (#22): what the resume implies with high confidence is confirmed ("Looks like ... Right?", Yes / Edit), not asked.
