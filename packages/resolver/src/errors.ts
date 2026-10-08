import type { Backend } from '@perfect-placement/contracts';

/** A backend could not answer (network, auth, rate limit, unsupported question, invalid output). Triggers fallback. */
export class BackendUnavailableError extends Error {
  readonly backend: Backend;
  readonly status: number | undefined;
  readonly retryable: boolean;
  constructor(backend: Backend, message: string, opts: { status?: number; retryable?: boolean; cause?: unknown } = {}) {
    super(`${backend}: ${message}`, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'BackendUnavailableError';
    this.backend = backend;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
  }
}
