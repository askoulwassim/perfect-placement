import {
  type ConnectPath,
  type Contact,
  type OpContext,
  type OpOutcome,
  type OpOutput,
  type Outreach,
  outreachDraft,
  outreachToGmail,
  vaultPath,
} from '@perfect-placement/contracts';
import { draftRecipient } from './email.js';
import { connectPathsFor, draftTierFor, draftTiersFor, PATH_TIER } from './path.js';
import {
  advanceConnectToFill,
  emitEvent,
  fallbackOf,
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
  coverExcerpt,
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

/** The role's tailored cover letter body (apply.tailor fact-checked it against the resume and Story), or null. */
function coverLetter(deps: PeopleDeps, roleId: string): string | null {
  const app = deps.repos.application.list({ role_id: roleId })[0];
  return vaultBody(deps, app?.package_paths_json.cover_letter ?? vaultPath.application(roleId, 'cover_letter'));
}

/**
 * Facts about the user a draft may state: Story, plus the cover letter for a no-contact fallback draft
 * (#78: a team inbox or cold leader draft is a shortened cover letter).
 */
const factsText = (deps: PeopleDeps, roleId: string, contactId: string): string => {
  const story = storyText(deps);
  if (!fallbackOf(deps.repos, roleId, contactId)) return story;
  const cover = coverLetter(deps, roleId);
  return cover ? `${story}\n${cover}` : story;
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
  // #98: a 2nd-degree hiring target may be drafted on either path (direct: cold_hiring, bridge: bridge),
  // never on a blocked bridge (the mutual has no email while the target is reachable).
  const allowed = link ? draftTiersFor(deps, link) : null;
  if (link && allowed && !allowed.includes(input.tier))
    return err(
      'invalid_input',
      connectPathsFor(deps, link)
        ? `tier ${input.tier} is not an open path for ${input.contact_id} (open: ${allowed.join(', ')}); a bridge to a mutual with no email is blocked while the target is reachable`
        : `tier ${input.tier} does not match the contact link tier ${link.tier}`,
    );
  if (input.tier === 'bridge' && !link?.via_contact_id)
    return err('invalid_input', 'bridge drafts need a contact_link with via_contact_id (the mutual)');

  const text: DraftText = {
    subject: input.subject ?? `${role.title}`,
    hook: input.hook,
    proof: input.proof,
    ask: input.ask,
    signoff: input.signoff ?? profileSignoff(deps),
  };
  const issues = checkDraft(text, factsText(deps, input.role_id, input.contact_id), {
    bridge: input.tier === 'bridge',
    context: contextText(deps, input.role_id, contact.headline),
  });
  if (issues.length)
    return err('invalid_input', `draft breaks writing rules: ${issues.map((i) => `${i.field} ${i.rule}`).join(', ')}`, issues);

  // #98: filed under the recipient. A bridge intro goes to the mutual, about the target.
  const bridge = input.tier === 'bridge';
  const recipientId = bridge ? (link?.via_contact_id as string) : input.contact_id;
  const aboutId = bridge ? input.contact_id : null;
  const prev = getOutreachFor(db, recipientId, input.role_id, aboutId);
  if (prev && prev.status !== 'drafted') return err('conflict', `outreach ${prev.id} is ${prev.status}; edit it in Gmail`);

  const id = prev?.id ?? newId(deps, 'or');
  const outreach: Outreach = {
    id,
    contact_id: recipientId,
    role_id: input.role_id,
    tier: input.tier,
    gmail_draft_id: null,
    status: 'drafted',
    md_path: prev?.md_path ?? vaultPath.outreach(recipientId, input.role_id, aboutId),
    about_contact_id: aboutId,
    gmail_to: null,
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
      payload: { contact_id: recipientId, about_contact_id: aboutId, role_id: input.role_id, tier: input.tier, redraft: Boolean(prev) },
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
 * Recipient: the contact, or the mutual for bridge drafts. To is set only when the address is confirmed
 * or at the `people.email` policy threshold (#37); otherwise the draft has no To and `to_reason` says why.
 * #99: while the address is a guess waiting in Needs you, the engine creates no draft (`conflict`); the
 * Gmail step is queued once it is confirmed. A draft the agent already made is still recorded (no To),
 * so the confirmation can fill its To. The To used is kept on `gmail_to`. Recording the same draft id
 * again on an `in_gmail` draft with no To (the To update step) stores the now confirmed To.
 */
export const outreachToGmailHandler: Handler<'outreach.to_gmail'> = async (raw, ctx, deps) => {
  const parsed = outreachToGmail.input.safeParse(raw);
  if (!parsed.success) return err('invalid_input', 'outreach.to_gmail input', parsed.error.issues);
  const { repos: db } = deps;
  const o = getOutreach(db, parsed.data.outreach_id);
  if (!o) return err('not_found', `outreach ${parsed.data.outreach_id}`);
  if (o.gmail_draft_id && o.status !== 'drafted') {
    // #99: the To update step re-records the same draft once its address is confirmed.
    const given = parsed.data.gmail_draft_id;
    if (given === o.gmail_draft_id && !o.gmail_to && o.status === 'in_gmail') {
      const recipient = gmailRecipient(deps, o);
      const to = recipient ? draftRecipient(deps, recipient) : null;
      if (to?.email) {
        const next: Outreach = { ...o, gmail_to: to.email };
        if (!ctx.dryRun) upsertOutreach(db, next, true);
        return { status: 'ok', output: { outreach: next, gmail_draft_id: given, to: to.email, to_reason: null }, eventIds: [] };
      }
    }
    return { status: 'ok', output: { outreach: o, gmail_draft_id: o.gmail_draft_id, to: o.gmail_to, to_reason: null }, eventIds: [] };
  }
  if (!o.md_path) return err('not_found', `outreach ${o.id} has no vault draft`);
  const md = readVault(deps, o.md_path);
  if (!md) return err('not_found', `vault draft ${o.md_path}`);

  const d = resolveDraft(deps, o, md);
  if ('error' in d) return err('not_found', d.error);
  const { text, recipient, body } = d;
  const issues = checkDraft(text, factsText(deps, o.role_id, d.target), { bridge: o.tier === 'bridge', context: d.context });
  if (issues.length)
    return err('invalid_input', `draft breaks writing rules: ${issues.map((i) => `${i.field} ${i.rule}`).join(', ')}`, issues);

  const given = parsed.data.gmail_draft_id;
  const to = draftRecipient(deps, recipient);
  // #99: never create a Gmail draft while its address is a guess waiting in Needs you.
  if (to.decision_id && !given)
    return err(
      'conflict',
      `${recipient.name}'s address is an unconfirmed guess (decision ${to.decision_id}): confirm it in Needs you; the Gmail draft is queued then`,
    );
  const toOut = { to: to.email, to_reason: to.reason };
  if (ctx.dryRun) return { status: 'ok', output: { outreach: o, gmail_draft_id: given ?? 'dry-run', ...toOut }, eventIds: [] };

  let draftId: string;
  if (given) draftId = given;
  else {
    if (!deps.gmail)
      return err(
        'backend_unavailable',
        'the engine has no Gmail client: start a Gmail-capable agent run (runs.start { skill: "connect", outreach_id }), which creates the draft with its own Gmail tool and records it here with gmail_draft_id',
      );
    try {
      draftId = (await deps.gmail.createDraft({ to: to.email, subject: text.subject, body })).draftId;
    } catch (e) {
      return err('backend_unavailable', `gmail: ${(e as Error).message}`);
    }
  }
  const next: Outreach = { ...o, gmail_draft_id: draftId, status: 'in_gmail', gmail_to: to.email };
  upsertOutreach(db, next, true);
  advanceConnectToFill(db, o.role_id);
  return { status: 'ok', output: { outreach: next, gmail_draft_id: draftId, ...toOut }, eventIds: [] };
};

/** The person an outreach is addressed to (the recipient row; an old bridge row: the link's mutual). */
export function gmailRecipient(deps: PeopleDeps, o: Outreach): Contact | undefined {
  const { repos: db } = deps;
  const legacy = TIER_TEMPLATES[o.tier].recipient === 'via' && !o.about_contact_id;
  const id = legacy ? getLinkForRole(db, o.contact_id, o.role_id)?.via_contact_id : o.contact_id;
  return id ? getContact(db, id) : undefined;
}

/**
 * The stored draft as it goes to Gmail: sections from the vault (the human may have edited them),
 * the subject fallback (role title at company), the sign-off (stored, else the profile default),
 * the recipient (the contact, or the mutual for bridge drafts) and the composed natural-email body.
 */
export function resolveDraft(
  deps: PeopleDeps,
  o: Outreach,
  md: string,
): { text: DraftText; body: string; recipient: Contact; target: string; context: string } | { error: string } {
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
  // #98: the outreach is filed under its recipient; a bridge intro names its target in about_contact_id.
  // A bridge row with no about is an old one filed under the target: its recipient is the link's mutual.
  const recipient = gmailRecipient(deps, o);
  if (!recipient) return { error: `recipient for outreach ${o.id}` };
  const targetId = o.about_contact_id ?? o.contact_id;
  const target = getContact(db, targetId);
  return {
    text,
    recipient,
    target: targetId,
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
  /** #98: draft this path for a 2nd-degree hiring target instead of the chosen one (both may exist). */
  path?: ConnectPath;
}

/** Builds the DraftContext for a contact on a role: db + CONTEXT (JD, dossier, headline) + Story + Voice. */
export function draftContext(deps: PeopleDeps, contactId: string, roleId: string, path?: ConnectPath): DraftContext | { error: string } {
  const contact = getContact(deps.repos, contactId);
  const role = getRole(deps.repos, roleId);
  const link = getLinkForRole(deps.repos, contactId, roleId);
  if (!contact || !role || !link) return { error: `contact ${contactId} is not linked to role ${roleId}` };
  const company = getCompany(deps.repos, role.company_id);
  const tier = path && connectPathsFor(deps, link) ? PATH_TIER[path] : draftTierFor(deps, link);
  // A direct note to a 2nd-degree target names no mutual (#98).
  const via = tier === 'bridge' && link.via_contact_id ? getContact(deps.repos, link.via_contact_id) : undefined;
  const story = getComponent(deps, 'story') ?? { data: {}, text: '' };
  const voice = getComponent(deps, 'voice') ?? { data: {}, text: '' };
  const ctx = roleContext(deps, roleId);
  const fallback = fallbackOf(deps.repos, roleId, contactId);
  return {
    tier,
    fallback,
    cover: fallback ? coverExcerpt(coverLetter(deps, roleId)) : null,
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
  const c = draftContext(deps, input.contact_id, input.role_id, input.path);
  if ('error' in c) return err('not_found', c.error);
  if (TIER_TEMPLATES[c.tier].skipByDefault && !input.force) return err('conflict', `tier ${c.tier} is skipped unless asked (force: true)`);
  const text = deps.writer ? await deps.writer.write(buildWriterPrompt(c)) : templateDraft(c);
  return draftOutreach({ contact_id: input.contact_id, role_id: input.role_id, tier: c.tier, ...text }, ctx, deps);
}
