// Test-only SystemDeps: temp HOME, scripted PATH, recorded spawns, no network, no real processes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SystemDeps } from './deps.js';

export interface FakeDeps extends SystemDeps {
  runs: { cmd: string; args: string[]; cwd?: string | undefined }[];
  captures: { cmd: string; args: string[] }[];
  spawned: { cmd: string; args: string[]; cwd: string; log: string; pid: number }[];
  killed: number[];
  livePids: Set<number>;
  /** Kev /v1/models answers. */
  kevUp: boolean;
}

export function fakeDeps(home: string, over: Partial<SystemDeps> & { bins?: string[] } = {}): FakeDeps {
  const bins = new Set(over.bins ?? ['git', 'uv']);
  let nextPid = 4242;
  const d: FakeDeps = {
    platform: 'darwin',
    arch: 'arm64',
    totalMem: 32 * 1024 ** 3,
    home,
    uid: 501,
    appsDir: join(home, 'Applications'),
    env: {},
    nodePath: '/opt/node22/bin/node',
    runs: [],
    captures: [],
    spawned: [],
    killed: [],
    livePids: new Set(),
    kevUp: false,
    which: (cmd) => (bins.has(cmd) ? `/usr/bin/${cmd}` : null),
    run: async (cmd, args, opts) => {
      d.runs.push({ cmd, args, cwd: opts?.cwd });
      // `git clone ... <dest>` makes the clone dir.
      if (args[0] === 'clone') mkdirSync(join(args.at(-1) as string, '.git'), { recursive: true });
      return 0;
    },
    capture: (cmd, args) => {
      d.captures.push({ cmd, args });
      return { code: 0, stdout: args.includes('rev-parse') ? 'abc123\n' : '', stderr: '' };
    },
    spawnDetached: (cmd, args, opts) => {
      const pid = nextPid++;
      writeFileSync(opts.log, '');
      d.spawned.push({ cmd, args, ...opts, pid });
      d.livePids.add(pid);
      return pid;
    },
    alive: (pid) => d.livePids.has(pid),
    kill: (pid) => {
      d.killed.push(pid);
      d.livePids.delete(pid);
    },
    fetch: (async () => {
      if (!d.kevUp) throw new Error('connection refused');
      return new Response('{"data":[]}', { status: 200 });
    }) as typeof fetch,
    sleep: async () => {},
    now: () => new Date('2026-10-08T12:00:00.000Z'),
    ...over,
  };
  return d;
}
