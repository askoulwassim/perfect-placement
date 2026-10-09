import {
  type AutoGroupHints,
  type Decision,
  type EventType,
  groupAutoDecisions,
  OPS,
  type OpContext,
  type OpErrorCode,
  type OpOutcome,
  type OpOutput,
  type RunOp,
} from '@perfect-placement/contracts';
import { actionApplies, coerceValue, parseAction, substituteValue } from './actions.js';
import { newEventId } from './ids.js';
import { canUndo } from './policy.js';
import type { DecisionStore } from './store.js';

/*
 * Handlers for decisions.queue / decisions.resolve / decisions.undo (registry owner: lane I).
 * They take an injected store and an injected RunOp (lane B's runOp is wired in Wave 2).
 * Each returns an OpOutcome so runOp can pass it straight through.
 */

export interface DecisionOpsDeps {
  store: DecisionStore;
  runOp: RunOp;
  /** #103: run ids and score totals for the auto-stream groups (the engine reads them from its db). */
  groupHints?: AutoGroupHints;
}

type Handler<N extends 'decisions.queue' | 'decisions.resolve' | 'decisions.undo' | 'decisions.undo_group'> = (
  input: unknown,
  ctx: OpContext,
) => Promise<OpOutcome<OpOutput<N>>>;

export interface DecisionOps {
  'decisions.queue': Handler<'decisions.queue'>;
  'decisions.resolve': Handler<'decisions.resolve'>;
  'decisions.undo': Handler<'decisions.undo'>;
  'decisions.undo_group': Handler<'decisions.undo_group'>;
}

const DAY_MS = 86_400_000;

