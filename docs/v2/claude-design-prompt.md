# Perfect Placement v2: clickable prototype

Design a clickable, high-fidelity prototype for **Perfect Placement**, a personal job-search system that runs locally. It scouts roles, scores them against the user's profile, keeps the pipeline fresh, tailors applications, finds people who can open doors, watches the inbox, and learns from every outcome. Agents do most of the work. The human approves, steers, and makes the high-impact calls.

The UI is the human's cockpit over an agent system. Everything the UI can do, an agent can also do through MCP, so every action is one clear button bound to one operation.

## Design principles (non-negotiable)

1. **Visual over verbal.** No paragraphs, no explanatory headers, no tips, no onboarding tooltips, no helper text under fields. Labels are one to three words. Meaning comes from shape, color, position, and numbers.
2. **One primary action per screen.** It is always the same filled emerald button in the same place. Everything else is secondary or hidden until hover.
3. **State is color and shape.** A role's status, band, freshness, and who-decides are readable at a glance without reading text.
4. **Only "needs you" interrupts.** Everything else is ambient: counts, rings, dots.
5. **Agent-first.** There is a global Ask bar (Cmd+K). Agent replies render as the same cards the app uses (role card, score radar, contact card, profile diff), never as long text.
6. **Calm density.** Generous spacing, few borders, cards only where an object is a real object. Big numbers in tabular figures.

## Visual system

Dark only. Navy ground, emerald signal.

| Token | Hex | Use |
| --- | --- | --- |
| bg | #06111F | page ground |
| bg-2 | #091A2D | recessed areas, table headers |
| panel | #0C1F36 | cards, panels |
| panel-2 | #11284A | hover, selected |
| line | #1A3557 | hairlines |
| line-2 | #26486F | card borders |
| fg | #E6EEF6 | primary text |
| muted | #8EA3BB | secondary text |
| dim | #5C7491 | tertiary, disabled |
| emerald | #2FD39B | primary action, "go", done, yours |
| emerald-2 | #17A77A | hover borders |
| emerald-deep | #0B5C45 | emerald fills, tinted panels |
| emerald-ink | #04291F | text on emerald |
| gold | #E2B65A | needs you, medium impact, filters |
| coral | #EF7D7D | closed, rejected, high impact |
| sky | #7FB6FF | cold contacts, assets, explore |

Subtle radial glow of emerald-deep in the top right of the page ground. No gradients on cards.

Type: **Bricolage Grotesque** (display, 700 to 800, tight tracking) for screen titles and big numbers; **Figtree** (400 to 600) for UI text; **JetBrains Mono** for labels, ids, probabilities, small caps eyebrows (uppercase, letter-spacing .1em).

Radius 12px on cards, 10px on buttons, full pill on chips. Focus ring 2px emerald.

## Core objects and their visual language

- **Role**: company mark (letter tile), title, fit score (0 to 100) as a number plus a band dot (green at 75 or more, gold 55 to 74, coral below 55).
- **Status** (pipeline order): inbox, active, held, on-deck, draft-ready, applied, interviews, offers, archived. "Held" means over the per-company cap. "Archived" carries a reason chip: below-threshold, closed, rejected, passed.
- **Freshness**: a small ring around the role tile. Full emerald = checked in the last 24h and open. Gold = unsure. Coral slash = closed.
- **Score**: radar over 9 criteria (C1 Decisions, C2 0-to-1, C3 External, C4 Data, C5 Domain, C6 Comp, C7 Team, C8 Growth, C9 Shape). Company affinity is shown separately as a small +/- modifier chip capped at 5, never inside the radar.
- **Decision**: every decision has a resolver pick, a probability (0.00 to 1.00), and an impact tier (low, medium, high). Show probability as a thin bar; impact as a chip (emerald, gold, coral).
- **Who decides**: three glyphs used everywhere. Auto (filled emerald dot), Auto + undo (emerald ring with a countdown arc), You (gold square).
- **Contact tiers**: warm-hiring (solid emerald avatar ring), warm-other (emerald-deep ring), bridge 2nd degree (dashed emerald ring), cold-hiring (sky ring), cold-other (dim dashed ring).
- **Profile component**: circle with a confidence ring (0 to 100). Kind color: filter = gold, weighted = emerald, asset = sky.

## Screens (all linked; left rail with icons only, tooltips on hover)

### 1. Now (home)
- Hero ring: number of items that need you (example 5), ring fill = share of today's decisions handled automatically.
- Three count tiles with icons only: closed today (coral, 4), drafts ready (emerald, 2), replies (sky, 1).
- "Auto-applied" stream: last 24h of automatic decisions, each a one-line row with glyph, object, and an Undo affordance on hover for "auto + undo" items.
- Top 3 picks: role cards sorted by fit, freshness ring visible.
- Primary action: **Review 5** opens the Needs-you queue.

### 2. Needs you (decision queue)
- One decision card at a time, full focus, keyboard driven (A accept, C change, S skip, arrows to move).
- Card: object (role, contact, or profile component), the question in five words or fewer, resolver pick, probability bar, impact chip, evidence as 2 to 3 small chips you can expand.
- Variants to show: freshness unsure (posting status), inbox classification at 0.78, profile diff on a filter (high impact), outreach draft ready to become a Gmail draft, application ready to submit (high impact, primary button reads **Open portal**; the app never submits).
- Progress dots at the top. Empty state: a closed emerald ring and the word "Clear".

