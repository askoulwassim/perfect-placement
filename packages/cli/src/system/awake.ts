/*
 * Stay awake during a scheduled run (#121). A launchd job can start during a brief maintenance wake on battery; if the
 * Mac sleeps mid-run the connectors idle out. While `pp run --schedule` waits for its run (and the runs it chains), it
 * holds a power assertion tied to its own pid, released when it returns:
 *
 * - macOS: `caffeinate -i -s -w <pid>` (no idle sleep; no system sleep on AC). `-w` also drops it if pp run dies.
 * - Linux: `systemd-inhibit --what=sleep:idle --mode=block tail --pid=<pid> -f /dev/null`, when systemd-inhibit exists.
 * - Anything else, or the tool missing: nothing.
 *
 * Only during the run; nothing system-wide or persistent. Spawned through SystemDeps (tests use a fake, never caffeinate).
 */
import type { SystemDeps } from './deps.js';

export interface AwakeHold {
  /** What was spawned (`caffeinate`, `systemd-inhibit`), or null when nothing is held. */
  tool: string | null;
  pid: number | null;
  release(): void;
}

/** The command that keeps the machine awake while `pid` lives, or null on this platform / without the tool. */
export function awakeCommand(d: Pick<SystemDeps, 'platform' | 'which'>, pid: number): { cmd: string; args: string[] } | null {
  if (d.platform === 'darwin' && d.which('caffeinate')) return { cmd: 'caffeinate', args: ['-i', '-s', '-w', String(pid)] };
  if (d.platform === 'linux' && d.which('systemd-inhibit') && d.which('tail'))
    return {
      cmd: 'systemd-inhibit',
      args: [
        '--what=sleep:idle',
        '--who=Perfect Placement',
        '--why=scheduled run',
        '--mode=block',
        'tail',
        `--pid=${pid}`,
        '-f',
        '/dev/null',
      ],
    };
  return null;
}

/** Hold the power assertion for `pid` (default: this process). Never throws: a failed spawn holds nothing. */
export function holdAwake(d: SystemDeps, opts: { pid?: number; cwd: string } = { cwd: '/' }): AwakeHold {
  const pid = opts.pid ?? process.pid;
  const c = awakeCommand(d, pid);
  if (!c) return { tool: null, pid: null, release: () => {} };
  let child: number;
  try {
    child = d.spawnDetached(c.cmd, c.args, { cwd: opts.cwd, log: '/dev/null' });
  } catch {
    return { tool: null, pid: null, release: () => {} };
  }
  let held = true;
  return {
    tool: c.cmd,
    pid: child,
    release: () => {
      if (!held) return;
      held = false;
      if (d.alive(child)) d.kill(child);
    },
  };
}
