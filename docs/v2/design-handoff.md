# Claude Design handoff (imported in Wave 0, 2026-10-08)

Imported from the Claude Design project `fcd74e19-f269-49f8-975c-32ff274edd64` (`Handoff.md`). Project files: `Perfect Placement.dc.html` (root), `RoleTile.dc.html`, `Glyph.dc.html`, `pp-data.js`, `support.js`. Lane D imports the prototype itself via the design MCP; this copy is the reference for tokens and inventory. Sample-data specifics from the prototype are omitted here.

Machine-readable versions: `packages/contracts/src/tokens.ts` (tokens, semantic color maps) and `packages/contracts/src/ui.ts` (`COMPONENTS`, `SCREENS`, `PRIMARY_ACTIONS`).

## 1. Design tokens

Colors: bg #06111F, bg-2 #091A2D, panel #0C1F36, panel-2 #11284A, line #1A3557, line-2 #26486F, fg #E6EEF6, muted #8EA3BB, dim #5C7491, emerald #2FD39B, **emerald-hover #5BE3B3** (new vs brief), emerald-2 #17A77A, emerald-deep #0B5C45, emerald-ink #04291F, gold #E2B65A, coral #EF7D7D, sky #7FB6FF.

Tints: emerald 10% / border 40%, gold 10% / border 40%, coral 10% / border 45%, sky 10%, scrim rgba(6,17,31,0.62). Ground glow: `radial-gradient(900px 620px at 100% 0%, rgba(11,92,69,0.55), rgba(11,92,69,0) 70%)`.

Fonts: Bricolage Grotesque (display), Figtree (UI), JetBrains Mono (mono). Type scale: hero-number 104/800, fit-number 84/800, onboard-q 72/800, count-tile 64/800, decision-q 46/700, screen-title 44/800, card-number 38/800, panel-title 32/800, body-lg 18/400, title 16/600, body 14/500, caption 13/400, small 12/400, eyebrow mono 11 upper .1em, mono 12, prob mono 14 tabular.

Space: 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56. Layout: rail 76, page pad x 48 / top 32, max width 1440, decision card max 720, side panel 380, mobile 390, mobile tab bar 70. Radius: card 12, button 10, small 8, chip 999, phone 36. Controls: button 44, chip 34, mobile hit 44, mobile primary 50. Focus: 2px solid emerald, offset 2. Motion: fast 150ms, base 250ms, ring 600ms ease, bounce 450ms.

Hover and focus (#101): hover is CSS only, under `@media (hover: hover)` (a Btn `hover` object becomes an injected `.pp-h-*:hover:not(:disabled)` rule), so a click or a tap never leaves a highlight behind; focus rings use `:focus-visible`, never `:focus`. No JS hover state (`onMouseEnter`/`onMouseLeave`); `hover.test.tsx` enforces both.

## 2. Component inventory

RoleTile, FreshnessRing, BandDot, WhoDecidesGlyph (auto, second, undo, you), PrimaryButton, SecondaryButton, Chip (fact, filter, impact, status, reason, diff-before, diff-after, evidence), StatusChip, ImpactChip, ProbabilityBar (colored by policy thresholds), HeroRing (= NeedsYouRing), CountTile, AutoRow, RoleCard, RiverColumn, RiverTile, ScoreRadar, AffinityChip, StageRail, ContactAvatar (5 tiers), BestPathPill, PeopleGraph, DraftStatusChip, OutreachBlock, ToneChips, ProfileNode, DiffBlock, VersionTimeline, DecisionCard, ProgressDots, CommandBar, PolicyGrid, Toggle, BackendCard, Toast, NavRail / TabBar. Props and states: `packages/contracts/src/ui.ts`.

Brief components not in the handoff as separate names: **Constellation** (the You screen layout of 11 ProfileNodes; kept as a component in `ui.ts`), **NeedsYouRing** (= HeroRing).

## 3. Screens and primary action

| Screen | Primary action |
| --- | --- |
| Now | Review N (Open River when clear) |
| Needs you | Accept (Open portal on the submit variant) |
| River | Scout now |
| Role | Next stage: Research / Tailor / Connect / Fill / Open portal |
| People | Draft for <best path> |
| Outreach draft | Create Gmail draft |
| You | Review N diff, then Accept diff; Recalibrate when none pending (while diffs are pending Recalibrate is a secondary action, #66) |
| Onboarding | Next x3, then Start |
| Ask (overlay) | Contextual (Check all, Open People) |
| Settings | Save |

Mobile (390): Now, Needs you, Role (plus River, You, Outreach) with a bottom TabBar (Now, River, You, Ask); primary button pinned above the tab bar.

## 4. Decisions that differ from the brief

- Primary button sits in the header top-right on every screen, including Needs you. The card keeps Change and Skip plus A/C/S/arrow keys.
- A Needs-you card about a role (freshness, dedupe, move, archive, fact check, inbox) shows **Open posting** next to Change and Skip when the role has a url: a plain external link (`<a target="_blank" rel="noopener noreferrer">`, not an op button), key `O` (#102). A freshness card adds a **Checked** row: when the posting was last checked and the evidence, short.
- Now's Auto stream is grouped (#103): one AutoRow per role per score run ("Scored 82 · Kev · 9 criteria"), per run for contact classifications ("Contacts · Classified 6") and freshness ("Postings · Checked 12 · 2 closed"); no run id groups by kind and subject within 10 minutes. A count toggle (local) expands the member rows; the row's Undo (`decisions.undo_group`) undoes every undoable member and is hidden when none is.
- Fourth glyph "auto after second opinion": two emerald dots (one at half opacity).
- Probability bars use the policy thresholds for color; dragging thresholds in Settings recolors every bar.
- Held is not a drop target; draft-ready -> applied bounces (the app never submits). Allowed drags: inbox<->active, active<->on-deck, on-deck<->draft-ready, applied<->interviews<->offers. (Encoded as `MANUAL_MOVES`.)
- Company cap is drawn on the visible tile: a stacked tile with a gold "+N held" chip The chip sits on the company's best (highest scored) visible Active tile.
- Lane order (#104): each lane sorts by latest score total (desc), unscored last by found date (newest first); ties by score, found date, then id. A per-lane Score / Newest toggle (local view state, `data-op="local"`) is remembered per viewer in localStorage (`pp.river.sort`); without storage the lanes still render in Score order. `roles.list` stays order-agnostic: the sort is the pure `sortLane` in `apps/web/src/lib/river.ts`.
- Archived reasons show as count chips under the collapsed archived count.
- A Terms diff can be resolved from Needs you or You; resolving in one clears both.
- Stage by status: active/held -> Tailor next, draft-ready -> Connect next, on-deck/inbox -> Research next (Tailor once the company has a dossier; the application stage wins when one exists), applied -> done. On-deck is labelled **In progress** in River, Role and Now (#105): starting Research, Tailor or Connect on an active or held role picks it (-> on-deck, `role_picked`). Creating a Gmail draft marks Connect done.
- Added a "Setup" rail icon to re-enter onboarding, and a back arrow on Role, People, Draft.
- People are placeholders (first name + last initial).
