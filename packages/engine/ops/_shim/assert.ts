import type { OpOutcome } from '@perfect-placement/contracts';

/** Test helper: unwrap an ok outcome or fail with its error. */
// biome-ignore lint/suspicious/noExplicitAny: test helper returns loosely typed output
export function okOut(o: OpOutcome<unknown>): any {
  if (o.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(o)}`);
  return o.output;
}
