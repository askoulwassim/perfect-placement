/*
 * `pp uninstall`: undo what install.sh, pp setup, pp kev and pp schedules put on this machine.
 *   default          setup reset, keeps the vault: stop the Kev pp started, remove pp's schedule jobs,
 *                    the `pp` MCP entry from each agent (backup first), the pp / pp-mcp launchers
 *   --purge          also the vault (verified tar.gz backup first) and Kev's Hugging Face model files
 *   --no-backup      purge without the backup;  --force  purge a dir that does not look like a vault
 *   --yes            no prompt;  --dry-run  print the plan only;  --bin-dir DIR  where the launchers are
 * Prints the plan, asks (default no), runs it, ends with a summary; exit 1 when an item failed.
 * Machine access lives in system/uninstall.ts (SystemDeps), so tests use a temp HOME and fake commands.
 */
import { dirname, join, resolve } from 'node:path';
import type { Args } from '../args.js';
import { confirm, type Io } from '../io.js';
import { ppCliBin } from '../system/schedules.js';
import { machineResetLines, type Outcome, type PlanItem, planUninstall } from '../system/uninstall.js';
import { sysOf } from './kev.js';
import { DEFAULT_PORT } from './up.js';

export interface UninstallStep extends Outcome {
  step: string;
}

const MARK: Record<Outcome['result'], string> = { ok: 'ok  ', skipped: 'skip', failed: 'FAIL' };

export function uninstallSummary(steps: UninstallStep[]): string[] {
  const failed = steps.filter((s) => s.result === 'failed').length;
  const width = Math.max(0, ...steps.map((s) => s.step.length));
  const lines = ['', 'Uninstall summary:'];
  for (const s of steps) {
    lines.push(`  ${MARK[s.result]}  ${s.step.padEnd(width)}  ${s.detail}`);
    if (s.result === 'failed' && s.fix) lines.push(`        ${' '.repeat(width)}  fix: ${s.fix}`);
  }
  lines.push(failed ? `uninstall: ${failed} item(s) failed (fixes above); rerun pp uninstall when done` : 'uninstall: done');
  return lines;
}

function planLines(items: PlanItem[]): string[] {
  const width = Math.max(0, ...items.map((i) => i.step.length));
  const lines: string[] = [];
  for (const i of items.filter((x) => x.verb)) {
    lines.push(`  ${(i.verb as string).padEnd(6)}  ${i.step.padEnd(width)}  ${i.what}`);
    for (const m of i.more ?? []) lines.push(`          ${' '.repeat(width)}    ${m}`);
  }
  const idle = items.filter((x) => !x.verb);
  if (idle.length) {
    lines.push('  nothing to do:');
    for (const i of idle) {
      lines.push(`    ${i.step.padEnd(width)}  ${i.what}`);
      for (const m of i.more ?? []) lines.push(`    ${' '.repeat(width)}    ${m}`);
    }
  }
  return lines;
}

export async function uninstallCommand(args: Args, home: string, io: Io): Promise<number> {
  const d = sysOf(io);
  const purge = args.has('purge');
  const repo = resolve(dirname(ppCliBin()), '..', '..', '..');
  const binDir = resolve(args.get('bin-dir') ?? d.env.PP_BIN_DIR ?? join(d.home, '.local', 'bin'));
  const plan = await planUninstall(d, {
    home,
    purge,
    backup: !args.has('no-backup'),
    force: args.has('force'),
    binDir,
    repo,
    upPort: DEFAULT_PORT,
  });
  if (plan.refusal) {
    io.err(`pp uninstall: refusing to purge: ${plan.refusal}. Nothing was changed.`);
    return 1;
  }
  const todo = plan.items.filter((i) => i.verb);
  io.out(
    purge
      ? `pp uninstall --purge: setup reset + vault ${home} + Kev's model files${args.has('no-backup') ? ' (NO backup)' : ' (backup first)'}`
      : `pp uninstall: setup reset; your vault at ${home} is kept (--purge removes it)`,
  );
  io.out(planLines(plan.items).join('\n'));
  const reset = machineResetLines(d, repo);
  if (!todo.length) {
    io.out('pp uninstall: nothing to remove');
    io.out(['', ...reset].join('\n'));
    return 0;
  }
  if (args.has('dry-run')) {
    io.out(['', 'Dry run: nothing was changed.', '', ...reset].join('\n'));
    return 0;
  }
  if (!(await confirm(io, args.has('yes'), `Remove the ${todo.length} item(s) above?`, false))) {
    io.out('pp uninstall: cancelled; nothing was changed (--yes to skip the question)');
    return 0;
  }
  const steps: UninstallStep[] = [];
  for (const item of plan.items) {
    if (!item.run) {
      steps.push({ step: item.step, result: 'skipped', detail: item.what });
      continue;
    }
    let r: Outcome;
    try {
      r = await item.run();
    } catch (e) {
      r = { result: 'failed', detail: (e as Error).message };
    }
    steps.push({ step: item.step, ...r });
  }
  if (steps.some((s) => s.step.startsWith('mcp ') && s.result === 'ok'))
    io.out('Restart the agents that had pp (Claude Desktop: Cmd+Q, then reopen).');
  io.out(['', ...reset].join('\n'));
  for (const l of uninstallSummary(steps)) io.out(l);
  return steps.some((s) => s.result === 'failed') ? 1 : 0;
}
