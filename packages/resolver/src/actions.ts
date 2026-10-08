import type { Answer } from '@perfect-placement/contracts';

/*
 * `decision.action_json`: the op to run when the decision is applied.
 *   { op, input, when?, undo? }
 * - `input` may contain the string "$value" anywhere; it is replaced by the final value
 *   (the model's pick, or the human's change).
 * - `when`: run only if the final value equals it (e.g. archive only when "open?" is false).
 *   Absent = always run.
 * - `undo`: the inverse op for `decisions.undo` on an auto + undo decision.
 * `when` and `undo` are lane I extensions inside the existing Json column (see CONTRACT_CHANGES.md).
 */

export interface OpCall {
  op: string;
  input: unknown;
}
export interface DecisionAction extends OpCall {
  when?: Answer['value'];
  undo?: OpCall;
}

export const VALUE_TOKEN = '$value';

export function substituteValue(input: unknown, value: Answer['value']): unknown {
  if (input === VALUE_TOKEN) return value;
  if (Array.isArray(input)) return input.map((x) => substituteValue(x, value));
  if (input && typeof input === 'object') {
    return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, substituteValue(v, value)]));
  }
  return input;
}

export function parseAction(json: unknown): DecisionAction | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const a = json as Record<string, unknown>;
  if (typeof a.op !== 'string') return undefined;
  const out: DecisionAction = { op: a.op, input: a.input ?? {} };
  if (a.when !== undefined && (typeof a.when === 'string' || typeof a.when === 'number' || typeof a.when === 'boolean')) out.when = a.when;
  const u = a.undo as Record<string, unknown> | undefined;
  if (u && typeof u.op === 'string') out.undo = { op: u.op, input: u.input ?? {} };
  return out;
}

/** Does the action apply for this final value? */
export function actionApplies(action: DecisionAction, value: Answer['value']): boolean {
  if (action.when === undefined) return true;
  if (typeof action.when === 'string' && typeof value === 'string') return action.when.toLowerCase() === value.toLowerCase();
  return action.when === value;
}

/** Coerce a human-supplied value (UI and MCP send strings) to the question's type. */
export function coerceValue(question: unknown, value: Answer['value']): Answer['value'] {
  const type = (question as { type?: string } | null)?.type;
  if (type === 'noulli' && typeof value === 'string') return /^(true|yes|1)$/i.test(value.trim());
  if (type === 'score' && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return value;
}
