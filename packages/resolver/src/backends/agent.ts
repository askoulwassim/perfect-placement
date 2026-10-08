import type { Answer, AskRequest, BackendResult, DecisionBackend } from '@perfect-placement/contracts';
import { BackendUnavailableError } from '../errors.js';

/*
 * Agent backend (wave1-decisions #9): the calling Claude Code / Codex / Cursor session.
 * It never calls an API. It only answers with what the agent already supplied for this op call
 * (answers keyed by question id); anything it was not given yields, so the question goes to a human.
 */

export interface AgentAnswers {
  /** Answers the agent supplied, keyed by question id. */
  answers?: Record<string, Omit<Answer, 'id'>>;
  /**
   * The agent's stated confidence in the op it called (`OpContext.confidence`). Answers a single
   * yes/no question as "yes, do it" with that p (the agent asking for the op is its pick).
   */
  confidence?: { p: number };
}

export function createAgentBackend(supplied: AgentAnswers = {}): DecisionBackend {
  return {
    name: 'agent',
    async ask(req: AskRequest): Promise<BackendResult> {
      const answers: Answer[] = req.questions.map((q) => {
        const a = supplied.answers?.[q.id];
        if (a) return { id: q.id, value: a.value, p: a.p };
        if (supplied.confidence && q.type === 'noulli' && req.questions.length === 1)
          return { id: q.id, value: true, p: supplied.confidence.p };
        throw new BackendUnavailableError('agent', `no answer supplied for '${q.id}': yields to a human`);
      });
      return { answers, latencyMs: 0 };
    },
    async health() {
      return { ok: true, latencyMs: 0 };
    },
  };
}
