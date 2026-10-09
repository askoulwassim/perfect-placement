import type { PolicyConfig, ScheduleJobState, ScheduleKey } from '@perfect-placement/contracts';
import type { BackendMap } from '@perfect-placement/resolver';
import type { FetchLike } from '../integrations/ats/index.js';
import type { GmailContactsSource, GmailDraftClient } from '../integrations/gmail/index.js';
import type { LinkedInSource } from '../integrations/linkedin/index.js';
import type { EmailProvider, MxResolver } from '../people/email.js';
import type { OutreachWriter } from '../people/types.js';
import type { ProfileLlm } from '../profile/deps.js';
import type { RunnerLauncher } from './runner.js';

/*
 * Everything outside the db + vault an op may touch, injected once per engine. Production
 * (`openEngine`) fills the defaults; tests inject fakes. Nothing here writes the db or the vault.
 */
export interface EngineServices {
  /** HTTP for the freshness ladder (ATS APIs, posting pages). Default: global fetch. */
  fetch?: FetchLike;
  /** Politeness gap between freshness checks that hit the network (ms). Default 750. */
  freshnessDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Extra or replacement resolver backends (tests: a fake Kev). Merged over the config-built map. */
  backends?: BackendMap;
  /** Is Kev installed in PP_HOME? Default: `$PP_HOME/kev/installed.json` exists (`system.backends` not_installed vs down). */
  kevInstalled?: (home: string) => boolean;
  /** Environment for backend keys (KEV_API_KEY, JEV_API_KEY, ANTHROPIC_API_KEY). Default: process.env. */
  env?: Record<string, string | undefined>;
  /**
   * Writing model for profile diffs and resume parsing. Absent by default (wave1-decisions #9: all LLM
   * work runs in the agent session): `profile.learn` then asks the resolver and leaves drafting to the
   * learn skill, which calls `profile.propose_diff`.
   */
  profileLlm?: ProfileLlm;
  /** LinkedIn people reads (read-only, capped). Absent = no LinkedIn rung. */
  linkedin?: LinkedInSource;
  /** Gmail drafts (never send). Absent = `outreach.to_gmail` answers backend_unavailable. */
  gmail?: GmailDraftClient;
  gmailContacts?: GmailContactsSource;
  /** Outreach text writer for scheduled runs without an agent. */
  outreachWriter?: OutreachWriter;
  /** MX lookup for `people.find_email` (#37). Default: DNS (`defaultMx`). Tests inject a fake; never SMTP. */
  mx?: MxResolver;
  /** Email finder (Hunter, Apollo, ...) behind the user's own key (#37). Pinned: no adapter ships; absent by default. */
  emailProvider?: EmailProvider;
  /** Starts the headless agent runner for `runs.start`. Default: spawns `config.runner`. */
  launcher?: RunnerLauncher;
  /**
   * The OS jobs behind `config.schedules` (#29): launchd / systemd user timers, written by the CLI
   * (`pp schedules`). `pp up` wires it in; absent = `schedules.status` reports `unknown` and
   * `config.update` leaves the jobs alone.
   */
  scheduleJobs?: ScheduleJobs;
}

/** OS job manager for schedules (#29). Implemented in the CLI; tests inject a fake. */
export interface ScheduleJobs {
  /** Each schedule's job compared with `schedules` (file reads only, no job manager calls). */
  status(schedules: PolicyConfig['schedules']): Record<ScheduleKey, ScheduleJobState>;
  /** Make the jobs match `schedules`: install the ones on, remove the ones off. */
  sync(schedules: PolicyConfig['schedules']): Promise<unknown>;
}
