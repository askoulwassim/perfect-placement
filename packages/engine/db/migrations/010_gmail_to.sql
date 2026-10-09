-- Migration 010: the To a Gmail draft was created with (#99).
-- A guessed address waiting in Needs you no longer gets a Gmail draft; once it is confirmed the engine queues
-- the Gmail step. A draft already in Gmail with no To (created before this change, or by an agent while the
-- guess was pending) is updated with the confirmed To; `gmail_to` records which drafts have one.
-- Existing rows stay NULL (To unknown): a later confirmation fills them.
-- Must match packages/contracts/src/entities.ts TABLES exactly (tested). Additive only.

ALTER TABLE outreach ADD COLUMN gmail_to TEXT;

INSERT INTO schema_migrations (version, name, applied_at) VALUES (10, '010_gmail_to', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
