// Lane H owns this folder: contacts, contact_link, tier classification, outreach drafts.
import { classifyContact, linkContact } from './classify.js';
import { findEmail } from './email.js';
import { fallbackPeople } from './fallback.js';
import { findPeople } from './find.js';
import { draftOutreach, outreachSendHandler, outreachToGmailHandler } from './outreach.js';

export const OWNER_LANE = 'H' as const;

/** Lane H op handlers, keyed by op name. The engine registers them (ops/lanes/people.ts) with a PeopleDeps per call. */
export const handlers = {
  'people.find': findPeople,
  'people.link': linkContact,
  'people.classify': classifyContact,
  'people.find_email': findEmail,
  'people.fallback': fallbackPeople,
  'outreach.draft': draftOutreach,
  'outreach.to_gmail': outreachToGmailHandler,
  'outreach.send': outreachSendHandler,
} as const;

export { CLASSIFY_INSTRUCTIONS, classifyContact, linkContact } from './classify.js';
export {
  cleanDomain,
  dossierDomain,
  draftRecipient,
  EMAIL_PATTERNS,
  type EmailPattern,
  type EmailProvider,
  emailsIn,
  findEmail,
  KNOWN_CONFIDENCE,
  learnFormat,
  localFor,
  type MxResolver,
  nameParts,
  PATTERN_PRIOR,
  PeopleFindEmailInput,
  patternsOf,
  rankCandidates,
} from './email.js';
export { atDomain, fallbackPeople, pickTeamInbox, TEAM_INBOX_NAME, TEAM_MAILBOXES, teamMailboxRank } from './fallback.js';
export { findPeople, PeopleFindInput, PersonHint } from './find.js';
export {
  type ComposeInput,
  composeAndDraft,
  draftContext,
  draftOutreach,
  outreachSendHandler,
  outreachToGmailHandler,
  readOutreachSections,
  renderOutreachMd,
  resolveDraft,
} from './outreach.js';
export {
  CONNECT_FALLBACK_OPS,
  connectStateFor,
  fallbackOf,
  isPicked,
  linkedinReadsOn,
  PICKED_STATUSES,
  recordConnectFallback,
  skipConnect,
} from './queries.js';
export {
  BRIDGE_ASK_MAX,
  type CheckOptions,
  checkDraft,
  composeBody,
  defaultSignoff,
  LIMITS,
  PROOF_MAX_SENTENCES,
  type StyleIssue,
  sentenceCount,
  splitGreeting,
} from './style.js';
export {
  buildWriterPrompt,
  COVER_MAX_CHARS,
  coverExcerpt,
  coverProof,
  DOSSIER_MAX_CHARS,
  type DraftContext,
  dossierHighlights,
  FALLBACK_TEMPLATES,
  JD_MAX_CHARS,
  jdExcerpt,
  jdTheme,
  storyProof,
  TIER_TEMPLATES,
  type TierTemplate,
  templateDraft,
  userName,
  voiceNotes,
  voiceSamples,
} from './templates.js';
export { HIRING_TEAM_ROLES, isHiringTeam, TIER_PRIORITY, tierFor } from './tier.js';
export type { DraftText, Handler, OutreachWriter, PeopleDeps, WriterPrompt } from './types.js';
