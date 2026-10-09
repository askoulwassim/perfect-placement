import {
  type Contact,
  type ContactTier,
  type OpContext,
  type OpOutcome,
  type OpOutput,
  type Outreach,
  outreachDraft,
  outreachToGmail,
  vaultPath,
} from '@perfect-placement/contracts';
import {
  advanceConnectToFill,
  emitEvent,
  getCompany,
  getComponent,
  getContact,
  getLinkForRole,
  getOutreach,
  getOutreachFor,
  getRole,
  newId,
  readVault,
  stripFrontmatter,
  upsertOutreach,
  writeVault,
} from './queries.js';
import { checkDraft, composeBody, defaultSignoff } from './style.js';
import {
  buildWriterPrompt,
  type DraftContext,
  dossierHighlights,
  jdExcerpt,
  TIER_TEMPLATES,
  templateDraft,
  userName,
} from './templates.js';
import { type DraftText, err, type Handler, type PeopleDeps } from './types.js';

const storyText = (deps: PeopleDeps): string => {
  const story = getComponent(deps, 'story');
  return story ? `${JSON.stringify(story.data)}\n${story.text}` : '';
};

/** The default sign-off for this profile: Voice `signoff`, else "Thanks," + the Story name. */
const profileSignoff = (deps: PeopleDeps): string => {
  const voice = getComponent(deps, 'voice');
  const story = getComponent(deps, 'story');
  return defaultSignoff(voice?.data ?? {}, story ? userName(story) : null);
};

/** Vault markdown body (frontmatter stripped) for a role or a company dossier, or null. */
const vaultBody = (deps: PeopleDeps, rel: string | null | undefined): string | null => {
  if (!rel) return null;
  try {
    const md = readVault(deps, rel);
    return md ? stripFrontmatter(md) : null;
  } catch {
    return null;
  }
};

/** CONTEXT for a role: its JD and the company dossier highlights (facts about them, never the user). */
function roleContext(deps: PeopleDeps, roleId: string): { jd: string | null; dossier: string | null } {
  const role = getRole(deps.repos, roleId);
  if (!role) return { jd: null, dossier: null };
  const company = getCompany(deps.repos, role.company_id);
  return {
    jd: jdExcerpt(vaultBody(deps, role.md_path ?? vaultPath.role(role.id))),
    dossier: dossierHighlights(vaultBody(deps, company ? vaultPath.dossier(company.slug) : null)),
  };
}

/** CONTEXT text for the grounding check: numbers in the Hook may come from the JD, dossier or headline. */
const contextText = (deps: PeopleDeps, roleId: string, headline: string | null): string => {
  const c = roleContext(deps, roleId);
  return [c.jd, c.dossier, headline].filter(Boolean).join('\n');
};

const q = (s: string) => JSON.stringify(s);

/** Vault markdown for one draft. Frontmatter: id + type (structured fields live in the db). */
export function renderOutreachMd(id: string, d: DraftText): string {
  const signoff = d.signoff?.trim() ? `\n## Sign-off\n\n${d.signoff.trim()}\n` : '';
  return `---\nid: ${q(id)}\ntype: "outreach"\n---\n\n## Subject\n\n${d.subject.trim()}\n\n## Hook\n\n${d.hook.trim()}\n\n## Proof\n\n${d.proof.trim()}\n\n## Ask\n\n${d.ask.trim()}\n${signoff}`;
}

