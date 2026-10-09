-- Migration 007: the resume-adaptive onboarding interview (#22). An onboarding session keeps its interview
-- plan: per-component resume drafts with a confidence, the follow-up questions the onboard agent run
-- proposed, and the questions the user skipped. Must match packages/contracts/src/entities.ts TABLES
-- exactly (tested). Additive only (ALTER TABLE ADD COLUMN); existing sessions get an empty plan.

ALTER TABLE onboard_session ADD COLUMN interview_json TEXT NOT NULL DEFAULT '{}';

INSERT INTO schema_migrations (version, name, applied_at) VALUES (7, '007_onboard_interview', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
