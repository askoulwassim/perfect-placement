import { INBOX_CLASSES, type InboxClass, type Role, type RoleStatus } from '@perfect-placement/contracts';
import { checkTransition } from '../../status/index.js';
import { newId } from '../ids.js';
import { get, insert, select, update } from '../rows.js';
import { defineHandler, type HandlerContext, type HandlerInput } from '../runtime.js';
import { appendRoleLog, moveRole, undoMove, upsertApplication } from './shared.js';

/*
 * inbox.ingest: v1 monitor.py mechanics. The skill classifies Gmail (read-only) and
 * supplies `class` + `p` per message; this op applies the confidence x impact policy
 * per message (medium impact; config gives confident classifications a 24h undo, wave1-decisions #16), then moves roles:
 *   confirmation -> applied, interview_request -> interviews, offer -> offers,
 *   rejection -> archived (rejected), outreach_reply -> outreach replied.
 * No-downgrade: a confirmation never pulls a role back from interviews; rejection always archives.
 * A confirmation revives an archived role to applied (#16); the decision's undo restores the archive.
 */

type Message = HandlerInput<'inbox.ingest'>['messages'][number];

export const INBOX_TARGET: Partial<Record<InboxClass, RoleStatus>> = {
  confirmation: 'applied',
  interview_request: 'interviews',
  offer: 'offers',
  rejection: 'archived',
};

function alreadyHandled(h: HandlerContext, messageId: string): boolean {
  return (
    h.db
      .prepare(`SELECT 1 FROM event WHERE type = 'inbox_classified' AND json_extract(payload_json, '$.message_id') = ? LIMIT 1`)
      .get(messageId) !== undefined
  );
}

function pendingDecision(h: HandlerContext, messageId: string): string | null {
  const row = h.db
    .prepare(
      `SELECT id FROM decision WHERE kind = 'inbox.classify' AND status = 'pending' AND json_extract(question_json, '$.message_id') = ? LIMIT 1`,
    )
    .get(messageId) as { id: string } | undefined;
  return row?.id ?? null;
}

/** Apply one message's effect. Returns the new status (null when nothing moved). */
function applyMessage(h: HandlerContext, m: Message, role: Role | null, decisionId: string | null): RoleStatus | null {
  const payload = { message_id: m.message_id, thread_id: m.thread_id ?? null, class: m.class, p: m.p, received_at: m.received_at };

  if (m.class === 'outreach_reply') {
    const outreach = m.outreach_id ? get(h.db, 'outreach', m.outreach_id) : null;
    if (!outreach) return null;
    update(h.db, 'outreach', outreach.id, { status: 'replied' });
    h.emit('inbox_classified', 'outreach', outreach.id, payload, decisionId);
    h.emit('outreach_replied', 'outreach', outreach.id, { message_id: m.message_id, role_id: outreach.role_id }, decisionId);
    return null;
  }
  if (!role) return null;
  const target = INBOX_TARGET[m.class] as RoleStatus;
  const from = role.status;
  const check = checkTransition({
    from,
    to: target,
    actor: h.ctx.actor,
    via: 'inbox',
    ...(target === 'archived' ? { archiveReason: 'rejected' as const } : {}),
  });
  h.emit(
    'inbox_classified',
    'role',
    role.id,
    { ...payload, from, to: check.ok ? target : null, ...(check.ok ? {} : { skipped: check.message }) },
    decisionId,
  );

  // Side records that hold even when the status does not change (a second-round invite).
  if (m.class === 'confirmation') {
    const existing = select(h.db, 'application', 'role_id = ?', [role.id])[0];
    upsertApplication(h, role.id, { applied_at: existing?.applied_at ?? m.received_at, stage: 'done' });
  }
  if (m.class === 'interview_request') {
    const round = (h.db.prepare('SELECT coalesce(max(round), 0) n FROM interview WHERE role_id = ?').get(role.id) as { n: number }).n + 1;
    const id = newId('interview', h.ctx.now());
    insert(h.db, 'interview', {
      id,
      role_id: role.id,
      round,
      at: m.interview_at ?? null,
      prep_path: null,
      retro_path: null,
      outcome: 'pending',
    });
    h.emit(
      'interview_scheduled',
      'role',
      role.id,
      { interview_id: id, round, at: m.interview_at ?? null, message_id: m.message_id },
      decisionId,
    );
  }
  if (m.class === 'offer') h.emit('offer', 'role', role.id, { message_id: m.message_id, stage: from }, decisionId);
  if (m.class === 'rejection') h.emit('rejection', 'role', role.id, { message_id: m.message_id, stage: from }, decisionId);

  if (!check.ok) {
    appendRoleLog(h, role, `${m.class} (no move: ${check.message})`);
    return null;
  }
  moveRole(h, role, target, {
    via: 'inbox',
    ...(target === 'archived' ? { archiveReason: 'rejected' as const } : {}),
    note: m.class,
    decisionId,
    payload: { message_id: m.message_id },
  });
  return target;
}

