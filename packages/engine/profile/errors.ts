import type { OpErrorCode, OpOutcome } from '@perfect-placement/contracts';
import { ZodError } from 'zod';

/** Thrown inside lane E handlers; converted to an OpOutcome error at the boundary. */
export class OpError extends Error {
  constructor(
    readonly code: OpErrorCode,
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
  }
}

/** Signals that policy routed the action to a human. */
export class RequiresHuman extends Error {
  constructor(readonly decisionId: string) {
    super(`requires human: ${decisionId}`);
  }
}

export function toOutcome(err: unknown): OpOutcome<never> {
  if (err instanceof RequiresHuman) return { status: 'requires_human', decisionId: err.decisionId };
  if (err instanceof OpError) return { status: 'error', code: err.code, message: err.message, issues: err.issues };
  if (err instanceof ZodError) return { status: 'error', code: 'invalid_input', message: 'validation failed', issues: err.issues };
  return { status: 'error', code: 'internal', message: err instanceof Error ? err.message : String(err) };
}
