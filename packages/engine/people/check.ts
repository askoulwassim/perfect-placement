import { type Contact, type Decision, type EmailCandidate, OTHER_OPTION, peopleEmailChecked } from '@perfect-placement/contracts';
import { draftRecipient, isKnownSource, pendingEmailDecision } from './email.js';
import { getContact } from './queries.js';
import { err, type Handler } from './types.js';

/*
 * people.email_checked (#99): the user's own check of a candidate address. Perfect Placement never
 * contacts a mail server or a verification website; the Needs you card links to one the user opens
 * themselves, then **Valid** or **Invalid** records what they saw (source `manual_check`).
 */

type Question = {
  instructions?: string;
  name?: string;
  options?: string[];
  candidates?: EmailCandidate[];
  dropped?: string[];
  manual_checks?: Array<{ address: string; result: string; source: 'manual_check'; at: string }>;
};

export const emailChecked: Handler<'people.email_checked'> = async (raw, ctx, deps) => {
  const parsed = peopleEmailChecked.input.safeParse(raw);
  if (!parsed.success) return err('invalid_input', 'people.email_checked input', parsed.error.issues);
  const { contact_id, result } = parsed.data;
  const address = parsed.data.address.trim().toLowerCase();
  if (ctx.actor !== 'human') return err('human_only', 'only a human records an email check');
  const db = deps.repos;
  const contact = getContact(db, contact_id);
  if (!contact) return err('not_found', `contact ${contact_id}`);
  if (!deps.runOp) return err('backend_unavailable', 'people.email_checked needs runOp');
  const now = ctx.now().toISOString();

  const decisionId = pendingEmailDecision(deps, contact.id);
  const d = decisionId ? (db.decision.get(decisionId) as Decision | undefined) : undefined;
  const q = (d?.question_json ?? {}) as Question;
  const mark = { address, result, source: 'manual_check' as const, at: now };

  const out = (c: Contact, open: boolean, remaining: string[]) => ({
    status: 'ok' as const,
    output: {
      contact: c,
      result,
      source: 'manual_check' as const,
      decision_id: decisionId,
      open,
      remaining,
      confirmed: draftRecipient(deps, c).confirmed,
    },
    eventIds: [],
  });

  if (result === 'valid') {
    // Recorded on the decision, then resolved with this address through the decision layer: the decision's
    // action (people.find_email with the pick) confirms it and queues the Gmail drafts that waited for it.
    if (d) db.decision.update(d.id, { question_json: { ...q, manual_checks: [...(q.manual_checks ?? []), mark] } });
    const r = d
      ? await deps.runOp('decisions.resolve', { decision_id: d.id, action: 'change', value: address }, ctx)
      : await deps.runOp('people.find_email', { contact_id: contact.id, value: address }, ctx);
    if (r.status === 'error') return err(r.code, r.message, r.issues);
    if (r.status !== 'ok') return err('conflict', 'the address was not confirmed');
    const opStatus = (r.output as { op_status?: string }).op_status;
    if (opStatus && opStatus !== 'ok') return err('conflict', `the address was not confirmed (${opStatus})`);
    return out(getContact(db, contact.id) as Contact, false, []);
  }

  // Invalid: drop the candidate. The decision stays open while others remain.
  const clear = contact.email === address && !isKnownSource(contact.email_source);
  if (!d) {
    if (clear) db.contact.update(contact.id, { email: null, email_source: null, email_confidence: null });
    return out(getContact(db, contact.id) as Contact, false, []);
  }
  const candidates = (q.candidates ?? []).filter((c) => c.email.toLowerCase() !== address);
  const remaining = (q.options ?? []).filter((o) => o !== OTHER_OPTION && o.toLowerCase() !== address);
  const question: Question = {
    ...q,
    options: [...remaining, OTHER_OPTION],
    candidates,
    dropped: [...new Set([...(q.dropped ?? []), address])],
    manual_checks: [...(q.manual_checks ?? []), mark],
  };
  const top = candidates.find((c) => remaining.includes(c.email)) ?? (remaining[0] ? { email: remaining[0], p: 0 } : undefined);
  if (!top) {
    db.decision.update(d.id, { question_json: question, status: 'rejected', resolved_at: now });
    if (clear) db.contact.update(contact.id, { email: null, email_source: null, email_confidence: null });
    return out(getContact(db, contact.id) as Contact, false, []);
  }
  db.decision.update(d.id, {
    question_json: { ...question, instructions: `Use ${top.email} for ${q.name ?? contact.name}?` },
    answer_json: { ...(d.answer_json as Record<string, unknown>), value: top.email, p: top.p },
    p: top.p,
  });
  if (clear) db.contact.update(contact.id, { email: top.email, email_source: 'pattern', email_confidence: top.p });
  return out(getContact(db, contact.id) as Contact, true, remaining);
};
