/*
 * Machine work per runner (#160): the `pp setup` step and `pp doctor` check only the selected runner needs.
 * Command lines, prompts and tool bindings live in the engine's runners/; machine access stays here in src/system.
 */
import { type db, runners } from '@perfect-placement/engine';
import type { SetupStep } from '../commands/setup.js';
import type { Io } from '../io.js';
import { browserDoctor, setupBrowser } from './browser.js';
import type { SystemDeps } from './deps.js';

export interface RunnerMachine {
  /** A `pp setup` step: install what this runner's runs need. */
  setup?(io: Io, d: SystemDeps, yes: boolean): Promise<SetupStep>;
  /** A `pp doctor` check: is that still in place. */
  doctor?(d: SystemDeps): db.DoctorResult['checks'][number];
}

export const RUNNER_MACHINE: Readonly<Record<runners.RunnerCommand, RunnerMachine>> = {
  claude: {},
  codex: { setup: setupBrowser, doctor: browserDoctor },
  'cursor-agent': { setup: setupBrowser, doctor: browserDoctor },
};

/** The selected runner's setup steps (none for a runner that needs nothing installed). */
export async function runnerSetupSteps(runner: runners.RunnerCommand, io: Io, d: SystemDeps, yes: boolean): Promise<SetupStep[]> {
  const setup = RUNNER_MACHINE[runner].setup;
  const steps = setup ? [await setup(io, d, yes)] : [];
  if (runner === 'codex')
    steps.push({
      step: 'gmail',
      result: 'failed',
      detail: `setup required: Gmail: ${runners.CODEX_GMAIL_BLOCKER}`,
      fix: 'Gmail headless runs are blocked pending a verified Codex isolation fix (#158); connecting another provider does not fix this',
    });
  return steps;
}

/** The selected runner's doctor checks. */
export function runnerDoctorChecks(runner: runners.RunnerCommand, d: SystemDeps): db.DoctorResult['checks'] {
  const doctor = RUNNER_MACHINE[runner].doctor;
  const checks = doctor ? [doctor(d)] : [];
  if (runner === 'codex')
    checks.push({ name: 'gmail_isolation', ok: false, detail: `setup required: Gmail: ${runners.CODEX_GMAIL_BLOCKER}` });
  return checks;
}
