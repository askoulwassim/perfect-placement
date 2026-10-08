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
- One primary action per screen, same place, filled emerald.
- Every button calls exactly one op from `packages/contracts`.
- Never a "Send" or "Submit" button that acts externally: outreach ends at **Create Gmail draft**, applications at **Open portal**.
- Dark only, navy and emerald, as in the prototype.
