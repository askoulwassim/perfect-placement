/** Optional machine runtime. Install only from setup; never from a run or into the vault. */
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type db, runners } from '@perfect-placement/engine';
import type { SetupStep } from '../commands/setup.js';
import { confirm, type Io } from '../io.js';
import type { SystemDeps } from './deps.js';

export const browserRuntimeFor = (d: Pick<SystemDeps, 'home' | 'env'>) => runners.browserRuntime({ userHome: d.home, env: d.env });

export function browserNodeCheck(d: Pick<SystemDeps, 'nodePath' | 'capture'>): { ok: boolean; detail: string } {
  const version = d.capture(d.nodePath, ['--version']);
  return version.code === 0 && runners.browserNodeCompatible(version.stdout)
    ? { ok: true, detail: version.stdout.trim() }
    : {
        ok: false,
        detail:
          'Browser support needs Node 22.12 or newer. Upgrade Node, rerun ./install.sh with the upgraded Node to refresh the pinned launchers, then run pp setup',
      };
}

function packageManager(d: SystemDeps, runtime: runners.BrowserRuntime): { command: string; args: string[] } {
  const corepack = d.which('corepack');
  if (corepack) return { command: corepack, args: [runtime.packageManager] };
  const pnpm = d.which('pnpm');
  if (pnpm) {
    const version = d.capture(pnpm, ['--version']);
    if (version.code === 0 && version.stdout.trim() === runtime.packageManager.slice('pnpm@'.length)) return { command: pnpm, args: [] };
  }
  throw new Error(`Browser setup needs ${runtime.packageManager} or Corepack. Install it, then run pp setup`);
}

export async function installBrowser(d: SystemDeps, runtime = browserRuntimeFor(d)): Promise<void> {
  const node = browserNodeCheck(d);
  if (!node.ok) throw new Error(node.detail);
  if (runners.browserReadiness(runtime).ok) return;
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
    if (code !== 0) throw new Error(`Browser install failed (exit ${code}). Run pp setup to retry`);
    writeFileSync(join(staging, 'installed.json'), `${JSON.stringify({ fingerprint: runtime.fingerprint })}\n`);
    const staged = { ...runtime, dir: staging, bin: join(staging, runners.BROWSER_ENTRY) };
    if (!runners.browserReadiness(staged).ok) throw new Error('Browser install did not produce the expected locked executable');
    // Serialize the short, synchronous publication step. Recheck after acquiring it so a second
    // repair cannot rename or delete the complete installation a concurrent setup just published.
    const lock = join(runtime.cacheRoot, `.publish-${runtime.fingerprint}`);
    try {
      mkdirSync(lock);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (runners.browserReadiness(runtime).ok) return;
      throw new Error(
        `Another browser setup is publishing. Retry pp setup. If no setup is running, remove the stale lock directory ${lock}`,
      );
    }
    try {
      if (runners.browserReadiness(runtime).ok) return;
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

/** `pp setup`'s step for a runner that uses the PP browser adapter (Codex, Cursor): install the pinned browser runtime, asked first. */
export async function setupBrowser(io: Io, d: SystemDeps, yes: boolean): Promise<SetupStep> {
  const step = 'browser';
  try {
    const node = browserNodeCheck(d);
    if (!node.ok)
      return {
        step,
        result: 'failed',
        detail: node.detail,
        fix: 'upgrade Node, rerun ./install.sh with the upgraded Node to refresh the pinned launchers, then pp setup',
      };
    const runtime = browserRuntimeFor(d);
    if (runners.browserReadiness(runtime).ok)
      return { step, result: 'ok', detail: `chrome-devtools-mcp ${runtime.packageVersion} installed` };
    if (!(await confirm(io, yes, `Install browser support (chrome-devtools-mcp ${runtime.packageVersion})?`, true)))
      return { step, result: 'skipped', detail: 'declined (add later: pp setup)' };
    await installBrowser(d, runtime);
    io.out('browser: enable remote debugging at chrome://inspect/#remote-debugging, then Allow the Chrome connection prompt');
    return { step, result: 'ok', detail: `chrome-devtools-mcp ${runtime.packageVersion} installed` };
  } catch (e) {
    return { step, result: 'failed', detail: (e as Error).message, fix: 'pp setup' };
  }
}

/** `pp doctor`'s check for those runners: Node new enough and the pinned browser runtime installed. */
export function browserDoctor(d: SystemDeps): db.DoctorResult['checks'][number] {
  const node = browserNodeCheck(d);
  if (!node.ok) return { name: 'browser_runtime', ...node };
  return { name: 'browser_runtime', ...runners.browserReadiness(browserRuntimeFor(d)) };
}
