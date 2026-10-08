import type { Contact, ContactLink, Criterion, OpInput, OpName, OpOutcome, OpOutput, Outreach } from '@perfect-placement/contracts';

/*
 * The UI talks to the system only through ops. `OpClient.run(name, input)` is the single entry
 * point, mirroring `runOp(name, input, ctx)` with actor = human.
 *
 * Shim ops: reads the screens need that the Wave 0 registry does not expose yet. Each one is
 * filed under "Lane D requests" in CONTRACT_CHANGES.md. They are read-only; no write goes
 * around the registry.
 */

export interface CalibrationSample {
  id: string;
  company: string;
  letter: string;
  title: string;
  comp: string;
  mode: string;
  /** 1..5 per criterion; drives the live weight bars. */
  criteria: Record<Criterion, number>;
}

export interface BackendStatus {
  name: 'jev' | 'kev' | 'llm';
  mode: 'hosted' | 'local';
  status: 'ok' | 'slow' | 'down';
  latencyMs: number | null;
}

export interface ShimOps {
  'outreach.get': {
    input: { outreach_id: string };
    output: {
      outreach: Outreach;
      contact: Contact;
      subject: string | null;
      hook: string;
      proof: string;
      ask: string;
      /** One draft per tone (Ask for the conversation, Coffee or intro, Forwardable blurb, Positioning note). */
      variants: Array<{ hook: string; proof: string; ask: string }>;
    };
  };
  'outreach.list': { input: { role_id: string }; output: { items: Outreach[] } };
  'vault.read': { input: { path: string }; output: { markdown: string | null } };
  'onboard.samples': { input: Record<string, never>; output: { items: CalibrationSample[]; weights: Record<Criterion, number> } };
  'system.backends': { input: Record<string, never>; output: { items: BackendStatus[] } };
  'contacts.get': { input: { contact_id: string }; output: { contact: Contact; links: ContactLink[] } };
}
export type ShimName = keyof ShimOps;
export const SHIM_NAMES: readonly ShimName[] = [
  'outreach.get',
  'outreach.list',
  'vault.read',
  'onboard.samples',
  'system.backends',
  'contacts.get',
];

export type AnyOpName = OpName | ShimName;
export type In<N extends AnyOpName> = N extends OpName ? OpInput<N> : N extends ShimName ? ShimOps[N]['input'] : never;
export type Out<N extends AnyOpName> = N extends OpName ? OpOutput<N> : N extends ShimName ? ShimOps[N]['output'] : never;

export interface OpClient {
  run<N extends AnyOpName>(name: N, input: In<N>): Promise<OpOutcome<Out<N>>>;
}

export const isShim = (name: string): name is ShimName => (SHIM_NAMES as readonly string[]).includes(name);
