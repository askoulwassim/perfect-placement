import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { prepareCodex } from './codex/isolation.js';
import type { RunnerExit, RunnerLauncher } from './types.js';

/** Where the spawn launcher keeps runner output and pid files (OS temp dir, never the vault). */
export const runnerDir = (base: string = tmpdir()) => join(base, 'pp-runs');

/** `process.kill(pid, 0)`: true if the process exists (EPERM = exists, owned by someone else). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Is the runner for `runId` still alive? Reads the pid file the spawn launcher wrote; no file (never
 * launched here, temp dir cleared by a reboot) = gone. The runner is detached, so it can outlive `pp up`.
 */
export function runnerAlive(runId: string, base: string = tmpdir()): boolean {
  try {
    const pid = Number.parseInt(readFileSync(join(runnerDir(base), `${runId}.pid`), 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 && pidAlive(pid);
  } catch {
    return false;
  }
}

/**
 * Kill the runner for `runId` and everything it started (#121, a stalled run): the spawn launcher starts it detached,
 * so its pid is a process group; SIGTERM the group (falls back to the pid). False when there is no pid file (never
 * launched here, or already gone) or the process is gone.
 */
export function killRunner(runId: string, base: string = tmpdir()): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(join(runnerDir(base), `${runId}.pid`), 'utf8'), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGTERM');
      return true;
    } catch {
      // try the pid alone, then give up
    }
  }
  return false;
}

/**
 * Spawns the runner detached; output goes to a log file in the OS temp dir (never the vault), next to
 * a `<runId>.pid` file (removed on exit) so a restarted `pp up` can tell a live runner from a dead one.
 * `exit` settles with the log when the runner ends, as long as this process is still alive.
 */
export function createSpawnLauncher(): RunnerLauncher {
  return {
    async launch(spec) {
      const cwd = spec.cwd ?? mkdtempSync(join(tmpdir(), `pp-run-${spec.runId}-`));
      try {
        await prepareCodex(spec, cwd);
      } catch (error) {
        if (spec.cwd === null) rmSync(cwd, { recursive: true, force: true });
        throw error;
      }
      for (const f of spec.files) {
        const abs = join(cwd, f.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, f.content);
      }
      const logDir = runnerDir();
      const pidFile = join(logDir, `${spec.runId}.pid`);
      mkdirSync(logDir, { recursive: true });
      const logFile = join(logDir, `${spec.runId}.log`);
      const log = openSync(logFile, 'a');
      return new Promise((ok, fail) => {
        const child = spawn(spec.command, spec.args, {
          cwd,
          env: { ...process.env, ...spec.env },
          detached: true,
          stdio: ['ignore', log, log],
        });
        const exit = new Promise<RunnerExit>((done) => {
          child.once('exit', (code) => {
            rmSync(pidFile, { force: true });
            let output = '';
            try {
              output = readFileSync(logFile, 'utf8');
            } catch {
              // log gone: report the exit code only
            }
            done({ code, output, logFile });
          });
        });
        child.once('error', (e) => {
          closeSync(log);
          fail(e);
        });
        child.once('spawn', () => {
          closeSync(log);
          if (child.pid !== undefined) writeFileSync(pidFile, String(child.pid));
          child.unref();
          ok(child.pid === undefined ? { exit } : { pid: child.pid, exit });
        });
      });
    },
  };
}