export const inboxIngest = defineHandler('inbox.ingest', {
  selfGated: true,
  async run(input, h) {
    const applied: { message_id: string; role_id: string | null; to: RoleStatus | null }[] = [];
    const queued: { message_id: string; decision_id: string }[] = [];
    const ignored: string[] = [];
    const lines: string[] = [];
    const approved = h.ctx.actor === 'human' || Boolean(h.ctx.decisionId);

    for (const m of input.messages) {
      const role = m.role_id ? get(h.db, 'role', m.role_id) : null;
      const actionable =
        m.class !== 'other' &&
        (m.class === 'outreach_reply' ? Boolean(m.outreach_id && get(h.db, 'outreach', m.outreach_id)) : Boolean(role));
      if (!actionable || alreadyHandled(h, m.message_id)) {
        ignored.push(m.message_id);
        lines.push(
          `- ${m.message_id}: ignored (${!actionable ? `${m.class}, no matching ${m.class === 'outreach_reply' ? 'outreach' : 'role'}` : 'already handled'})`,
        );
        continue;
      }

      let decisionId: string | null = h.ctx.decisionId ?? null;
      if (!approved) {
        const pending = pendingDecision(h, m.message_id);
        if (pending) {
          queued.push({ message_id: m.message_id, decision_id: pending });
          lines.push(`- ${m.message_id}: already waiting on ${pending}`);
          continue;
        }
        const subject =
          m.class === 'outreach_reply'
            ? { type: 'outreach' as const, id: m.outreach_id as string }
            : { type: 'role' as const, id: role?.id as string };
        // Undo restores the exact prior status when the message moves the role.
        const target = role ? INBOX_TARGET[m.class] : undefined;
        const moves =
          role &&
          target &&
          checkTransition({
            from: role.status,
            to: target,
            actor: h.ctx.actor,
            via: 'inbox',
            ...(target === 'archived' ? { archiveReason: 'rejected' as const } : {}),
          }).ok;
        const r = await h.resolver.record(
          {
            decision: 'inbox.classify',
            impact: 'medium',
            subject,
            question: {
              id: 'class',
              type: 'choice',
              instructions: 'What is this email?',
              options: [...INBOX_CLASSES],
              message_id: m.message_id,
              thread_id: m.thread_id ?? null,
            },
            answer: { id: 'class', value: m.class, p: m.p },
            backend: h.ctx.confidence?.backend ?? 'agent',
            action: {
              op: 'inbox.ingest',
              input: { messages: [m] },
              ...(moves && role ? { undo: undoMove(role) } : {}),
            },
          },
          { actor: h.ctx.actor },
        );
        if (r.outcome === 'human') {
          queued.push({ message_id: m.message_id, decision_id: r.decisionId });
          lines.push(`- ${m.message_id}: ${m.class} (p ${m.p}) -> Needs you (${r.decisionId})`);
          continue;
        }
        decisionId = r.decisionId;
      }

      const to = applyMessage(h, m, role, decisionId);
      applied.push({ message_id: m.message_id, role_id: role?.id ?? null, to });
      lines.push(
        `- ${m.message_id}: ${m.class} ${role ? `${role.id} ${role.status} -> ${to ?? '(no move)'}` : `outreach ${m.outreach_id} replied`}`,
      );
    }

    h.runLog({
      title: 'inbox.ingest',
      summary: { messages: input.messages.length, applied: applied.length, queued: queued.length, ignored: ignored.length },
      lines: [
        `Messages: ${input.messages.length}, applied: ${applied.length}, queued: ${queued.length}, ignored: ${ignored.length}`,
        '',
        ...lines,
      ],
    });
    return { applied, queued, ignored };
  },
});
