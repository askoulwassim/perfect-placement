import { z } from 'zod';

export const EVENT_TYPES = [
  'role_added',
  'role_scored',
  'role_moved',
  'role_archived',
  'role_held',
  'role_promoted',
  'freshness_checked',
  'role_closed',
  'role_picked',
  'role_skipped',
  'application_tailored',
  'application_submitted',
  'inbox_classified',
  'interview_scheduled',
  'interview_retro',
  'rejection',
  'offer',
  'contact_found',
  'outreach_drafted',
  'outreach_replied',
  'profile_diff_proposed',
  'profile_diff_applied',
  'profile_diff_rejected',
  'decision_made',
  'decision_overridden',
  'decision_undone',
  'run_started',
  'run_finished',
] as const;
export const EventType = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventType>;

/** Events the Learn loop listens to (docs/architecture.md "Learning signals"). */
export const LEARNING_EVENTS = [
  'role_picked',
  'role_skipped',
  'role_closed',
  'rejection',
  'interview_retro',
  'outreach_replied',
  'offer',
  'decision_overridden',
] as const satisfies readonly EventType[];
