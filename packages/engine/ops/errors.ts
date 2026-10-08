import type { OpErrorCode } from '@perfect-placement/contracts';

/** Thrown by handlers; `runOp` turns it into `{ status: 'error', code, message }` and rolls back. */
export class OpError extends Error {
  constructor(
    readonly code: OpErrorCode,
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
    this.name = 'OpError';
  }
}

export const notFound = (what: string, id: string) => new OpError('not_found', `${what} not found: ${id}`);