/** Reads the Hook / Proof / Ask long-form sections back for the Gmail body (the human may have edited them). */
export function readOutreachSections(md: string): Partial<DraftText> {
  const body = stripFrontmatter(md);
  const out: Partial<DraftText> = {};
  for (const part of body.split(/^## /m).slice(1)) {
    const nl = part.indexOf('\n');
    const head = part.slice(0, nl).trim().toLowerCase();
    const text = part.slice(nl + 1).trim();
    if (head === 'subject' || head === 'hook' || head === 'proof' || head === 'ask') out[head] = text;
    if (head === 'sign-off' || head === 'signoff') out.signoff = text;
  }
  return out;
}

/**
 * outreach.draft: validate (no em dashes, short blocks, Proof numbers grounded in Story), write the
 * vault draft, upsert the outreach row (status `drafted`), emit `outreach_drafted`.
 * Re-drafting is allowed only while the row is still `drafted` (a Gmail draft would go stale).
 */
export const draftOutreach: Handler<'outreach.draft'> = async (raw, ctx, deps) => {
  const parsed = outreachDraft.input.safeParse(raw);
  if (!parsed.success) return err('invalid_input', 'outreach.draft input', parsed.error.issues);
  const input = parsed.data;
  const { repos: db } = deps;

  const contact = getContact(db, input.contact_id);
  if (!contact) return err('not_found', `contact ${input.contact_id}`);
  const role = getRole(db, input.role_id);
  if (!role) return err('not_found', `role ${input.role_id}`);
  const link = getLinkForRole(db, input.contact_id, input.role_id);
  if (link && link.tier !== input.tier) return err('invalid_input', `tier ${input.tier} does not match the contact link tier ${link.tier}`);
  if (input.tier === 'bridge' && !link?.via_contact_id)
    return err('invalid_input', 'bridge drafts need a contact_link with via_contact_id (the mutual)');

  const text: DraftText = {
    subject: input.subject ?? `${role.title}`,
    hook: input.hook,
    proof: input.proof,
    ask: input.ask,
    signoff: input.signoff ?? profileSignoff(deps),
  };
  const issues = checkDraft(text, storyText(deps), {
    bridge: input.tier === 'bridge',
    context: contextText(deps, input.role_id, contact.headline),
  });
  if (issues.length)
    return err('invalid_input', `draft breaks writing rules: ${issues.map((i) => `${i.field} ${i.rule}`).join(', ')}`, issues);

  const prev = getOutreachFor(db, input.contact_id, input.role_id);
  if (prev && prev.status !== 'drafted') return err('conflict', `outreach ${prev.id} is ${prev.status}; edit it in Gmail`);

  const id = prev?.id ?? newId(deps, 'or');
  const outreach: Outreach = {
    id,
    contact_id: input.contact_id,
    role_id: input.role_id,
    tier: input.tier,
    gmail_draft_id: null,
    status: 'drafted',
    md_path: vaultPath.outreach(input.contact_id, input.role_id),
  };
  if (ctx.dryRun) return { status: 'ok', output: { outreach }, eventIds: [] };

  writeVault(deps, outreach.md_path as string, renderOutreachMd(id, text));
  const eventIds: string[] = [];
  upsertOutreach(db, outreach, Boolean(prev));
  eventIds.push(
    emitEvent(deps, {
      type: 'outreach_drafted',
      subject_type: 'outreach',
      subject_id: id,
      payload: { contact_id: input.contact_id, role_id: input.role_id, tier: input.tier, redraft: Boolean(prev) },
      actor: ctx.actor,
      ts: ctx.now().toISOString(),
    }),
  );
  return { status: 'ok', output: { outreach }, eventIds };
};

/**
 * outreach.to_gmail: create a Gmail DRAFT from the vault draft. Never sends.
 * Gmail via agent: with `gmail_draft_id`, the calling agent already created the draft with its own
 * Gmail tool (Claude Code: the Gmail connector); the engine records it and never calls a client.
 * Without it the engine's own Gmail client (absent by default) creates the draft.
 * Idempotent: an outreach already in Gmail returns its existing draft id.
 * Recipient: the contact, or the mutual for bridge drafts. No email on file = draft with no To.
 */
export const outreachToGmailHandler: Handler<'outreach.to_gmail'> = async (raw, ctx, deps) => {
  const parsed = outreachToGmail.input.safeParse(raw);
  if (!parsed.success) return err('invalid_input', 'outreach.to_gmail input', parsed.error.issues);
  const { repos: db } = deps;
  const o = getOutreach(db, parsed.data.outreach_id);
  if (!o) return err('not_found', `outreach ${parsed.data.outreach_id}`);
  if (o.gmail_draft_id && o.status !== 'drafted')
    return { status: 'ok', output: { outreach: o, gmail_draft_id: o.gmail_draft_id }, eventIds: [] };
  if (!o.md_path) return err('not_found', `outreach ${o.id} has no vault draft`);
  const md = readVault(deps, o.md_path);
  if (!md) return err('not_found', `vault draft ${o.md_path}`);

  const d = resolveDraft(deps, o, md);
  if ('error' in d) return err('not_found', d.error);
  const { text, recipient, body } = d;
  const issues = checkDraft(text, storyText(deps), { bridge: o.tier === 'bridge', context: d.context });
  if (issues.length)
    return err('invalid_input', `draft breaks writing rules: ${issues.map((i) => `${i.field} ${i.rule}`).join(', ')}`, issues);

  const given = parsed.data.gmail_draft_id;
  if (ctx.dryRun) return { status: 'ok', output: { outreach: o, gmail_draft_id: given ?? 'dry-run' }, eventIds: [] };

  let draftId: string;
  if (given) draftId = given;
  else {
    if (!deps.gmail)
      return err(
        'backend_unavailable',
        'the engine has no Gmail client: start a Gmail-capable agent run (runs.start { skill: "connect", outreach_id }), which creates the draft with its own Gmail tool and records it here with gmail_draft_id',
      );
    try {
      draftId = (await deps.gmail.createDraft({ to: recipient.email, subject: text.subject, body })).draftId;
    } catch (e) {
      return err('backend_unavailable', `gmail: ${(e as Error).message}`);
    }
  }
  const next: Outreach = { ...o, gmail_draft_id: draftId, status: 'in_gmail' };
  upsertOutreach(db, next, true);
  advanceConnectToFill(db, o.role_id);
  return { status: 'ok', output: { outreach: next, gmail_draft_id: draftId }, eventIds: [] };
};

/**
 * The stored draft as it goes to Gmail: sections from the vault (the human may have edited them),
 * the subject fallback (role title at company), the sign-off (stored, else the profile default),
 * the recipient (the contact, or the mutual for bridge drafts) and the composed natural-email body.
 */
export function resolveDraft(
  deps: PeopleDeps,
  o: Outreach,
  md: string,
): { text: DraftText; body: string; recipient: Contact; context: string } | { error: string } {
  const { repos: db } = deps;
  const s = readOutreachSections(md);
  const role = getRole(db, o.role_id);
  const company = role ? getCompany(db, role.company_id) : undefined;
  const fallbackSubject = role ? `${role.title}${company ? ` at ${company.name}` : ''}` : '';
  const text: DraftText = {
    subject: s.subject || fallbackSubject,
    hook: s.hook ?? '',
    proof: s.proof ?? '',
    ask: s.ask ?? '',
    signoff: s.signoff || profileSignoff(deps),
  };
  const recipientId =
    TIER_TEMPLATES[o.tier].recipient === 'via' ? getLinkForRole(db, o.contact_id, o.role_id)?.via_contact_id : o.contact_id;
  const recipient = recipientId ? getContact(db, recipientId) : undefined;
  if (!recipient) return { error: `recipient for outreach ${o.id}` };
  const target = getContact(db, o.contact_id);
  return {
    text,
    recipient,
    body: composeBody(text, { recipientName: recipient.name }),
    context: contextText(deps, o.role_id, target?.headline ?? null),
  };
}

/** outreach.send: intentionally unimplemented (AGENTS.md rule 4). The human sends from Gmail. */
export const outreachSendHandler: Handler<'outreach.send'> = async () =>
  err('unimplemented', 'outreach.send is not implemented in v2: open the Gmail draft and send it yourself');

// ------------------------------------------------------------- writer pipeline

export interface ComposeInput {
  contact_id: string;
  role_id: string;
  /** Draft a cold_other contact anyway (blueprint: skip unless asked). */
  force?: boolean;
}

/** Builds the DraftContext for a contact on a role: db + CONTEXT (JD, dossier, headline) + Story + Voice. */
export function draftContext(deps: PeopleDeps, contactId: string, roleId: string): DraftContext | { error: string } {
  const contact = getContact(deps.repos, contactId);
  const role = getRole(deps.repos, roleId);
  const link = getLinkForRole(deps.repos, contactId, roleId);
  if (!contact || !role || !link) return { error: `contact ${contactId} is not linked to role ${roleId}` };
  const company = getCompany(deps.repos, role.company_id);
  const via = link.via_contact_id ? getContact(deps.repos, link.via_contact_id) : undefined;
  const story = getComponent(deps, 'story') ?? { data: {}, text: '' };
  const voice = getComponent(deps, 'voice') ?? { data: {}, text: '' };
  const ctx = roleContext(deps, roleId);
  return {
    tier: link.tier as ContactTier,
    contact: { name: contact.name, headline: contact.headline },
    via: via ? { name: via.name, headline: via.headline } : null,
    role: { title: role.title, jd: ctx.jd },
    company: { name: company?.name ?? role.company_id, dossier: ctx.dossier },
    story,
    voice,
  };
}

/**
 * Writer pipeline for scheduled runs and agents without their own LLM: tier template + Story + Voice
 * -> LLM writer (or the deterministic template when none is wired) -> outreach.draft (validated).
 */
export async function composeAndDraft(
  deps: PeopleDeps,
  input: ComposeInput,
  ctx: OpContext,
): Promise<OpOutcome<OpOutput<'outreach.draft'>>> {
  const c = draftContext(deps, input.contact_id, input.role_id);
  if ('error' in c) return err('not_found', c.error);
  if (TIER_TEMPLATES[c.tier].skipByDefault && !input.force) return err('conflict', `tier ${c.tier} is skipped unless asked (force: true)`);
  const text = deps.writer ? await deps.writer.write(buildWriterPrompt(c)) : templateDraft(c);
  return draftOutreach({ contact_id: input.contact_id, role_id: input.role_id, tier: c.tier, ...text }, ctx, deps);
}
