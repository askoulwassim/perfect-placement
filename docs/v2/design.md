# UI design source of truth

The UI is defined by a Claude Design prototype Wassim built from `claude-design-prompt.md`. Where the prototype and the written brief disagree, **the prototype wins**. Where the prototype and `decisions.md` disagree, ask Wassim.

## Import

Use the claude_design MCP (`https://api.anthropic.com/v1/design/mcp`, auth via `/design-login`) to import this project:

https://claude.ai/design/p/fcd74e19-f269-49f8-975c-32ff274edd64?file=Perfect+Placement.dc.html

Focus on:
- `Perfect Placement.dc.html` (implement this)

Also read the files it imports:
- `pp-data.js` (sample data)
- `support.js`

The whole project is readable.

## Who uses it

- **Wave 0** reads it to extract final design tokens into `packages/contracts/tokens.ts` and the web CSS variables, and to confirm the component inventory below.
- **Lane D** implements every screen in `apps/web` against fixtures, matching the prototype.
- **Lane J** uses the same components for generated (OpenUI) replies.

## Expected components (confirm against the prototype)

RoleTile, FreshnessRing, BandDot, StatusChip, ScoreRadar, AffinityChip, DecisionCard, ProbabilityBar, ImpactChip, WhoDecidesGlyph (auto, auto + undo, you), ContactAvatar (5 tiers), ProfileNode, Constellation, StageRail, RiverColumn, CommandBar, CountTile, NeedsYouRing.

## Screens

Now, Needs you, River, Role, People, Outreach draft, You, Onboarding (4 steps), Ask (Cmd+K), Settings. Mobile (390px): Now, Needs you, Role, bottom tab bar.

## Non-negotiables

- No explanatory text, no tips, labels of one to three words.
  - Exception (wave1-decisions #27, revised 2026-10-09 by #24 / #43): first-run guidance is a Getting started card on Now with six ordered steps (Profile, Policy, First scout, Roles arriving, Review, First role), each done from real state. Opening a step from the card shows one short sentence beside its target in the cue styling; any click dismisses it. Automatic and one-time: gone for good once every step is done. No setting shows, replays or skips it. Never a paragraph.
  - Clarification (wave1-decisions #28, #23): the rule is for buttons and labels. Onboarding interview questions are full, plain sentences with an optional one-line example.
- One primary action per screen, same place, filled emerald.
- Every button calls exactly one op from `packages/contracts`.
- Never a "Send" or "Submit" button that acts externally: outreach ends at **Create Gmail draft**, applications at **Open portal**.
- Dark only, navy and emerald, as in the prototype.
