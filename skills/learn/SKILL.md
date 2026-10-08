---
name: learn
description: Turn learning events (picks, skips, closed roles, rejections, interview retros, outreach replies, offers, overridden decisions) into profile diffs with evidence. The policy decides what applies; filters and dealbreakers always wait for the user.
---

# learn

**Owner: lane E.** Supplies judgment only; every write is an op. Never submit an application or send an email.

## Trigger

Any event in `LEARNING_EVENTS`: `role_picked`, `role_skipped`, `role_closed`, `rejection`, `interview_retro`,
`outreach_replied`, `offer`, `decision_overridden`. The engine runs the loop (`learnFromEvent`, exposed as an op in
Wave 2); this skill is the judgment the loop asks for when an LLM backend is an agent.

## Judgment you supply

1. **Does this event change a component?** For each of the 11 components the resolver asks a yes/no. Answer from the
   event and the component's current data only. One rejection rarely proves a preference; say no unless the event is
   direct evidence (explicit feedback, an offer's terms, a pattern across several events).
2. **Draft the diff** for each yes: `{ before, after, evidence }`.
   - `after` holds only the top-level keys you change; `before` the same keys' current values (the engine recomputes
     `before` from the data anyway).
   - `evidence`: short factual lines pointing at the event(s): role id, stage, quoted feedback. No speculation.
   - Return nothing when on reflection nothing should change.
   - Keep the component's schema (see `packages/engine/profile/components.ts`). Never change `criteria_weights` by more
     than 3 points per criterion from one event.
3. Then call `profile.propose_diff` `{ component, before, after, evidence, event_id }`. Do not call
   `profile.apply_diff` yourself: routing is policy.

## Policy (mechanics, for reference)

| Component kind | Impact | Outcome |
| --- | --- | --- |
| Work mode, Terms, Dealbreakers (filters) | high | always the user, in Needs you |
| Craft, Domain, Company, Team, Growth (weighted) | medium | auto + 24h undo when p >= 0.90, else the user |
| Story, Voice, Network (assets) | low | auto when confident, else the user |

Applied weighted and filter changes create profile v+1 and trigger a rescore of unapplied roles.
