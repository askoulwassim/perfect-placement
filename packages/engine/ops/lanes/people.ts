import { type ContactTier, type OpOutcome, OUTREACH_TONES } from '@perfect-placement/contracts';
import { classifyContact, linkContact } from '../../people/classify.js';
import { defaultMx } from '../../people/dns.js';
import { draftRecipient, findEmail } from '../../people/email.js';
import { fallbackPeople } from '../../people/fallback.js';
import { findPeople } from '../../people/find.js';
import { draftOutreach, outreachToGmailHandler, readOutreachSections, resolveDraft } from '../../people/outreach.js';
import { setPath } from '../../people/path.js';
import { composeBody } from '../../people/style.js';
import { TIER_TEMPLATES } from '../../people/templates.js';
import type { PeopleDeps } from '../../people/types.js';
import { notFound, OpError } from '../errors.js';
import { defineHandler, type HandlerContext, requiresHuman } from '../runtime.js';

/*
 * Lane H wiring: people.* and outreach.* with PeopleDeps built from the op context (lane A repos,
 * runOp's emitter + staged vault, this op's resolver, the adapters in EngineServices), plus the read
 * ops outreach.get / outreach.list / contacts.get. outreach.send has no handler: it is unimplemented
 * by contract (the human sends from Gmail).
 */

export function peopleDeps(h: HandlerContext): PeopleDeps {
  return {
    repos: h.repos,
    vault: { read: (rel) => h.vault.read(rel), write: (rel, content) => h.vault.write(rel, content) },
    emit: (type, subjectType, subjectId, payload) => h.emit(type, subjectType, subjectId, payload),
    ask: (req) => h.resolver.ask(req, { actor: h.ctx.actor }),
    record: (req) => h.resolver.record(req, { actor: h.ctx.actor }),
    config: h.config,
    ...(h.services.linkedin ? { linkedin: h.services.linkedin } : {}),
    ...(h.services.gmail ? { gmail: h.services.gmail } : {}),
    ...(h.services.gmailContacts ? { gmailContacts: h.services.gmailContacts } : {}),
    ...(h.services.outreachWriter ? { writer: h.services.outreachWriter } : {}),
    mx: h.services.mx ?? defaultMx,
    ...(h.services.emailProvider ? { emailProvider: h.services.emailProvider } : {}),
  };
}

function unwrap<O>(o: OpOutcome<O>) {
  if (o.status === 'ok') return o.output;
  if (o.status === 'requires_human') return requiresHuman(o.decisionId);
  throw new OpError(o.code, o.message, o.issues);
}

/** The tier whose template carries each tone (the Outreach screen's chips switch text locally). */
const TONE_TIER: Record<(typeof OUTREACH_TONES)[number], ContactTier> = {
  'Ask for the conversation': 'warm_hiring',
  'Coffee or intro': 'warm_other',
  'Forwardable blurb': 'bridge',
  'Positioning note': 'cold_hiring',
};

export const LANE_H_HANDLERS = {
  'people.find': defineHandler('people.find', { run: async (i, h) => unwrap(await findPeople(i, h.ctx, peopleDeps(h))) }),
  'people.link': defineHandler('people.link', { run: async (i, h) => unwrap(await linkContact(i, h.ctx, peopleDeps(h))) }),
  'people.classify': defineHandler('people.classify', { run: async (i, h) => unwrap(await classifyContact(i, h.ctx, peopleDeps(h))) }),
  'people.find_email': defineHandler('people.find_email', { run: async (i, h) => unwrap(await findEmail(i, h.ctx, peopleDeps(h))) }),
  'people.fallback': defineHandler('people.fallback', { run: async (i, h) => unwrap(await fallbackPeople(i, h.ctx, peopleDeps(h))) }),
  'people.set_path': defineHandler('people.set_path', { run: async (i, h) => unwrap(await setPath(i, h.ctx, peopleDeps(h))) }),
  'outreach.draft': defineHandler('outreach.draft', { run: async (i, h) => unwrap(await draftOutreach(i, h.ctx, peopleDeps(h))) }),
  'outreach.to_gmail': defineHandler('outreach.to_gmail', {
    decisionKind: 'outreach.to_gmail',
    subject: (i) => ({ type: 'outreach', id: i.outreach_id }),
    run: async (i, h) => unwrap(await outreachToGmailHandler(i, h.ctx, peopleDeps(h))),
  }),
  'outreach.get': defineHandler('outreach.get', {
    run(i, h) {
      const outreach = h.repos.outreach.get(i.outreach_id);
      if (!outreach) throw notFound('outreach', i.outreach_id);
      const contact = h.repos.contact.get(outreach.contact_id);
      if (!contact) throw notFound('contact', outreach.contact_id);
      const md = outreach.md_path ? h.vault.read(outreach.md_path) : null;
      const s = md ? readOutreachSections(md) : {};
      const hook = s.hook ?? '';
      const proof = s.proof ?? '';
      const ask = s.ask ?? '';
      const variants = OUTREACH_TONES.map((tone) => {
        const tier = TONE_TIER[tone];
        return { hook, proof, ask: tier === outreach.tier ? ask : TIER_TEMPLATES[tier].ask };
      });
      // Sign-off and body exactly as outreach.to_gmail composes them (the agent's Gmail step uses `body`).
      const d = md ? resolveDraft(peopleDeps(h), outreach, md) : null;
      const signoff = d && !('error' in d) ? (d.text.signoff ?? '') : (s.signoff ?? '');
      const body = d && !('error' in d) ? d.body : composeBody({ hook, proof, ask, signoff }, { recipientName: contact.name });
      // #37: the To the Gmail step uses (the contact, or the mutual for bridge drafts), or why there is none.
      const rc = d && !('error' in d) ? d.recipient : contact;
      const r = draftRecipient(peopleDeps(h), rc);
      const to = {
        contact_id: rc.id,
        name: rc.name,
        email: r.email,
        email_source: rc.email_source,
        email_confidence: rc.email_confidence,
        guess: r.guess,
        reason: r.reason,
      };
      // #98: the target a bridge intro is about (the outreach itself is filed under its recipient).
      const about = outreach.about_contact_id ? (h.repos.contact.get(outreach.about_contact_id) ?? null) : null;
      return { outreach, contact, hook, proof, ask, subject: s.subject ?? null, signoff, body, variants, to, about };
    },
  }),
  'outreach.list': defineHandler('outreach.list', {
    run(i, h) {
      // #98: one draft per recipient; each names its recipient and, for a bridge intro, the target.
      const name = (id: string | null) => (id ? (h.repos.contact.get(id)?.name ?? null) : null);
      return {
        items: h.repos.outreach
          .select('role_id = ? ORDER BY id', [i.role_id])
          .map((o) => ({ ...o, recipient_name: name(o.contact_id) ?? '', about_name: name(o.about_contact_id) })),
      };
    },
  }),
  'contacts.get': defineHandler('contacts.get', {
    run(i, h) {
      const contact = h.repos.contact.get(i.contact_id);
      if (!contact) throw notFound('contact', i.contact_id);
      return { contact, links: h.repos.contact_link.select('contact_id = ? ORDER BY id', [i.contact_id]) };
    },
  }),
} as const;
