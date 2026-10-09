/*
 * The machine, behind one interface: platform, PATH lookup, child processes, fetch, clock.
 * `pp setup` and `pp kev` take a SystemDeps so tests run on a temp HOME with a fake spawn and
 * no network. Nothing here touches the vault.
 */
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, openSync, statSync } from 'node:fs';
import { homedir, totalmem } from 'node:os';
import { delimiter, join } from 'node:path';
import { ops } from '@perfect-placement/engine';

export interface SystemDeps {
  platform: NodeJS.Platform;
  arch: string;
  /** Total RAM in bytes. */
  totalMem: number;
  /** The user's home dir (agent client configs live under it). */
  home: string;
  /** The user's uid (launchctl's `gui/<uid>` domain for schedule jobs). */
  uid: number;
  /** Where desktop apps are installed (macOS: /Applications). */
  appsDir: string;
  env: NodeJS.ProcessEnv;
  /** Absolute path of `node` (MCP clients spawn it directly, not via PATH). */
  nodePath: string;
  which(cmd: string): string | null;
  /** Run to completion with inherited stdio; resolves the exit code. */
  run(cmd: string, args: string[], opts?: { cwd?: string }): Promise<number>;
  /** Run a short command and capture its output. */
  capture(cmd: string, args: string[]): { code: number; stdout: string; stderr: string };
  /** Start a detached background process with stdout + stderr appended to `log`; returns its pid. */
  spawnDetached(cmd: string, args: string[], opts: { cwd: string; log: string }): number;
  alive(pid: number): boolean;
  /** SIGTERM the process group (falls back to the pid). */
  kill(pid: number): void;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

export function whichIn(cmd: string, path: string | undefined): string | null {
  for (const dir of (path ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, cmd);
    try {
      if (existsSync(p) && statSync(p).isFile()) {
        accessSync(p, constants.X_OK);
        return p;
      }
    } catch {
      // not executable
    }
  }
  return null;
}

/** The node to write into MCP client configs (PP_NODE, else a Cellar path mapped to `opt/`): one rule with the runner. */
export const stableNodePath = ops.stableNodePath;

export function realDeps(env: NodeJS.ProcessEnv = process.env): SystemDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    totalMem: totalmem(),
    home: env.HOME || homedir(),
    uid: process.getuid?.() ?? 0,
    appsDir: '/Applications',
    env,
    nodePath: stableNodePath(env, process.execPath),
    which: (cmd) => whichIn(cmd, env.PATH),
    run: (cmd, args, opts) =>
      new Promise((done) => {
        const child = spawn(cmd, args, { cwd: opts?.cwd, stdio: 'inherit', env });
        child.on('error', () => done(127));
        child.on('exit', (code) => done(code ?? 1));
      }),
    capture: (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8', env, timeout: 60_000 });
      return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
    spawnDetached: (cmd, args, opts) => {
      const fd = openSync(opts.log, 'a');
      try {
        const child = spawn(cmd, args, { cwd: opts.cwd, detached: true, stdio: ['ignore', fd, fd], env });
        child.unref();
        if (child.pid === undefined) throw new Error(`could not start ${cmd}`);
        return child.pid;
      } finally {
        closeSync(fd);
      }
    },
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    kill: (pid) => {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // already gone
        }
      }
    },
    fetch: (...a) => fetch(...a),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
  };
}
