import type { BackendMap } from '@perfect-placement/resolver';
import type { FetchLike } from '../integrations/ats/index.js';
import type { GmailContactsSource, GmailDraftClient } from '../integrations/gmail/index.js';
import type { LinkedInSource } from '../integrations/linkedin/index.js';
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
  /** Starts the headless agent runner for `runs.start`. Default: spawns `config.runner`. */
  launcher?: RunnerLauncher;
}
