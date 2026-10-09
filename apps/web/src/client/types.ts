import type { AskChatEvent, AskChatRequest, OpInput, OpName, OpOutcome, OpOutput } from '@perfect-placement/contracts';

/*
 * The UI talks to the system only through ops. `OpClient.run(name, input)` is the single entry
 * point, mirroring `runOp(name, input, ctx)` with actor = human. Every name is a registry op.
 */

export type AnyOpName = OpName;
export type In<N extends OpName> = OpInput<N>;
export type Out<N extends OpName> = OpOutput<N>;

export interface OpClient {
  run<N extends OpName>(name: N, input: In<N>): Promise<OpOutcome<Out<N>>>;
  /**
   * Ask (#39): one turn of the agent session behind `pp up` (`POST /api/ask`, SSE), as events. Absent =
   * no agent behind this client.
   */
  ask?(req: AskChatRequest, signal?: AbortSignal): AsyncIterable<AskChatEvent>;
}

/** Calibration card (`onboard.samples` item). */
export type CalibrationSample = OpOutput<'onboard.samples'>['items'][number];
/** Settings backend card (`system.backends` item). */
export type BackendStatus = OpOutput<'system.backends'>['items'][number];