export function createDecisionOps(deps: DecisionOpsDeps): DecisionOps {
  const { store } = deps;

  function emit(type: EventType, d: Decision, ctx: OpContext, payload: Record<string, unknown>): string {
    const id = newEventId(ctx.now().getTime());
    store.appendEvent({
      id,
      ts: ctx.now().toISOString(),
      type,
      subject_type: 'decision',
      subject_id: d.id,
      payload_json: { kind: d.kind, subject_type: d.subject_type, subject_id: d.subject_id, ...payload },
      actor: ctx.actor,
      decision_id: d.id,
    });
    return id;
  }

  const queue: Handler<'decisions.queue'> = async (raw, ctx) => {
    const parsed = OPS['decisions.queue'].input.safeParse(raw);
    if (!parsed.success) return { status: 'error', code: 'invalid_input', message: 'invalid input', issues: parsed.error.issues };
    const since = parsed.data.include_auto_since ?? new Date(ctx.now().getTime() - DAY_MS).toISOString();
    const pending = store.list({ statuses: parsed.data.status ?? ['pending'], outcomes: ['human'] });
    const recent_auto = store.list({ excludeOutcomes: ['human'], since });
    const auto_groups = groupAutoDecisions(recent_auto, ctx.now(), deps.groupHints);
    return { status: 'ok', output: { pending, recent_auto, auto_groups }, eventIds: [] };
  };

  const resolve: Handler<'decisions.resolve'> = async (raw, ctx) => {
    const parsed = OPS['decisions.resolve'].input.safeParse(raw);
    if (!parsed.success) return { status: 'error', code: 'invalid_input', message: 'invalid input', issues: parsed.error.issues };
    const { decision_id, action, value } = parsed.data;
    const d = store.get(decision_id);
    if (!d) return { status: 'error', code: 'not_found', message: `decision ${decision_id} not found` };
    if (d.status !== 'pending') return { status: 'error', code: 'conflict', message: `decision is ${d.status}` };
    // Only a human resolves medium or high impact decisions. Agents may clear low-impact items.
    if (ctx.actor !== 'human' && d.impact !== 'low') {
      return { status: 'error', code: 'human_only', message: `${d.impact} impact decisions are resolved by a human` };
    }
    const nowIso = ctx.now().toISOString();

    if (action === 'skip') {
      const updated = store.update(d.id, { status: 'rejected', resolved_at: nowIso });
      const ev = emit('decision_made', updated, ctx, { action: 'skip' });
      return { status: 'ok', output: { decision: updated, op_status: 'skipped' }, eventIds: [ev] };
    }

    if (action === 'change' && value === undefined) {
      return { status: 'error', code: 'invalid_input', message: "action 'change' needs a value" };
    }
    const picked = (d.answer_json as { value?: unknown }).value;
    const finalValue = coerceValue(
      d.question_json,
      action === 'change' ? (value as string | number | boolean) : (picked as string | number | boolean),
    );
    const overridden = action === 'change' && String(finalValue) !== String(picked);

    let opStatus: 'ok' | 'requires_human' | 'error' | 'skipped' = 'skipped';
    const act = parseAction(d.action_json);
    if (act && actionApplies(act, finalValue)) {
      const out = await deps.runOp(act.op, substituteValue(act.input, finalValue), { ...ctx, decisionId: d.id });
      opStatus = out.status;
      if (out.status !== 'ok') {
        // Leave it pending so the human can retry; report what happened.
        const current = store.get(d.id) as Decision;
        return { status: 'ok', output: { decision: current, op_status: opStatus }, eventIds: [] };
      }
    }

    const updated = store.update(d.id, { status: 'applied', resolved_at: nowIso, human_choice: String(finalValue), overridden });
    const eventIds = [
      emit(overridden ? 'decision_overridden' : 'decision_made', updated, ctx, { action, value: finalValue, picked, p: d.p }),
    ];
    return { status: 'ok', output: { decision: updated, op_status: opStatus }, eventIds };
  };

  /** Undo one decision: the inverse op (if any) through runOp, then mark it undone. */
  async function undoOne(
    d: Decision,
    ctx: OpContext,
  ): Promise<{ ok: true; decision: Decision; eventId: string } | { ok: false; code: OpErrorCode; message: string }> {
    if (!canUndo(d, ctx.now())) {
      return {
        ok: false,
        code: 'conflict',
        message: d.policy_outcome !== 'auto_undo' ? 'not an auto + undo decision' : 'undo window closed or already undone',
      };
    }
    const act = parseAction(d.action_json);
    if (act?.undo) {
      const out = await deps.runOp(act.undo.op, act.undo.input, { ...ctx, decisionId: d.id });
      if (out.status !== 'ok') {
        return { ok: false, code: out.status === 'error' ? out.code : 'conflict', message: `undo op ${act.undo.op} did not run` };
      }
    }
    const updated = store.update(d.id, { status: 'undone', resolved_at: ctx.now().toISOString() });
    const eventId = emit('decision_undone', updated, ctx, { undo_op: act?.undo?.op ?? null });
    return { ok: true, decision: updated, eventId };
  }

  const undo: Handler<'decisions.undo'> = async (raw, ctx) => {
    const parsed = OPS['decisions.undo'].input.safeParse(raw);
    if (!parsed.success) return { status: 'error', code: 'invalid_input', message: 'invalid input', issues: parsed.error.issues };
    const d = store.get(parsed.data.decision_id);
    if (!d) return { status: 'error', code: 'not_found', message: `decision ${parsed.data.decision_id} not found` };
    const r = await undoOne(d, ctx);
    if (!r.ok) return { status: 'error', code: r.code, message: r.message };
    return { status: 'ok', output: { decision: r.decision }, eventIds: [r.eventId] };
  };

  /**
   * #103: undo a group's members in one call. Each goes through the same rules as `decisions.undo`
   * (auto + undo only, so hard exclusions never qualify; the inverse op keeps its own no-downgrade checks);
   * the ones that cannot be undone are skipped with a reason. Nothing undone at all is a conflict.
   */
  const undoGroup: Handler<'decisions.undo_group'> = async (raw, ctx) => {
    const parsed = OPS['decisions.undo_group'].input.safeParse(raw);
    if (!parsed.success) return { status: 'error', code: 'invalid_input', message: 'invalid input', issues: parsed.error.issues };
    const undone: Decision[] = [];
    const skipped: { decision_id: string; reason: string }[] = [];
    const eventIds: string[] = [];
    for (const id of new Set(parsed.data.decision_ids)) {
      const d = store.get(id);
      if (!d) {
        skipped.push({ decision_id: id, reason: 'not found' });
        continue;
      }
      const r = await undoOne(d, ctx);
      if (r.ok) {
        undone.push(r.decision);
        eventIds.push(r.eventId);
      } else skipped.push({ decision_id: id, reason: r.message });
    }
    if (!undone.length) return { status: 'error', code: 'conflict', message: 'nothing in the group can be undone' };
    return { status: 'ok', output: { undone, skipped }, eventIds };
  };

  return { 'decisions.queue': queue, 'decisions.resolve': resolve, 'decisions.undo': undo, 'decisions.undo_group': undoGroup };
}
