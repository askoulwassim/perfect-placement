import { type AskRequest, type BackendResult, type DecisionBackend, OTHER_OPTION } from '@perfect-placement/contracts';

/*
 * Human backend: the last resort when no model could answer. It does not answer; it produces a
 * placeholder pick with p = 0 so the policy routes every question to the Needs-you queue.
 * (When a model did answer, the human still sees that model's pick and p; this backend only runs
 * when all models failed.)
 */
export function createHumanBackend(): DecisionBackend {
  return {
    name: 'human',
    async ask(req: AskRequest): Promise<BackendResult> {
      const answers = req.questions.map((q) => {
        if (q.type === 'choice') return { id: q.id, value: OTHER_OPTION, p: 0 };
        if (q.type === 'score') return { id: q.id, value: q.min, p: 0 };
        return { id: q.id, value: false, p: 0 };
      });
      return { answers, latencyMs: 0 };
    },
    async health() {
      return { ok: true, latencyMs: 0 };
    },
  };
}
