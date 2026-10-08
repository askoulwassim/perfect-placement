---
name: inbox
description: Read Gmail (read-only) for replies about roles in the pipeline, classify each message (confirmation, interview request, offer, rejection, outreach reply, other) with a probability, and hand the verdicts to the `inbox.ingest` op, which applies the confidence x impact policy and moves roles forward with the no-downgrade guard. Never replies, archives, deletes or sends.
---

# Inbox

Turn application replies into pipeline movement, for every company in the pipeline. You supply the **classification and its probability**; `inbox.ingest` does the rest: policy per message (confident -> applied now with a 24h undo, unsure -> Needs you with your pick attached), status moves, interview rows, events, the run log, and skipping messages it already handled.

## When

Daily (scheduled) once applications are out, and on demand.

## Steps

1. `runs.start { skill: "inbox" }`.
2. Watch set: `roles.list { status: ["draft-ready", "applied", "interviews", "offers", "active"] }` plus outreach in Gmail (`in_gmail` drafts). Derive companies from it; never hardcode a company or sender.
3. Search Gmail (read-only) for the last 2 days: ATS and recruiting senders (Greenhouse, Lever, Ashby, Workday, Jobvite, iCIMS, SmartRecruiters, Workable, BambooHR, and no-reply, talent, recruiting, careers, notifications addresses) or mail naming a watch-set company.
4. For each message pick one `class`:
   - `confirmation`: "thank you for applying", application received.
   - `interview_request`: next steps, availability, scheduling. Add `interview_at` (ISO) when a time is fixed.
   - `offer`: an offer or offer call.
   - `rejection`: "not moving forward", "unfortunately".
   - `outreach_reply`: a reply to one of the user's outreach drafts (set `outreach_id`).
   - `other`: anything else (ignored).
   Map it to `role_id` (or `null` if no role matches). Give an honest `p` (0 to 1) for the class.
5. `inbox.ingest { messages: [{ message_id, thread_id, received_at, role_id, outreach_id?, class, p, interview_at? }] }`. Relay `applied`, `queued` (Needs you) and `ignored`.
6. `runs.finish { run_id, status: "ok" }`.

CLI equivalent: `pp inbox --in messages.json`.

## What the op does (do not do it yourself)

confirmation -> `applied` (records `applied_at`), interview_request -> `interviews` (adds an interview round), offer -> `offers`, rejection -> `archived` with reason `rejected`, outreach_reply -> outreach `replied`. A message never moves a role backwards (a late confirmation will not pull a role out of interviews); a rejection archives from any stage.

## Rules

- **Read-only on email**: never reply, archive, delete, label, mark read or send. Never accept or decline anything.
- Notify only on new meaningful items (interview, offer, rejection, first confirmation), interviews and offers first with dates. Silent on empty days.
- Every write is an op. Never submit an application or send an email.