### 3. River (pipeline)
- Horizontal flow of status columns. Roles are dots or compact tiles depending on zoom. Archived collapsed at the far right as a single count.
- Filter chips: band, freshness, company, work mode. Company cap visible: a company with more than 3 roles shows a small stack with "+N held".
- Drag a role between adjacent columns only where allowed; forbidden moves bounce.
- Click a role: opens Role.

### 4. Role
- Header: company tile, title, fit number, band dot, status chip, freshness ring with "checked 3h".
- Left: score radar with the 9 criteria, affinity chip beside it.
- Middle: facts as chips only (remote, comp range, level, posted age, source).
- Right: People panel, avatars grouped by tier, best path highlighted.
- Below: the package as tabs (Dossier, Resume, Cover, Fit map, Answers) with document previews.
- Stage rail across the top showing where this role is in the apply flow: Research, Tailor, Connect, Fill, Submit. Primary action is the next stage (example **Tailor**). Submit is always a gold "You" step.

### 5. People
- Graph centered on the selected role's company: You, then 1st degree, then 2nd degree, then the hiring team. Edges styled by tier.
- Side list of the same people with tier ring, role, and draft status (none, drafted, in Gmail, replied).
- Click a person: outreach draft opens.

### 6. Outreach draft
- Recipient card with tier, the draft in three visible blocks labelled Hook, Proof, Ask (labels in mono, tiny).
- Tone variant chips per tier: Ask for the conversation (warm hiring), Coffee or intro (warm other), Forwardable blurb (bridge), Positioning note (cold hiring).
- Primary action: **Create Gmail draft**. Never "Send".

### 7. You (profile)
- Constellation: "You" at the center, 11 components around it: Story, Craft, Domain, Work mode, Terms, Company, Team, Growth, Dealbreakers, Voice, Network. Ring = confidence, color = kind.
- A pending-diff badge on any component with a proposed change.
- Click a component: side panel with its fields as chips and sliders, version history as a vertical timeline (v1, v2, v3 with the event that caused each), and the pending diff as before/after chips with accept or reject.

### 8. Onboarding (first run, 4 steps, progress as 4 dots)
1. **Resume**: a single large drop zone. After drop, components light up in the constellation as they are parsed.
2. **Interview**: one question per screen, answers as chips or a slider, never free text unless needed. Show the component being filled in the corner.
3. **Calibrate**: 12 sample role cards, swipe or press Y / N / M. A live weight bar per criterion shifts as you choose.
4. **Confirm**: the profile card, constellation plus key filters. Primary action **Start**.

### 9. Ask (global, Cmd+K)
- Command bar at the bottom center. Typing shows suggested operations as chips (scout now, check freshness, find people for this role).
- Replies stream in as cards: example "Which active roles are going stale?" returns a list of 4 role cards with coral and gold freshness rings and one button **Check all**.

### 10. Settings (minimal)
- Decision backends: Jev (hosted) and Kev (local) with status dots and latency.
- Policy grid: rows low, medium, high impact; columns confidence p >= 0.90, 0.70 to 0.90, below 0.70; each cell shows its glyph (auto, auto after second opinion, auto + undo, you). Thresholds adjustable by dragging the column boundaries.
- Schedules: daily inbox, daily freshness, weekly scout + score, each with an on/off toggle and next run time.
- Data home path: ~/.perfect-placement.

## Sample data (use these so the prototype feels real)

Active and applied roles: the prototype used rows from the v1 pipeline. They are kept in the private v1 archive (`PerfectPlacement/docs/v2/claude-design-prompt.md`) and deliberately left out of the system repo. Use `packages/fixtures` for sample data.

People: use placeholder first names with a last initial (for example Maya R., Dev P., Lina K.). Never real people.

## Interactions to make clickable

- Now, Review 5, then through all five decision variants in Needs you, back to Now with the ring full.
- Now, a top pick, Role (Temporal), Connect stage, People, a warm-hiring contact, Outreach draft, Create Gmail draft, back to Role with the Connect step done.
- River, drag GitLab Staff PM from active to on-deck, open it.
- You, Domain component, accept a pending diff, version timeline gains v3.
- Onboarding all four steps end to end.
- Cmd+K from anywhere with the staleness example.

## Responsive

Desktop first (1440). Also show Now, Needs you, and Role at 390px mobile: left rail becomes a bottom tab bar with 4 icons (Now, River, You, Ask).

## Deliverable and handoff

When the prototype is done, produce a handoff section I can paste into a coding agent:
1. The final design tokens (colors, type scale, spacing, radius) as a JSON object.
2. A component inventory: each component's name, props, and states (for example RoleTile, FreshnessRing, ScoreRadar, DecisionCard, WhoDecidesGlyph, ContactAvatar, ProfileNode, StageRail, CommandBar).
3. A screen list with the components each screen uses and its one primary action.
4. Any decisions you made that differ from this brief, and why.
