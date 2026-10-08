import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '@perfect-placement/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeSyntheticV1 } from '../../../engine/db/testing/synthetic-v1.js';
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

describe('pp migrate (synthetic v1 only)', () => {
  beforeEach(() => writeSyntheticV1(join(tmp, 'v1')));

  it('dry run writes nothing', async () => {
    const home = join(tmp, 'home');
    expect(await runCli(['migrate', '--from', join(tmp, 'v1'), '--home', home, '--dry-run'], io)).toBe(0);
    expect(out[0]).toMatch(/^dry run:/);
    expect(existsSync(join(home, 'pp.db'))).toBe(false);
  });

  it('migrates, then doctor runs through the engine', async () => {
    const home = join(tmp, 'home');
    expect(await runCli(['migrate', '--from', join(tmp, 'v1'), '--home', home], io)).toBe(0);
    expect(await runCli(['doctor', '--home', home, '--json'], io)).toBe(0);
    expect(JSON.parse(out.at(-1) as string).ok).toBe(true);
  });

  it('refuses a PP_HOME inside a git repo, even for a dry run', async () => {
    mkdirSync(join(tmp, 'repo', '.git'), { recursive: true });
    writeFileSync(join(tmp, 'repo', 'README.md'), 'x');
    for (const extra of [[], ['--dry-run']]) {
      expect(await runCli(['migrate', '--from', join(tmp, 'v1'), '--home', join(tmp, 'repo', 'vault'), ...extra], io)).toBe(1);
      expect(err.at(-1)).toMatch(/inside the git repo/);
    }
    expect(existsSync(join(tmp, 'repo', 'vault'))).toBe(false);
  });
});
