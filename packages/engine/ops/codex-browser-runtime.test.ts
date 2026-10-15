import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexBrowserNodeCompatible, codexBrowserReadiness, codexBrowserRuntime } from './codex-browser-runtime.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pp-browser-runtime-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fixture() {
  const dir = join(root, 'repo', 'runtimes', 'codex-browser');
  mkdirSync(join(dir, 'patches'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      packageManager: 'pnpm@9.15.9',
      dependencies: { 'chrome-devtools-mcp': '1.10.1' },
      pnpm: { patchedDependencies: { 'chrome-devtools-mcp@1.10.1': 'patches/browser.patch' } },
    }),
  );
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'synthetic locked contents');
  writeFileSync(join(dir, 'patches/browser.patch'), 'synthetic direct-upload patch');
  return { repoRoot: join(root, 'repo'), userHome: join(root, 'user'), env: {} };
}

describe('Codex browser runtime description', () => {
  it('uses an external cache whose identity includes manifest, lock and exact patch bytes', () => {
    const opts = fixture();
    const runtime = codexBrowserRuntime(opts);
    expect(runtime.cacheRoot).toBe(join(root, 'user', '.cache', 'perfect-placement', 'codex-browser'));
    expect(runtime.bin.startsWith(runtime.dir)).toBe(true);
    writeFileSync(join(runtime.manifestDir, runtime.patchPaths[0] as string), 'changed direct-upload patch');
    const patched = codexBrowserRuntime(opts);
    expect(patched.dir).not.toBe(runtime.dir);
    writeFileSync(runtime.lockfilePath, 'changed dependency integrity');
    expect(codexBrowserRuntime(opts).dir).not.toBe(patched.dir);
    expect(codexBrowserRuntime({ ...opts, env: { XDG_CACHE_HOME: join(root, 'cache') } }).cacheRoot).toBe(
      join(root, 'cache', 'perfect-placement', 'codex-browser'),
    );
    expect(codexBrowserRuntime({ ...opts, env: { XDG_CACHE_HOME: 'relative' } }).cacheRoot).toBe(runtime.cacheRoot);
  });

  it('requires complete matching metadata and an executable inside the runtime', () => {
    const runtime = codexBrowserRuntime(fixture());
    expect(codexBrowserReadiness(runtime)).toMatchObject({ ok: false, detail: expect.stringContaining('pp setup --runner codex') });
    mkdirSync(dirname(runtime.bin), { recursive: true });
    writeFileSync(runtime.bin, '// synthetic executable');
    copyFileSync(runtime.manifestPath, join(runtime.dir, 'package.json'));
    copyFileSync(runtime.lockfilePath, join(runtime.dir, 'pnpm-lock.yaml'));
    for (const path of runtime.patchPaths) {
      mkdirSync(dirname(join(runtime.dir, path)), { recursive: true });
      copyFileSync(join(runtime.manifestDir, path), join(runtime.dir, path));
    }
    const packagePath = join(runtime.dir, 'node_modules/chrome-devtools-mcp/package.json');
    writeFileSync(packagePath, JSON.stringify({ version: '1.10.1' }));
    expect(codexBrowserReadiness(runtime).ok).toBe(false);
    writeFileSync(join(runtime.dir, 'installed.json'), JSON.stringify({ fingerprint: runtime.fingerprint }));
    expect(codexBrowserReadiness(runtime).ok).toBe(true);
    const installedPatch = join(runtime.dir, runtime.patchPaths[0] as string);
    writeFileSync(installedPatch, 'malformed or changed patch');
    expect(codexBrowserReadiness(runtime).ok).toBe(false);
    rmSync(installedPatch);
    expect(codexBrowserReadiness(runtime).ok).toBe(false);
    copyFileSync(join(runtime.manifestDir, runtime.patchPaths[0] as string), installedPatch);
    expect(codexBrowserReadiness(runtime).ok).toBe(true);
    writeFileSync(packagePath, JSON.stringify({ version: '1.10.2' }));
    expect(codexBrowserReadiness(runtime).ok).toBe(false);
    writeFileSync(packagePath, JSON.stringify({ version: '1.10.1' }));
    const outside = join(root, 'outside.js');
    writeFileSync(outside, readFileSync(runtime.bin));
    rmSync(runtime.bin);
    symlinkSync(outside, runtime.bin);
    expect(codexBrowserReadiness(runtime).ok).toBe(false);
  });

  it('requires the upload patch and refuses patch paths outside the runtime manifest', () => {
    const opts = fixture();
    const manifestPath = join(opts.repoRoot, 'runtimes/codex-browser/package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    delete manifest.pnpm;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => codexBrowserRuntime(opts)).toThrow('direct-file-upload patch');
    for (const path of ['../outside.patch', '/outside.patch']) {
      manifest.pnpm = { patchedDependencies: { 'chrome-devtools-mcp@1.10.1': path } };
      writeFileSync(manifestPath, JSON.stringify(manifest));
      expect(() => codexBrowserRuntime(opts)).toThrow('within the manifest directory');
    }
  });

  it('checks the package Node requirement without raising requirements for other runners', () => {
    for (const version of ['v22.0.0', 'v22.11.9', 'v20.19.0', 'unknown']) expect(codexBrowserNodeCompatible(version)).toBe(false);
    for (const version of ['v22.12.0', 'v24.22.0', 'v23.0.0']) expect(codexBrowserNodeCompatible(version)).toBe(true);
  });
});
