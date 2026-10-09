/*
 * ./install.sh --check: reports only (never builds, links or writes). Runs with a temp bin dir and
 * a controlled PATH; shellcheck runs when it is on PATH (CI installs it).
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { whichIn } from './system/deps.js';

const INSTALL = fileURLToPath(new URL('../../../install.sh', import.meta.url));
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pp-install-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const check = (env: NodeJS.ProcessEnv) => spawnSync('sh', [INSTALL, '--check', '--bin-dir', join(tmp, 'bin')], { encoding: 'utf8', env });
const sysPath = '/usr/bin:/bin:/usr/sbin:/sbin';

describe('install.sh --check', () => {
  it('reports a missing Node with a fix and changes nothing', () => {
    const r = check({ HOME: tmp, PATH: sysPath, PP_NODE_KEGS: '' });
    const hasSystemNode = whichIn('node', sysPath) !== null;
    expect(r.stdout).toContain('checking prerequisites');
    if (!hasSystemNode) {
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/MISS {2}node >= 22\n {8}fix: /);
    }
    expect(existsSync(join(tmp, 'bin'))).toBe(false);
  });

  it('finds a Homebrew node@22 keg that is not on PATH and prints the PATH line', () => {
    const keg = join(tmp, 'keg', 'bin');
    mkdirSync(keg, { recursive: true });
    writeFileSync(join(keg, 'node'), '#!/bin/sh\necho 22\n');
    chmodSync(join(keg, 'node'), 0o755);
    const r = check({ HOME: tmp, PATH: sysPath, PP_NODE_KEGS: keg });
    if (whichIn('node', sysPath) === null) {
      expect(r.stdout).toContain(`(Homebrew keg ${keg}, not on your PATH)`);
      expect(r.stdout).toContain(`export PATH="${keg}:$PATH"`);
    }
    expect(r.stdout).toContain(`${join(tmp, 'bin')} is not on PATH`);
    expect(existsSync(join(tmp, 'bin'))).toBe(false);
  });

  it('passes with the current node toolchain', () => {
    const r = check({ HOME: tmp, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` });
    expect(r.stdout).toMatch(/ok {4}node v2\d/);
    expect(existsSync(join(tmp, 'bin'))).toBe(false);
  });

  it('reports uv as optional (for Kev): a note with the fix when missing, never a MISS', () => {
    const bin = join(tmp, 'tools');
    mkdirSync(bin);
    const missing = check({ HOME: tmp, PATH: `${dirname(process.execPath)}:${sysPath}` });
    if (whichIn('uv', sysPath) === null) {
      expect(missing.stdout).toMatch(/note {2}uv not found: optional, needed only for Kev .+install: /);
      expect(missing.stdout).not.toMatch(/MISS {2}uv/);
    }
    writeFileSync(join(bin, 'uv'), '#!/bin/sh\necho "uv 0.9.0"\n');
    chmodSync(join(bin, 'uv'), 0o755);
    const found = check({ HOME: tmp, PATH: `${bin}:${dirname(process.execPath)}:${sysPath}` });
    expect(found.stdout).toContain('ok    uv 0.9.0 (for Kev)');
    expect(existsSync(join(tmp, 'bin'))).toBe(false);
  });

  it.skipIf(whichIn('shellcheck', process.env.PATH) === null)('is shellcheck-clean', () => {
    const r = spawnSync('shellcheck', ['-s', 'sh', INSTALL], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
