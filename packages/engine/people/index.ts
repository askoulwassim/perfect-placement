// Lane H owns this folder: contacts, contact_link, tier classification, outreach drafts.
import { classifyContact, linkContact } from './classify.js';
import { findPeople } from './find.js';
import { draftOutreach, outreachSendHandler, outreachToGmailHandler } from './outreach.js';

export const OWNER_LANE = 'H' as const;

/** Lane H op handlers, keyed by op name. Wave 2: lane B registers these in runOp with a PeopleDeps factory. */
export const handlers = {
  'people.find': findPeople,
  'people.link': linkContact,
  'people.classify': classifyContact,
  'outreach.draft': draftOutreach,
  'outreach.to_gmail': outreachToGmailHandler,
  'outreach.send': outreachSendHandler,
} as const;

export { CLASSIFY_INSTRUCTIONS, classifyContact, linkContact } from './classify.js';
export { findPeople, PeopleFindInput, PersonHint } from './find.js';
export { defaultNewId, ulid } from './ids.js';
export {
  type ComposeInput,
  composeAndDraft,
  draftContext,
  draftOutreach,
  outreachSendHandler,
  outreachToGmailHandler,
  readOutreachSections,
  renderOutreachMd,
} from './outreach.js';
export { isPicked, linkedinReadsOn, PICKED_STATUSES } from './repo.js';
export { BRIDGE_ASK_MAX, checkDraft, composeBody, LIMITS, type StyleIssue } from './style.js';
export { buildWriterPrompt, type DraftContext, TIER_TEMPLATES, type TierTemplate, templateDraft } from './templates.js';
export { HIRING_TEAM_ROLES, isHiringTeam, TIER_PRIORITY, tierFor } from './tier.js';
export type { DraftText, Handler, OutreachWriter, PeopleDeps, WriterPrompt } from './types.js';
