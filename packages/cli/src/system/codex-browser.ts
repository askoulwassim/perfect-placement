/** Optional machine runtime. Install only from setup; never from a run or into the vault. */
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type db, ops } from '@perfect-placement/engine';
import type { SystemDeps } from './deps.js';

export const browserRuntimeFor = (d: Pick<SystemDeps, 'home' | 'env'>) => ops.codexBrowserRuntime({ userHome: d.home, env: d.env });

export function browserNodeCheck(d: Pick<SystemDeps, 'nodePath' | 'capture'>): { ok: boolean; detail: string } {
  const version = d.capture(d.nodePath, ['--version']);
  return version.code === 0 && ops.codexBrowserNodeCompatible(version.stdout)
    ? { ok: true, detail: version.stdout.trim() }
    : {
        ok: false,
        detail:
          'Codex browser support needs Node 22.12 or newer. Upgrade Node, rerun ./install.sh with the upgraded Node to refresh the pinned launchers, then run pp setup --runner codex',
      };
}

function packageManager(d: SystemDeps, runtime: ops.CodexBrowserRuntime): { command: string; args: string[] } {
  const corepack = d.which('corepack');
  if (corepack) return { command: corepack, args: [runtime.packageManager] };
  const pnpm = d.which('pnpm');
  if (pnpm) {
    const version = d.capture(pnpm, ['--version']);
    if (version.code === 0 && version.stdout.trim() === runtime.packageManager.slice('pnpm@'.length)) return { command: pnpm, args: [] };
  }
  throw new Error(`Browser setup needs ${runtime.packageManager} or Corepack. Install it, then run pp setup --runner codex`);
}

export async function installCodexBrowser(d: SystemDeps, runtime = browserRuntimeFor(d)): Promise<void> {
  const node = browserNodeCheck(d);
  if (!node.ok) throw new Error(node.detail);
  if (ops.codexBrowserReadiness(runtime).ok) return;
  const manager = packageManager(d, runtime);
  mkdirSync(runtime.cacheRoot, { recursive: true });
  const staging = mkdtempSync(join(runtime.cacheRoot, '.install-'));
  try {
    copyFileSync(runtime.manifestPath, join(staging, 'package.json'));
    copyFileSync(runtime.lockfilePath, join(staging, 'pnpm-lock.yaml'));
    for (const path of runtime.patchPaths) {
      const target = join(staging, path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(runtime.manifestDir, path), target);
    }
    const code = await d.run(
      manager.command,
      [...manager.args, 'install', '--ignore-workspace', '--frozen-lockfile', '--ignore-scripts', '--prod'],
      { cwd: staging },
    );
    if (code !== 0) throw new Error(`Browser install failed (exit ${code}). Run pp setup --runner codex to retry`);
    writeFileSync(join(staging, 'installed.json'), `${JSON.stringify({ fingerprint: runtime.fingerprint })}\n`);
    const staged = { ...runtime, dir: staging, bin: join(staging, ops.CODEX_BROWSER_ENTRY) };
    if (!ops.codexBrowserReadiness(staged).ok) throw new Error('Browser install did not produce the expected locked executable');
    // Serialize the short, synchronous publication step. Recheck after acquiring it so a second
    // repair cannot rename or delete the complete installation a concurrent setup just published.
    const lock = join(runtime.cacheRoot, `.publish-${runtime.fingerprint}`);
    try {
      mkdirSync(lock);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (ops.codexBrowserReadiness(runtime).ok) return;
      throw new Error(
        `Another browser setup is publishing. Retry pp setup --runner codex. If no setup is running, remove the stale lock directory ${lock}`,
      );
    }
    try {
      if (ops.codexBrowserReadiness(runtime).ok) return;
      if (existsSync(runtime.dir)) {
        if (lstatSync(runtime.dir).isSymbolicLink()) throw new Error(`Refusing to replace a linked browser runtime: ${runtime.dir}`);
        const damaged = `${staging}-incomplete`;
        renameSync(runtime.dir, damaged);
        try {
          renameSync(staging, runtime.dir);
        } finally {
          rmSync(damaged, { recursive: true, force: true });
        }
      } else renameSync(staging, runtime.dir);
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function codexBrowserDoctor(runner: string, d: SystemDeps): db.DoctorResult['checks'][number] {
  if (runner !== 'codex') return { name: 'codex_browser', ok: true, detail: 'not needed for the selected runner' };
  const node = browserNodeCheck(d);
  if (!node.ok) return { name: 'codex_browser', ...node };
  return { name: 'codex_browser', ...ops.codexBrowserReadiness(browserRuntimeFor(d)) };
}
