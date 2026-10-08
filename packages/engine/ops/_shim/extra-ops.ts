import { defineOp, Id, Run, RunStatus } from '@perfect-placement/contracts';
import { z } from 'zod';

/*
 * SHIM: ops requested in CONTRACT_CHANGES.md ("Lane B requests") but not yet in the
 * frozen registry. `runOp` accepts these names alongside OPS. Wave 2 moves them into
 * packages/contracts/src/ops/registry.ts (or drops them if the request is rejected).
 */

export const runsFinish = defineOp({
  name: 'runs.finish',
  description: 'Close a skill run started with runs.start.',
  input: z.object({
    run_id: Id,
    status: RunStatus.exclude(['running']),
    summary: z.record(z.string(), z.unknown()).optional(),
    note: z.string().optional(),
  }),
  output: z.object({ run: Run }),
  impact: 'low',
  emits: ['run_finished'],
  owner: 'B',
});

export const EXTRA_OPS = { 'runs.finish': runsFinish } as const;
export type ExtraOpName = keyof typeof EXTRA_OPS;
