import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runners } from '@perfect-placement/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processIo } from '../io.js';
import { browserDoctor, browserRuntimeFor, installBrowser } from './browser.js';
import { type FakeDeps, fakeDeps } from './fake-deps.test-helpers.js';
import { RUNNER_MACHINE, runnerDoctorChecks, runnerSetupSteps } from './runners.js';

let root: string;
let d: FakeDeps;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pp-browser-install-'));
  d = fakeDeps(root, { bins: ['corepack'] });
  d.capture = (cmd, args) => {
    d.captures.push({ cmd, args });
    return { code: 0, stdout: cmd === d.nodePath ? 'v22.12.0\n' : '9.15.9\n', stderr: '' };
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fakeInstall() {
  const runtime = browserRuntimeFor(d);
  d.run = async (cmd, args, opts) => {
    d.runs.push({ cmd, args, cwd: opts?.cwd });
    for (const path of runtime.patchPaths) {
      expect(readFileSync(join(opts?.cwd as string, path))).toEqual(readFileSync(join(runtime.manifestDir, path)));
    }
    const bin = join(opts?.cwd as string, runners.BROWSER_ENTRY);
    mkdirSync(dirname(bin), { recursive: true });
    writeFileSync(bin, '// synthetic browser');
    writeFileSync(join(opts?.cwd as string, 'node_modules/chrome-devtools-mcp/package.json'), '{"version":"1.10.1"}');
    return 0;
  };
}

describe('optional Codex browser installation', () => {
  it('installs a frozen standalone runtime once through Corepack and publishes it only when complete', async () => {
    fakeInstall();
    const runtime = browserRuntimeFor(d);
    expect(browserDoctor(d).ok).toBe(false);
    await installBrowser(d);
    expect(d.runs).toEqual([
      {
        cmd: '/usr/bin/corepack',
        args: ['pnpm@9.15.9', 'install', '--ignore-workspace', '--frozen-lockfile', '--ignore-scripts', '--prod'],
        cwd: expect.stringContaining('.install-'),
      },
    ]);
    expect(runners.browserReadiness(runtime).ok).toBe(true);
    expect(readdirSync(runtime.cacheRoot)).toEqual([runtime.fingerprint]);
    await installBrowser(d);
    expect(d.runs).toHaveLength(1);
    expect(browserDoctor(d).ok).toBe(true);
  });

  it('cleans failed staging, rejects incomplete installs, and can repair an incomplete published runtime', async () => {
    const runtime = browserRuntimeFor(d);
    d.run = async () => 1;
    await expect(installBrowser(d)).rejects.toThrow('exit 1');
    expect(existsSync(runtime.dir)).toBe(false);
    expect(readdirSync(runtime.cacheRoot)).toEqual([]);
    d.run = async () => 0;
    await expect(installBrowser(d)).rejects.toThrow('expected locked executable');
    expect(readdirSync(runtime.cacheRoot)).toEqual([]);
    mkdirSync(runtime.dir);
    fakeInstall();
    await installBrowser(d);
    expect(runners.browserReadiness(runtime).ok).toBe(true);
    expect(readdirSync(runtime.cacheRoot)).toEqual([runtime.fingerprint]);
  });

  it('requires a usable pinned package manager and supported Node, with no global installation fallback', async () => {
    d.which = () => null;
    await expect(installBrowser(d)).rejects.toThrow('pnpm@9.15.9 or Corepack');
    expect(d.runs).toEqual([]);
    d.which = (cmd) => (cmd === 'pnpm' ? '/usr/bin/pnpm' : null);
    fakeInstall();
    await installBrowser(d);
    expect(d.runs[0]?.cmd).toBe('/usr/bin/pnpm');
    d.capture = () => ({ code: 0, stdout: 'v22.11.0', stderr: '' });
    await expect(installBrowser(d)).rejects.toThrow('Node 22.12');
  });

  it('does not replace an installation while another setup is publishing it', async () => {
    fakeInstall();
    const runtime = browserRuntimeFor(d);
    const lock = join(runtime.cacheRoot, `.publish-${runtime.fingerprint}`);
    mkdirSync(lock, { recursive: true });
    await expect(installBrowser(d)).rejects.toThrow('Another browser setup is publishing');
    expect(existsSync(runtime.dir)).toBe(false);
    expect(readdirSync(runtime.cacheRoot)).toEqual([`.publish-${runtime.fingerprint}`]);
  });

  it('keeps a completed runtime intact when installing a changed patch fails', async () => {
    fakeInstall();
    const previous = browserRuntimeFor(d);
    await installBrowser(d, previous);
    const previousBin = readFileSync(previous.bin);
    const repoRoot = join(root, 'changed-repo');
    const manifestDir = join(repoRoot, 'runtimes/browser');
    for (const path of ['package.json', 'pnpm-lock.yaml', ...previous.patchPaths]) {
      mkdirSync(dirname(join(manifestDir, path)), { recursive: true });
      copyFileSync(join(previous.manifestDir, path), join(manifestDir, path));
    }
    writeFileSync(join(manifestDir, previous.patchPaths[0] as string), 'changed patch');
    const changed = runners.browserRuntime({ repoRoot, userHome: d.home, env: d.env });
    expect(changed.dir).not.toBe(previous.dir);
    d.run = async () => 1;
    await expect(installBrowser(d, changed)).rejects.toThrow('exit 1');
    expect(runners.browserReadiness(previous).ok).toBe(true);
    expect(readFileSync(previous.bin)).toEqual(previousBin);
    expect(readdirSync(previous.cacheRoot)).toEqual([previous.fingerprint]);
  });

  it('only Codex has a setup step and doctor check; other runners never look up runtime state', async () => {
    expect(runnerDoctorChecks('claude', d)).toEqual([]);
    expect(runnerDoctorChecks('cursor-agent', d)).toEqual([]);
    expect(await runnerSetupSteps('claude', processIo, d, true)).toEqual([]);
    expect(await runnerSetupSteps('cursor-agent', processIo, d, true)).toEqual([]);
    expect(RUNNER_MACHINE.codex.doctor).toBe(browserDoctor);
    expect(d.captures).toEqual([]);
    expect(existsSync(join(root, '.cache'))).toBe(false);
  });
});
