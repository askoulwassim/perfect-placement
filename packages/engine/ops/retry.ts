/*
 * Transient-failure retries (#122; #121 reuses this for scheduled runs with a longer backoff). Policy only:
 * which failures are transient, how many tries, the backoff schedule. The caller owns the clock and the timer,
 * both injectable, so tests never wait.
 */

/** Error codes that are transient whatever the text says. */
export const TRANSIENT_ERROR_CODES: readonly string[] = ['connector_unavailable', 'stalled'];

/** Error text that marks a transient failure (a connector that stalled, reset or timed out). */
export const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /\bconnector[_ ]unavailable\b/i,
  /\bidle timeout\b/i,
  /\bECONNRESET\b/,
  /\bETIMEDOUT\b/,
  /\bstalled\b/i,
];

/** A failure as the retry policy sees it: a code (`runs.finish { error_code }`), text, or both. */
export interface Failure {
  code?: string | null | undefined;
  message?: string | null | undefined;
}

export interface RetryPolicy {
  /** Total tries, the first included (2 = one retry). */
  attempts: number;
  /** Delay before each retry, ms: entry i is the wait after try i + 1; the last entry repeats. */
  backoffMs: readonly number[];
  /** Codes this policy retries (default `TRANSIENT_ERROR_CODES`). */
  codes?: readonly string[];
  /** Text patterns this policy retries (default `TRANSIENT_PATTERNS`); [] = codes only. */
  patterns?: readonly RegExp[];
}

/** How long a run waits before its connector retry (#122): claude.ai connectors load within a minute or so. */
export const CONNECTOR_RETRY_DELAY_MS = 45_000;

/**
 * A run that ended `error_code: "connector_unavailable"` (#122): one retry after `CONNECTOR_RETRY_DELAY_MS`.
 * Code only: free text never triggers it.
 */
export const CONNECTOR_RETRY: RetryPolicy = {
  attempts: 2,
  backoffMs: [CONNECTOR_RETRY_DELAY_MS],
  codes: ['connector_unavailable'],
  patterns: [],
};

/**
 * A scheduled run (#121: started by a schedule, or chained or retried from one) that failed transiently: any
 * transient code or text (`TRANSIENT_ERROR_CODES`, `TRANSIENT_PATTERNS`), retried after 1, 5, then 15 minutes, so the
 * first try plus up to three retries. It replaces `CONNECTOR_RETRY` for those runs (one policy per run, never both).
 */
export const SCHEDULE_RETRY: RetryPolicy = {
  attempts: 4,
  backoffMs: [60_000, 5 * 60_000, 15 * 60_000],
};

/**
 * The one retry policy for a queue run (#121): `SCHEDULE_RETRY` when it is scheduled (`summary_json.schedule` or
 * `schedule_origin`), else `CONNECTOR_RETRY`. An agent's own run is never retried (the caller checks).
 */
export function retryPolicyFor(s: { schedule?: string | null | undefined; schedule_origin?: string | null | undefined }): RetryPolicy {
  return s.schedule || s.schedule_origin ? SCHEDULE_RETRY : CONNECTOR_RETRY;
}

const MIN = 60_000;

/**
 * Wall-clock cap per skill for a scheduled run (#121), from launch: past it the runner's process tree is killed and the
 * run finishes `error_code: "stalled"` (transient, so it is retried under `SCHEDULE_RETRY`). Skills without an entry
 * get `DEFAULT_STALL_LIMIT_MS`.
 */
export const STALL_LIMIT_MS: Readonly<Record<string, number>> = {
  inbox: 10 * MIN,
  freshness: 20 * MIN,
  scout: 15 * MIN,
  score: 15 * MIN,
  research: 10 * MIN,
  connect: 10 * MIN,
  fill: 10 * MIN,
  voice: 10 * MIN,
  tailor: 10 * MIN,
};
export const DEFAULT_STALL_LIMIT_MS = 20 * MIN;
export const stallLimitMs = (skill: string): number => STALL_LIMIT_MS[skill] ?? DEFAULT_STALL_LIMIT_MS;

/** The first transient marker in a runner's output (#121), e.g. "ECONNRESET", so a runner that died on one is retried. */
export function transientMarker(output: string): string | null {
  for (const p of TRANSIENT_PATTERNS) {
    const m = p.exec(output);
    if (m) return m[0];
  }
  return null;
}

/** Is this failure transient under the policy? */
export function isTransient(f: Failure, policy: Pick<RetryPolicy, 'codes' | 'patterns'> = {}): boolean {
  // Setup failures need a human/configuration change, even if a stale transient code accompanies them (#158).
  if (f.message?.startsWith('setup required:')) return false;
  const codes = policy.codes ?? TRANSIENT_ERROR_CODES;
  if (f.code && codes.includes(f.code)) return true;
  const text = f.message ?? '';
  return Boolean(text) && (policy.patterns ?? TRANSIENT_PATTERNS).some((p) => p.test(text));
}

/** The wait before the next try after `attempt` tries (1-based), ms. */
export function backoffMs(policy: RetryPolicy, attempt: number): number {
  const i = Math.max(0, Math.min(attempt - 1, policy.backoffMs.length - 1));
  return policy.backoffMs[i] ?? 0;
}

export interface RetryPlan {
  /** The try the retry will be (2 for the first retry). */
  attempt: number;
  delayMs: number;
  /** When it may start. */
  at: Date;
}

/**
 * The next try for a failure after `attempt` tries (1-based), or null: not transient, or no tries left.
 */
export function nextRetry(policy: RetryPolicy, f: Failure, attempt: number, now: Date): RetryPlan | null {
  if (!isTransient(f, policy) || attempt >= policy.attempts) return null;
  const delayMs = backoffMs(policy, attempt);
  return { attempt: attempt + 1, delayMs, at: new Date(now.getTime() + delayMs) };
}

/**
 * Run `fn` and retry it under the policy while it throws a transient failure (in-process steps). `classify`
 * turns a thrown value into a Failure (default: its `code` and `message`); `sleep` is injected.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: {
    policy: RetryPolicy;
    sleep: (ms: number) => Promise<void>;
    classify?: (e: unknown) => Failure;
    onRetry?: (plan: { attempt: number; delayMs: number; error: unknown }) => void;
  },
): Promise<T> {
  const classify = opts.classify ?? ((e: unknown) => ({ code: (e as { code?: string })?.code, message: (e as Error)?.message }));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (!isTransient(classify(e), opts.policy) || attempt >= opts.policy.attempts) throw e;
      const delayMs = backoffMs(opts.policy, attempt);
      opts.onRetry?.({ attempt: attempt + 1, delayMs, error: e });
      await opts.sleep(delayMs);
    }
  }
}

/** Calls `fn` once after `ms` (EngineServices.timer). Never keeps the process alive on its own. */
export type Timer = (fn: () => void, ms: number) => void;

export const realTimer: Timer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
};
