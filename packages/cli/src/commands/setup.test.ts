/*
 * pp setup / pp kev / Kev in pp up: temp HOME + temp PP_HOME, fake spawn, no network, no downloads.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeBackend, fakeLauncher, noNetwork } from '@perfect-placement/engine/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import type { Io } from '../io.js';
import { type FakeDeps, fakeDeps } from '../system/fake-deps.test-helpers.js';
import { kevPaths, serveArgs } from '../system/kev.js';

let root: string;
let home: string;
let ppHome: string;
let out: string[];
let err: string[];
let asked: string[];
let answers: boolean[];
let d: FakeDeps;
let io: Io;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pp-setup-'));
  home = join(root, 'home');
  ppHome = join(root, 'vault');
  mkdirSync(home);
  out = [];
  err = [];
  asked = [];
  answers = [];
  d = fakeDeps(home);
  io = {
    env: { PP_HOME: ppHome },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    stdin: () => '',
    ask: async (q, def) => {
      asked.push(q);
      return answers.length ? (answers.shift() as boolean) : def;
    },
    sys: d,
    services: { fetch: noNetwork, launcher: fakeLauncher(), backends: { kev: fakeBackend('kev', 'down') }, freshnessDelayMs: 0, env: {} },
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const config = () => JSON.parse(readFileSync(join(ppHome, 'config.json'), 'utf8'));
const text = () => out.join('\n');

describe('pp setup', () => {
  it('--yes --no-kev --no-mcp: creates the vault, then is a no-op on rerun', async () => {
    expect(await runCli(['setup', '--yes', '--no-kev', '--no-mcp'], io)).toBe(0);
    expect(existsSync(join(ppHome, 'pp.db'))).toBe(true);
    expect(text()).toContain(`pp init: created ${ppHome}`);
    expect(text()).toContain('kev: skipped (--no-kev)');
    expect(asked).toEqual([]);
    out.length = 0;
    expect(await runCli(['setup', '--yes', '--no-kev', '--no-mcp'], io)).toBe(0);
    expect(text()).toContain(`vault: ${ppHome} (kept)`);
  });

  it('registers only detected clients, asking first for each', async () => {
    d.which = (c) => (c === 'claude' ? '/usr/bin/claude' : c === 'uv' || c === 'git' ? `/usr/bin/${c}` : null);
    d.capture = (cmd, args) => {
      d.captures.push({ cmd, args });
      return args[1] === 'get' ? { code: 1, stdout: '', stderr: 'No MCP server named "pp"' } : { code: 0, stdout: '', stderr: '' };
    };
    mkdirSync(join(home, '.cursor'));
    answers = [false, true, false]; // Kev? no. Claude Code? yes. Cursor? no.
    expect(await runCli(['setup'], io)).toBe(0);
    expect(asked).toEqual([
      'Install Kev, the optional local decision model (multi-GB download)?',
      'Register pp with Claude Code?',
      'Register pp with Cursor?',
    ]);
    expect(text()).toContain('mcp: Codex: not found (skipped)');
    expect(text()).toContain('mcp: Cursor: skipped');
    expect(text()).toMatch(/mcp: Claude Code: added server "pp" -> claude mcp add --scope user pp -e PP_HOME=.+ -- /);
    const add = d.captures.find((c) => c.args[1] === 'add');
    expect(add?.args).toContain(`PP_HOME=${ppHome}`);
    expect(add?.args.at(-1)).toMatch(/packages\/mcp\/dist\/bin\.js$/);
    expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('--mcp limits clients; Cursor gets an absolute node + pp-mcp + PP_HOME', async () => {
    mkdirSync(join(home, '.cursor'));
    mkdirSync(join(home, '.codex'));
    expect(await runCli(['setup', '--yes', '--no-kev', '--mcp', 'cursor'], io)).toBe(0);
    const cursor = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));
    expect(cursor.mcpServers.pp).toMatchObject({ command: '/opt/node22/bin/node', env: { PP_HOME: ppHome } });
    expect(existsSync(join(home, '.codex', 'config.toml'))).toBe(false);
    expect(await runCli(['setup', '--mcp', 'nope'], io)).toBe(2);
  });

  it('says Kev is unsupported off Apple Silicon / CUDA and carries on', async () => {
    d.platform = 'linux';
    d.arch = 'x64';
    expect(await runCli(['setup', '--yes', '--no-mcp'], io)).toBe(0);
    expect(text()).toContain('This machine is not supported. pp works without Kev');
    expect(d.runs).toEqual([]);
  });
});

describe('pp kev', () => {
  const setup = () => runCli(['setup', '--yes', '--no-kev', '--no-mcp'], io);

  it('install: clones + uv sync into $PP_HOME/kev, stores the model, never downloads in tests', async () => {
    await setup();
    expect(await runCli(['kev', 'install', '--yes', '--model', 'kev-0.8b'], io)).toBe(0);
    const p = kevPaths(ppHome);
    expect(d.runs.map((r) => [r.cmd, ...r.args.slice(0, 2)])).toEqual([
      ['/usr/bin/git', 'clone', '--depth'],
      ['/usr/bin/uv', 'sync', '--extra'],
    ]);
    expect(d.runs[1]?.cwd).toBe(p.repo);
    expect(JSON.parse(readFileSync(p.state, 'utf8'))).toMatchObject({ commit: 'abc123' });
    expect(config().backends.kev).toEqual({ baseUrl: 'http://127.0.0.1:8009', model: 'kev-0.8b' });
    expect(text()).toContain('multi-GB');
    // Idempotent: no second clone or sync.
    expect(await runCli(['kev', 'install', '--yes'], io)).toBe(0);
    expect(d.runs).toHaveLength(2);
  });

  it('install without uv prints the install command', async () => {
    await setup();
    d.which = (c) => (c === 'git' ? '/usr/bin/git' : null);
    expect(await runCli(['kev', 'install', '--yes'], io)).toBe(1);
    expect(err.join('\n')).toContain('curl -LsSf https://astral.sh/uv/install.sh | sh');
  });

  it('warns on memory and suggests kev-0.8b on a 16 GB machine', async () => {
    await setup();
    d.totalMem = 16 * 1024 ** 3;
    expect(await runCli(['kev', 'install', '--yes', '--model', 'kev-4b'], io)).toBe(0);
    expect(text()).toContain('kev-4b wants 8 GB+ free of memory; this machine has 16 GB. Consider --model kev-0.8b.');
  });

  it('start / status / stop: background process with pid + log in $PP_HOME/kev', async () => {
    await setup();
    expect(await runCli(['kev', 'start'], io)).toBe(2); // not installed
    await runCli(['kev', 'install', '--yes', '--model', 'kev-0.8b'], io);
    expect(await runCli(['kev', 'start'], io)).toBe(0);
    const p = kevPaths(ppHome);
    expect(d.spawned).toHaveLength(1);
    expect(d.spawned[0]).toMatchObject({ cmd: '/usr/bin/uv', args: serveArgs('kev-0.8b', 8009), cwd: p.repo, log: p.log });
    expect(serveArgs('kev-0.8b', 8009)).toEqual([
      'run',
      '--extra',
      'serve',
      'python',
      '-m',
      'kev.serve',
      '--run',
      'jaredpalmer/kev-0.8b@9a45d25e',
      '--port',
      '8009',
    ]);
    expect(readFileSync(p.pid, 'utf8').trim()).toBe('4242');
    expect(await runCli(['kev', 'start'], io)).toBe(0);
    expect(d.spawned).toHaveLength(1); // already running
    out.length = 0;
    await runCli(['kev', 'status'], io);
    expect(text()).toContain('process: running (pid 4242)');
    expect(await runCli(['kev', 'stop'], io)).toBe(0);
    expect(d.killed).toEqual([4242]);
    expect(readFileSync(p.pid, 'utf8')).toBe('');
  });

  it('start --wait polls until Kev answers', async () => {
    await setup();
    await runCli(['kev', 'install', '--yes'], io);
    let polls = 0;
    d.sleep = async () => {
      polls++;
      if (polls === 2) d.kevUp = true;
    };
    expect(await runCli(['kev', 'start', '--wait'], io)).toBe(0);
    expect(text()).toContain('kev: ready');
  });
});

describe('pp up and Kev', () => {
  const upOnce = async (argv: string[]) => {
    let stop!: () => void;
    const stopped = new Promise<void>((r) => {
      stop = r;
    });
    const run = runCli(['up', '--port', '0', '--web', 'none', ...argv], io, () => stopped);
    for (let i = 0; i < 200 && !out.some((l) => l.startsWith('pp up: http')); i++) await new Promise((r) => setTimeout(r, 10));
    stop();
    return run;
  };

  it('starts an installed Kev on demand and stops it on exit', async () => {
    await runCli(['setup', '--yes', '--no-kev', '--no-mcp'], io);
    await runCli(['kev', 'install', '--yes'], io);
    expect(await upOnce([])).toBe(0);
    expect(d.spawned).toHaveLength(1);
    expect(d.killed).toEqual([d.spawned[0]?.pid]);
  });

  it('leaves a Kev it did not start running, and --no-kev skips it', async () => {
    await runCli(['setup', '--yes', '--no-kev', '--no-mcp'], io);
    await runCli(['kev', 'install', '--yes'], io);
    d.kevUp = true;
    expect(await upOnce([])).toBe(0);
    expect(d.spawned).toEqual([]);
    expect(d.killed).toEqual([]);
    d.kevUp = false;
    expect(await upOnce(['--no-kev'])).toBe(0);
    expect(d.spawned).toEqual([]);
  });

  it('does nothing when Kev is not installed', async () => {
    await runCli(['setup', '--yes', '--no-kev', '--no-mcp'], io);
    expect(await upOnce([])).toBe(0);
    expect(d.spawned).toEqual([]);
  });
});
