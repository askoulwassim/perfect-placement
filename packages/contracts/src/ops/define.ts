import { z } from 'zod';
import type { Actor, Impact } from '../enums.js';
import type { EventType } from '../events.js';

/** Lanes that implement ops (docs/v2/lanes). */
export type Lane = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J';

export interface OpDef<N extends string = string, I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  name: N;
  description: string;
  input: I;
  output: O;
  /**
   * Static impact tier. For ops with `dynamicImpact`, this is the worst case;
   * the implementing lane computes the actual tier per call and never exceeds it.
   */
  impact: Impact;
  /** Impact depends on input (e.g. `profile.apply_diff`: weights medium, filters high). */
  dynamicImpact?: true;
  /** Only an actor of `human` may run it; agents get `requires_human`. */
  humanOnly?: true;
  /** Exposed in the registry but intentionally unimplemented in v2 (`outreach.send`). */
  unimplemented?: true;
  /** No writes, no events. */
  readOnly?: true;
  emits: readonly EventType[];
  /** Lane that implements the handler. */
  owner: Lane;
}

export function defineOp<const N extends string, I extends z.ZodType, O extends z.ZodType>(def: OpDef<N, I, O>): OpDef<N, I, O> {
  return def;
}

/** Passed to every op handler by `runOp`. */
export interface OpContext {
  actor: Actor;
  /** Injected clock so tests are deterministic. */
  now: () => Date;
  /** Set when the op runs inside a skill run. */
  runId?: string;
  /** Set when the op is executing an approved decision. */
  decisionId?: string;
  /** Validate, compute policy, write nothing. */
  dryRun?: boolean;
}

/** Result of `runOp(name, input, ctx)`. Surfaces (UI, MCP, CLI) render all three. */
export type OpOutcome<O> =
  | { status: 'ok'; output: O; eventIds: string[] }
  /** Policy routed to a human: the decision is in the Needs-you queue. */
  | { status: 'requires_human'; decisionId: string }
  | { status: 'error'; code: OpErrorCode; message: string; issues?: unknown };

export const OP_ERROR_CODES = [
  'invalid_input',
  'not_found',
  'conflict',
  'forbidden_transition',
  'human_only',
  'unimplemented',
  'backend_unavailable',
  'internal',
] as const;
export type OpErrorCode = (typeof OP_ERROR_CODES)[number];

/** Signature of the single entry point (implemented by lane B in packages/engine/ops). */
export type RunOp = <N extends string>(name: N, input: unknown, ctx: OpContext) => Promise<OpOutcome<unknown>>;

/** Shared output for ops that just acknowledge. */
export const Ack = z.object({ ok: z.literal(true) });

/** Shared pagination input. */
export const Page = z.object({
  limit: z.number().int().min(1).max(500).default(50),
  cursor: z.string().optional(),
});
