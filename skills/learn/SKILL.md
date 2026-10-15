---
name: learn
description: Turn learning events (picks, skips, closed roles, rejections, interview retros, outreach replies, offers, overridden decisions) into profile diffs with evidence. The policy decides what applies; filters and dealbreakers always wait for the user.
---

# learn

Supplies judgment only; every write is an op. Never submit an application or send an email.

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
   - Keep the component's schema: the same keys and value types `profile.get` returns (the op validates it; the
     schema is `packages/engine/profile/components.ts` in the repo, never in the vault). Never change `criterion_weights` by more
     than 3 points per criterion from one event.
3. Then call `profile.propose_diff` `{ component, before, after, evidence, event_id }`, and `profile.apply_diff { diff_id }`
   with your confidence: routing is policy, never your call.

## Policy (mechanics, for reference)

| Component kind | Impact | Outcome (#14, #24) |
| --- | --- | --- |
| Dealbreakers; Terms when the comp floor changes | hard exclusion | always the user, in Needs you |
| Work mode, other Terms changes (filters) | high | auto + 24h undo when p >= 0.90, else the user |
| Craft, Domain, Company, Team, Growth (weighted) | medium | auto + 24h undo when p >= 0.90; 0.70 to 0.90 only if a second opinion agrees; else the user |
| Story, Voice, Network (assets) | medium | same as weighted |

`profile.learn { event_id }` runs the loop: it asks the 11 yes/no questions through the resolver. When the engine has no
writing model (the default), you draft each diff and call `profile.propose_diff`; then call `profile.apply_diff` with your
confidence in the op context, and the policy decides. Applied weighted and filter changes create profile v+1 and rescore
the movable roles (inbox, active, held; never a role the user picked).

## Tools

A headless run pre-approves exactly these (`SKILL_TOOLS` in `packages/engine/runners/grants.ts`; a test keeps this list and that one equal) and denies everything else. If one you need is denied or missing, do not work around it: `runs.finish { run_id, status: "error", summary: { error: "tool denied: <tool>", denied_tools: [...] } }`.

- `{{tool:pp}}`: the pp MCP tools (every Perfect Placement read and write is an op).
