import {
  type Answer,
  type ConfidenceBand,
  type Impact,
  POLICY_GRID,
  type PolicyOutcome,
  type Thresholds,
  thresholdsFor,
} from '@perfect-placement/contracts';
import { newId } from '../ids.js';
import type { DecisionPort } from '../ports.js';
import { insert } from './repo.js';

/*
 * SHIM for lane I. `decide()` is a plain lookup in the locked POLICY_GRID; there is no
 * second backend here, so `auto_second` is routed to a human. Wave 2: replace with the
 * resolver's `decide` + decision log (and a real second opinion).
 */

export function shimDecide(answer: Answer, impact: Impact, t: Thresholds): PolicyOutcome {
  const band: ConfidenceBand = answer.p >= t.auto ? 'confident' : answer.p >= t.second_opinion ? 'middle' : 'low';
  return POLICY_GRID[impact][band];
}

export const shimDecisions: DecisionPort = {
  record(db, req, { ctx, config }) {
    const now = ctx.now();
    const t = thresholdsFor(config, req.kind);
    let outcome: PolicyOutcome = req.forceHuman ? 'human' : shimDecide(req.answer, req.impact, t);
    if (outcome === 'auto_second') outcome = 'human'; // no second backend in the shim
    const decisionId = newId('decision', now);
    insert(db, 'decision', {
      id: decisionId,
      ts: now.toISOString(),
      kind: req.kind,
      subject_type: req.subject.type,
      subject_id: req.subject.id,
      question_json: req.question,
      backend: req.backend,
      answer_json: { ...req.answer },
      p: req.answer.p,
      impact: req.impact,
      policy_outcome: outcome,
      status: outcome === 'human' ? 'pending' : 'applied',
      human_choice: null,
      overridden: false,
      undo_until: outcome === 'auto_undo' ? new Date(now.getTime() + t.undo_hours * 3_600_000).toISOString() : null,
      resolved_at: outcome === 'human' ? null : now.toISOString(),
      latency_ms: 0,
      action_json: req.action ? { op: req.action.op, input: req.action.input } : null,
    });
    return { decisionId, outcome };
  },
};
