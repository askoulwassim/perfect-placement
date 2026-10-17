/*
 * pp setup / pp kev / Kev in pp up: temp HOME + temp PP_HOME, fake spawn, no network, no downloads.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runners } from '@perfect-placement/engine';
import { fakeBackend, fakeLauncher, noNetwork } from '@perfect-placement/engine/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import type { Io } from '../io.js';
import { whichIn } from '../system/deps.js';
import { type FakeDeps, fakeDeps } from '../system/fake-deps.test-helpers.js';
import { kevPaths, serveArgs } from '../system/kev.js';
import { restartHint, summaryLines } from './setup.js';

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
  it('selects Codex through config.update and installs its pinned browser runtime only once', async () => {
    d.which = (cmd) => (cmd === 'corepack' ? '/usr/bin/corepack' : null);
    d.capture = (cmd, args) => {
      d.captures.push({ cmd, args });
      return { code: 0, stdout: 'v24.22.0\n', stderr: '' };
    };
    d.run = async (cmd, args, opts) => {
      d.runs.push({ cmd, args, cwd: opts?.cwd });
      const bin = join(opts?.cwd as string, runners.BROWSER_ENTRY);
      mkdirSync(dirname(bin), { recursive: true });
      writeFileSync(bin, '// synthetic runtime');
      writeFileSync(join(opts?.cwd as string, 'node_modules/chrome-devtools-mcp/package.json'), '{"version":"1.10.1"}');
      return 0;
    };
    const flags = ['--yes', '--no-kev', '--no-mcp', '--no-schedules'];
    expect(await runCli(['setup', '--runner', 'codex', ...flags], io)).toBe(1);
    expect(text()).toMatch(/FAIL {2}gmail/);
    expect(text()).toContain('setup required: Gmail');
    expect(config().runner.command).toBe('codex');
    expect(d.runs).toHaveLength(1);
    expect(text()).toContain('chrome://inspect/#remote-debugging');
    expect(await runCli(['setup', ...flags], io)).toBe(1);
    expect(d.runs).toHaveLength(1);
    expect(await runCli(['setup', '--runner', 'claude', ...flags], io)).toBe(0);
    expect(config().runner.command).toBe('claude');
    expect(d.runs).toHaveLength(1);
  });

  it('registering Codex MCP does not select Codex or install browser support', async () => {
    mkdirSync(join(home, '.codex'));
    expect(await runCli(['setup', '--yes', '--no-kev', '--mcp', 'codex', '--no-schedules'], io)).toBe(0);
    expect(config().runner.command).toBe('claude');
    expect(d.runs).toEqual([]);
    expect(existsSync(join(home, '.cache'))).toBe(false);
  });

  it('rejects unknown runners before creating a vault and reports incompatible Codex Node in the summary', async () => {
    expect(await runCli(['setup', '--runner', 'bash'], io)).toBe(2);
    expect(existsSync(ppHome)).toBe(false);
    d.capture = () => ({ code: 0, stdout: 'v22.11.0', stderr: '' });
    expect(await runCli(['setup', '--runner', 'codex', '--yes', '--no-kev', '--no-mcp', '--no-schedules'], io)).toBe(1);
    expect(text()).toContain('Node 22.12 or newer');
    expect(text()).toContain('fix: upgrade Node, rerun ./install.sh with the upgraded Node to refresh the pinned launchers, then pp setup');
    expect(text()).toMatch(/FAIL {2}browser/);
    expect(d.runs).toEqual([]);
  });

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

  it('schedules (#29): --yes installs the OS jobs (temp HOME); --no-schedules skips them', async () => {
    expect(await runCli(['setup', '--yes', '--no-kev', '--no-mcp', '--no-schedules'], io)).toBe(0);
    expect(text()).toMatch(/skip {2}schedules +--no-schedules/);
    expect(existsSync(join(home, 'Library', 'LaunchAgents'))).toBe(false);
    out.length = 0;
    expect(await runCli(['setup', '--yes', '--no-kev', '--no-mcp'], io)).toBe(0);
    expect(existsSync(join(home, 'Library', 'LaunchAgents', 'com.perfectplacement.scout_score.plist'))).toBe(true);
    expect(text()).toMatch(/ok {4}schedules +launchd jobs: inbox daily 07:30, freshness daily 06:30, scout_score fri 05:30/);
    expect(d.captures.some((c) => c.cmd === 'launchctl' && c.args[0] === 'bootstrap')).toBe(true);
  });

  it('registers only detected clients, asking first for each', async () => {
    d.which = (c) => (c === 'claude' ? '/usr/bin/claude' : c === 'uv' || c === 'git' ? `/usr/bin/${c}` : null);
    d.capture = (cmd, args) => {
      d.captures.push({ cmd, args });
      return args[1] === 'get' ? { code: 1, stdout: '', stderr: 'No MCP server named "pp"' } : { code: 0, stdout: '', stderr: '' };
    };
    mkdirSync(join(home, '.cursor'));
    answers = [false, true, false, false]; // Kev? no. Claude Code? yes. Cursor? no. Schedules? no.
    expect(await runCli(['setup'], io)).toBe(0);
    expect(asked).toEqual([
      'Install Kev, the optional local decision model (multi-GB download)?',
      'Register pp with Claude Code?',
      'Register pp with Cursor?',
      'Run schedules even when pp is closed (inbox daily 07:30, freshness daily 06:30, scout_score fri 05:30) as launchd jobs?',
    ]);
    expect(text()).toContain('schedules: skipped (pp up still catches up missed runs; pp schedules install later)');
    expect(existsSync(join(home, 'Library', 'LaunchAgents'))).toBe(false);
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
    expect(text()).toContain('mcp: Cursor: restart Cursor; then ask it to call the pp tools');
    expect(await runCli(['setup', '--mcp', 'nope'], io)).toBe(2);
  });

  it('Claude Desktop: says to quit (Cmd+Q) and reopen, where pp shows, and again when already registered', async () => {
    const dir = join(home, 'Library', 'Application Support', 'Claude');
    mkdirSync(dir, { recursive: true });
    const hint = 'mcp: Claude Desktop: Quit Claude Desktop (Cmd+Q) and reopen it; pp appears under Settings > Developer';
    expect(await runCli(['setup', '--yes', '--no-kev', '--mcp', 'claude-desktop'], io)).toBe(0);
    const cfg = JSON.parse(readFileSync(join(dir, 'claude_desktop_config.json'), 'utf8'));
    expect(cfg.mcpServers.pp.env).toEqual({ PP_HOME: ppHome });
    expect(text()).toContain(hint);
    out.length = 0;
    expect(await runCli(['setup', '--yes', '--no-kev', '--mcp', 'claude-desktop'], io)).toBe(0);
    expect(text()).toContain('mcp: Claude Desktop: already registered');
    expect(text()).toContain(hint);
  });

  it('restart hints: one per client, never for a skipped one', async () => {
    expect(restartHint('claude-code')).toBe('restart Claude Code; then ask it to call the pp tools');
    expect(restartHint('codex')).toBe('restart Codex; then ask it to call the pp tools');
    expect(restartHint('claude-desktop', 'win32')).toBe('Quit Claude Desktop fully and reopen it; pp appears under Settings > Developer');
    mkdirSync(join(home, '.cursor'));
    answers = [false];
    expect(await runCli(['setup', '--no-kev', '--mcp', 'cursor'], io)).toBe(0);
    expect(text()).toContain('mcp: Cursor: skipped');
    expect(text()).not.toContain('restart Cursor');
  });

  it('ends with a summary of every step, failures marked with the fix, and exits 1 on a failure', async () => {
    mkdirSync(join(home, '.cursor'));
    writeFileSync(join(home, '.cursor', 'mcp.json'), '{not json');
    expect(await runCli(['setup', '--yes', '--no-kev', '--mcp', 'cursor,codex'], io)).toBe(1);
    const tail = out.slice(out.indexOf('Setup summary:'));
    expect(out.at(-1)).toBe('setup: 1 step(s) failed (fixes above); rerun pp setup when done');
    expect(tail.join('\n')).toMatch(/ok {4}vault +.+\(created\)/);
    expect(tail.join('\n')).toMatch(/skip {2}kev +--no-kev/);
    expect(tail.join('\n')).toMatch(/FAIL {2}mcp Cursor +not valid JSON/);
    expect(tail.join('\n')).toMatch(/fix: fix .+mcp\.json, then pp setup --mcp cursor/);
    expect(tail.join('\n')).toMatch(/skip {2}mcp Codex +not found on this machine/);
    expect(summaryLines([{ step: 'vault', result: 'ok', detail: 'x' }]).at(-1)).toBe('setup: all done');
  });

  it('yes to Kev with uv missing: declining uv ends in a marked failure with the fix', async () => {
    d.which = (c) => (c === 'git' || c === 'brew' ? `/usr/bin/${c}` : null);
    answers = [true, false]; // Kev? yes. Install uv? no.
    expect(await runCli(['setup', '--no-mcp'], io)).toBe(1);
    expect(asked[1]).toBe('Kev needs uv (Python package manager), which is missing. Install it now with: brew install uv?');
    expect(d.runs).toEqual([]);
    expect(existsSync(kevPaths(ppHome).state)).toBe(false);
    expect(text()).toMatch(/FAIL {2}kev +not installed: uv is missing/);
    expect(text()).toContain('fix: brew install uv && pp kev install');
    expect(out.at(-1)).toContain('1 step(s) failed');
  });

  it('yes to Kev with uv missing: installs uv with brew (after asking), then Kev', async () => {
    const bins = new Set(['git', 'brew']);
    d.which = (c) => (bins.has(c) ? `/usr/bin/${c}` : null);
    const run = d.run;
    d.run = async (cmd, args, opts) => {
      if (cmd === '/usr/bin/brew') bins.add('uv');
      return run(cmd, args, opts);
    };
    answers = [true, true];
    expect(await runCli(['setup', '--no-mcp'], io)).toBe(0);
    expect(d.runs.map((r) => [r.cmd, r.args[0]])).toEqual([
      ['/usr/bin/brew', 'install'],
      ['/usr/bin/git', 'clone'],
      ['/usr/bin/uv', 'sync'],
    ]);
    expect(existsSync(kevPaths(ppHome).state)).toBe(true);
    expect(text()).toContain('The model downloads on the first start');
    expect(text()).toMatch(/ok {4}kev +installed \(model kev-4b\); the model downloads on first start/);
    expect(out.at(-1)).toBe('setup: all done');
  });

  it('uv via the official installer into ~/.local/bin (not on PATH) is picked up for this run', async () => {
    d.platform = 'linux';
    d.arch = 'x64';
    d.env = { PATH: '/usr/bin' };
    const fake = join(root, 'fakebin');
    mkdirSync(fake);
    for (const b of ['git', 'nvidia-smi']) {
      writeFileSync(join(fake, b), '#!/bin/sh\n');
      chmodSync(join(fake, b), 0o755);
    }
    d.env.PATH = fake;
    d.which = (c) => whichIn(c, d.env.PATH);
    const run = d.run;
    d.run = async (cmd, args, opts) => {
      if (cmd === 'sh') {
        mkdirSync(join(home, '.local', 'bin'), { recursive: true });
        writeFileSync(join(home, '.local', 'bin', 'uv'), '#!/bin/sh\n');
        chmodSync(join(home, '.local', 'bin', 'uv'), 0o755);
      }
      return run(cmd, args, opts);
    };
    expect(await runCli(['setup', '--yes', '--kev', '--no-mcp'], io)).toBe(0);
    expect(d.runs[0]).toMatchObject({ cmd: 'sh', args: ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'] });
    expect(d.runs[2]?.cmd).toBe(join(home, '.local', 'bin', 'uv'));
    expect(text()).toContain(`add it to your shell profile: export PATH="${join(home, '.local', 'bin')}:$PATH"`);
  });

  it('a failed uv install is a marked failure, not silent', async () => {
    d.which = (c) => (c === 'git' ? '/usr/bin/git' : null);
    d.run = async (cmd, args) => {
      d.runs.push({ cmd, args });
      return 7;
    };
    expect(await runCli(['setup', '--yes', '--kev', '--no-mcp'], io)).toBe(1);
    expect(err.join('\n')).toContain('kev: installing uv failed (exit 7)');
    expect(text()).toContain('fix: curl -LsSf https://astral.sh/uv/install.sh | sh && pp kev install');
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

  it('says Kev is not installed (not down) and starts nothing', async () => {
    await runCli(['setup', '--yes', '--no-kev', '--no-mcp'], io);
    out.length = 0;
    expect(await upOnce(['--kev'])).toBe(0);
    expect(d.spawned).toEqual([]);
    expect(text()).toContain('kev: not installed (pp kev install adds it)');
    expect(text()).toContain('kev: not installed (run pp kev install)');
    expect(text()).not.toContain('unreachable');
  });
});
