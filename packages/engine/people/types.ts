import type {
  AskFn,
  ContactTier,
  EventType,
  OpContext,
  OpName,
  OpOutcome,
  OpOutput,
  PolicyConfig,
  RecordFn,
  RunOp,
  SubjectType,
} from '@perfect-placement/contracts';
import type { Repos } from '../db/repo.js';
import type { GmailContactsSource, GmailDraftClient } from '../integrations/gmail/index.js';
import type { LinkedInSource } from '../integrations/linkedin/index.js';
import type { EmailProvider, MxResolver } from './email.js';

/** Text an LLM writes for one outreach draft. Never written by a System One model. */
export interface DraftText {
  subject: string;
  hook: string;
  proof: string;
  ask: string;
  /** Sign-off in the user's voice ("Thanks,\nAlex"). Optional: the default comes from Voice / Story. */
  signoff?: string;
}

export interface WriterPrompt {
  tier: ContactTier;
  system: string;
  user: string;
}

/** Outreach writer for runs without an agent session (EngineServices.outreachWriter). */
export interface OutreachWriter {
  write(prompt: WriterPrompt): Promise<DraftText>;
}

/**
 * Everything lane H handlers need, built per op call by the engine (packages/engine/ops/lanes/people.ts):
 * lane A repos, runOp's emitter + staged vault, this op's resolver, adapters per config.
 */
export interface PeopleDeps {
  repos: Repos;
  /** Staged vault (flushed when the op commits). */
  vault: { read(rel: string): string | null; write(rel: string, content: string): void };
  /** runOp's event writer. */
  emit(type: EventType, subjectType: SubjectType, subjectId: string, payload: Record<string, unknown>): string;
  /** Resolver `ask` (lane I). Writes decision rows and returns policy outcomes. */
  ask: AskFn;
  /** Resolver `record` (an externally judged answer through the policy). */
  record: RecordFn;
  config: PolicyConfig;
  linkedin?: LinkedInSource;
  gmail?: GmailDraftClient;
  gmailContacts?: GmailContactsSource;
  writer?: OutreachWriter;
  /** MX lookup for people.find_email (#37). Absent = not checked. Never SMTP. */
  mx?: MxResolver;
  /** Email finder service (#37, pinned): absent unless the user wires one with their own key. */
  emailProvider?: EmailProvider;
  /** runOp, nested in this op (#99: a manual email check resolves the decision through the decision layer). */
  runOp?: RunOp;
  /** Id factory; defaults to `<prefix>_<ulid>`. */
  newId?: (prefix: string) => string;
}

export type Handler<N extends OpName, I = unknown> = (input: I, ctx: OpContext, deps: PeopleDeps) => Promise<OpOutcome<OpOutput<N>>>;

export const err = (code: Extract<OpOutcome<never>, { status: 'error' }>['code'], message: string, issues?: unknown) =>
  ({ status: 'error', code, message, ...(issues === undefined ? {} : { issues }) }) as const;
