import type { AskFn, ContactTier, OpContext, OpName, OpOutcome, OpOutput, PolicyConfig } from '@perfect-placement/contracts';
import type Database from 'better-sqlite3';
import type { GmailContactsSource, GmailDraftClient } from '../integrations/gmail/index.js';
import type { LinkedInSource } from '../integrations/linkedin/index.js';

/** Text an LLM writes for one outreach draft. Never written by a System One model. */
export interface DraftText {
  subject: string;
  hook: string;
  proof: string;
  ask: string;
}

export interface WriterPrompt {
  tier: ContactTier;
  system: string;
  user: string;
}

/** LLM writer (config.backends.llm). Injected; Wave 2 wires the Anthropic client. */
export interface OutreachWriter {
  write(prompt: WriterPrompt): Promise<DraftText>;
}

/**
 * Everything lane H handlers need, injected. In Wave 2 the ops registry (lane B) builds this from
 * the open vault: db from lane A, `ask` from lane I, writer from the LLM backend, adapters per config.
 */
export interface PeopleDeps {
  /** better-sqlite3 handle with migrations applied. */
  db: Database.Database;
  /** Absolute vault root (PP_HOME). */
  vaultDir: string;
  /** Resolver `ask` (lane I). Writes decision rows and returns policy outcomes. */
  ask: AskFn;
  config: PolicyConfig;
  linkedin?: LinkedInSource;
  gmail?: GmailDraftClient;
  gmailContacts?: GmailContactsSource;
  writer?: OutreachWriter;
  /** Id factory; defaults to `<prefix>_<ulid>`. */
  newId?: (prefix: string) => string;
}

export type Handler<N extends OpName, I = unknown> = (input: I, ctx: OpContext, deps: PeopleDeps) => Promise<OpOutcome<OpOutput<N>>>;

export const err = (code: Extract<OpOutcome<never>, { status: 'error' }>['code'], message: string, issues?: unknown) =>
  ({ status: 'error', code, message, ...(issues === undefined ? {} : { issues }) }) as const;
