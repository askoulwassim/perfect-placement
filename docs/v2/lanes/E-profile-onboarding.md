# Lane E: Profile + onboarding + learn

**Branch / worktree:** `v2/lane-e`  
**Owns (writes only here):** packages/engine/profile/**, skills/{onboard,learn}/**  
**Starts after:** Wave 0 merged  
**Inputs:** blueprint.md (11 components, onboarding protocol, learn loop), v1 01_Profile files (read-only, for shape only), packages/contracts

## Build

- Component schemas (zod) per key with kind, confidence, weight, data; versioning with parent, reason, causing event.
- Ops: profile.get, profile.history, profile.propose_diff, profile.apply_diff, onboard.ingest_resume, onboard.answer, onboard.calibrate, onboard.confirm.
- Interview protocol: question bank per component with skip logic (skip what the resume answered), chip/slider answer types.
- Calibration: 12 sample roles, yes/no/maybe -> derived criterion weights (document the method; stated preferences as prior).
- Learn: event -> resolver Noulli per component -> LLM diff with evidence -> impact tier (weights medium, filters/dealbreakers high) -> policy.
- Converter: v1 perfect_role.md + rubric.json + positioning.md -> v1 components (used by lane A).

## Done when

- Onboarding runs end to end on fixtures via ops.
- A synthetic rejection event produces a proposed diff routed by the policy.
- Wassim's v1 profile converts with no information dropped (report what mapped where).

## Never

- Never auto-apply a filter or dealbreaker change.
- Never commit personal data. Never edit `packages/contracts` directly: add a request to `CONTRACT_CHANGES.md`.
- Never submit an application or send an email.
