# Wave 2: Integrate + cut over

**Starts after:** lanes A to I merged (J optional).

## Build

- Merge lanes in dependency order: A, B, I, E, F, G, H, C, D, then J if adopted. Resolve `CONTRACT_CHANGES.md`.
- Switch the web UI from the mock client to live ops.
- Skills call ops only; delete v1 scripts from the system repo (they stay in the v1 archive).
- Run `pp migrate` on Wassim's machine (with him), then `pp doctor`.
- Learn loop end to end: event -> resolver -> diff -> policy -> profile v+1 -> rescore.
- New scheduled tasks: daily inbox, daily freshness, weekly scout + score (created by an agent so they stay agent-editable). v1 tasks stay paused; Wassim deletes them after the first green week.
- Freshness backfill over all unapplied roles; scoring v2 rescore with Wassim's go.
- One real role through every stage: scout -> score -> freshness -> research -> tailor -> connect -> fill -> Wassim submits -> inbox picks up the confirmation.

## Done when

- doctor green on the real vault; counts reconcile with v1 before rescore.
- The real role reached `applied` with only ops writing data.
- Wassim signs off on the UI against the prototype.

## Wave 3 (later)

Interview skill (prep from dossier + stories + contacts; structured retro feeding Learn), open-source packaging (README, install, sample vault from fixtures, Kev default), multiple profiles.
