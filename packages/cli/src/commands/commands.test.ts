import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '@perfect-placement/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import type { Io } from '../io.js';

let tmp: string;
let out: string[];
let err: string[];
let io: Io;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pp-cmd-'));
  out = [];
  err = [];
  io = { env: {}, out: (l) => out.push(l), err: (l) => err.push(l), stdin: () => '' };
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('pp init', () => {
  it('creates a vault with the default config and refuses an existing one', async () => {
    const home = join(tmp, 'vault');
    expect(await runCli(['init', '--home', home], io)).toBe(0);
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))).toEqual(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
    expect(existsSync(join(home, 'pp.db'))).toBe(true);
    expect(await runCli(['init', '--home', home], io)).toBe(1);
    expect(err.at(-1)).toMatch(/already exists/);
  });

  it('refuses a home inside a git repo', async () => {
    mkdirSync(join(tmp, 'repo', '.git'), { recursive: true });
    expect(await runCli(['init', '--home', join(tmp, 'repo', 'vault')], io)).toBe(1);
    expect(err.at(-1)).toMatch(/git repo/);
    expect(existsSync(join(tmp, 'repo', 'vault'))).toBe(false);
  });

  it('uses PP_HOME when --home is absent', async () => {
    io.env = { PP_HOME: join(tmp, 'env-home') };
    expect(await runCli(['init'], io)).toBe(0);
    expect(existsSync(join(tmp, 'env-home', 'config.json'))).toBe(true);
  });
});

describe('pp doctor', () => {
  it('reports a missing vault without creating one', async () => {
    const home = join(tmp, 'missing');
    expect(await runCli(['doctor', '--home', home], io)).toBe(1);
    expect(existsSync(home)).toBe(false);
  });

  it('runs system.doctor through the engine on a fresh vault', async () => {
    const home = join(tmp, 'vault');
    await runCli(['init', '--home', home], io);
    const code = await runCli(['doctor', '--home', home], io);
    expect(out.some((l) => l.startsWith('pp doctor:'))).toBe(true);
    expect(out.some((l) => /^(ok|FAIL)/.test(l))).toBe(true);
    expect(code).toBe(out.some((l) => l.startsWith('FAIL')) ? 1 : 0);
  });
});

describe('fresh start', () => {
  it('init then doctor: the new vault passes every db check', async () => {
    const home = join(tmp, 'home');
    expect(await runCli(['init', '--home', home], io)).toBe(0);
    await runCli(['doctor', '--home', home, '--json'], io);
    const res = JSON.parse(out.at(-1) as string) as { checks: { name: string; ok: boolean }[] };
    const dbChecks = res.checks.filter((c) => !['pp_home_not_in_git', 'no_claude_md'].includes(c.name));
    expect(dbChecks.length).toBeGreaterThan(3);
    expect(dbChecks.filter((c) => !c.ok)).toEqual([]);
  });

  it('init refuses a PP_HOME inside a git repo', async () => {
    mkdirSync(join(tmp, 'repo', '.git'), { recursive: true });
    writeFileSync(join(tmp, 'repo', 'README.md'), 'x');
    expect(await runCli(['init', '--home', join(tmp, 'repo', 'vault')], io)).toBe(1);
    expect(err.at(-1)).toMatch(/inside the git repo/);
    expect(existsSync(join(tmp, 'repo', 'vault'))).toBe(false);
  });

  it('migrate is not a command', async () => {
    expect(await runCli(['migrate'], io)).toBe(1);
    expect(err.at(-1)).toMatch(/unknown command/);
  });
});
