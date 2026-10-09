import { type ContactTier, type OpOutcome, OUTREACH_TONES } from '@perfect-placement/contracts';
import { classifyContact, linkContact } from '../../people/classify.js';
import { findPeople } from '../../people/find.js';
import { draftOutreach, outreachToGmailHandler, readOutreachSections, resolveDraft } from '../../people/outreach.js';
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
      return { outreach, contact, hook, proof, ask, subject: s.subject ?? null, signoff, body, variants };
    },
  }),
  'outreach.list': defineHandler('outreach.list', {
    run: (i, h) => ({ items: h.repos.outreach.select('role_id = ? ORDER BY id', [i.role_id]) }),
  }),
  'contacts.get': defineHandler('contacts.get', {
    run(i, h) {
      const contact = h.repos.contact.get(i.contact_id);
      if (!contact) throw notFound('contact', i.contact_id);
      return { contact, links: h.repos.contact_link.select('contact_id = ? ORDER BY id', [i.contact_id]) };
    },
  }),
} as const;
