/** Read-only description of the optional browser runtime installed by pp setup. Never downloads. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CODEX_BROWSER_ENTRY = 'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js';
export const CODEX_BROWSER_SETUP = 'Run pp setup --runner codex';

export interface CodexBrowserRuntime {
  manifestDir: string;
  manifestPath: string;
  lockfilePath: string;
  /** Paths relative to manifestDir, copied with the manifest and included byte-for-byte in the identity. */
  patchPaths: string[];
  packageVersion: string;
  packageManager: string;
  fingerprint: string;
  cacheRoot: string;
  dir: string;
  bin: string;
}

function repoRoot(): string {
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    if (dirname(dir) === dir) throw new Error('Cannot locate the PP browser runtime manifest');
  }
}

export function codexBrowserFingerprint(
  manifest: string,
  lockfile: string,
  patches: ReadonlyArray<{ path: string; contents: Uint8Array }> = [],
): string {
  const hash = createHash('sha256').update(manifest).update('\0').update(lockfile);
  for (const patch of patches) hash.update('\0').update(patch.path).update('\0').update(patch.contents);
  return hash.digest('hex');
}

const readPatches = (dir: string, paths: string[]) => paths.map((path) => ({ path, contents: readFileSync(join(dir, path)) }));

export function codexBrowserRuntime(opts: { repoRoot?: string; userHome?: string; env?: NodeJS.ProcessEnv } = {}): CodexBrowserRuntime {
  const env = opts.env ?? process.env;
  const userHome = opts.userHome ?? env.HOME ?? homedir();
  const manifestDir = join(opts.repoRoot ?? repoRoot(), 'runtimes', 'codex-browser');
  const manifestPath = join(manifestDir, 'package.json');
  const lockfilePath = join(manifestDir, 'pnpm-lock.yaml');
  const manifestText = readFileSync(manifestPath, 'utf8');
  const lockfileText = readFileSync(lockfilePath, 'utf8');
  const manifest = JSON.parse(manifestText) as {
    dependencies: Record<string, string>;
    packageManager: string;
    pnpm?: { patchedDependencies?: Record<string, string> };
  };
  const packageVersion = manifest.dependencies['chrome-devtools-mcp'];
  if (!packageVersion || !/^\d+\.\d+\.\d+$/.test(packageVersion)) throw new Error('Browser runtime must have an exact version');
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(manifest.packageManager)) throw new Error('Browser runtime must pin pnpm');
  const patches = manifest.pnpm?.patchedDependencies;
  if (!patches?.[`chrome-devtools-mcp@${packageVersion}`]) throw new Error('Browser runtime must include the direct-file-upload patch');
  const patchPaths = [...new Set(Object.values(patches))].sort();
  for (const path of patchPaths) {
    if (typeof path !== 'string' || !path || isAbsolute(path) || path.split(/[\\/]/).includes('..'))
      throw new Error('Browser runtime patch paths must stay within the manifest directory');
  }
  const cache = env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : join(userHome, '.cache');
  const cacheRoot = join(cache, 'perfect-placement', 'codex-browser');
  const fingerprint = codexBrowserFingerprint(manifestText, lockfileText, readPatches(manifestDir, patchPaths));
  const dir = join(cacheRoot, fingerprint);
  return {
    manifestDir,
    manifestPath,
    lockfilePath,
    patchPaths,
    packageVersion,
    packageManager: manifest.packageManager,
    fingerprint,
    cacheRoot,
    dir,
    bin: join(dir, CODEX_BROWSER_ENTRY),
  };
}

/** The pinned browser package's engines declaration, additionally constrained by PP's Node >=22. */
export function codexBrowserNodeCompatible(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\./.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  return major > 22 || (major === 22 && Number(match[2]) >= 12);
}

export function codexBrowserReadiness(runtime: CodexBrowserRuntime): { ok: boolean; detail: string } {
  try {
    const marker = JSON.parse(readFileSync(join(runtime.dir, 'installed.json'), 'utf8')) as { fingerprint?: string };
    if (marker.fingerprint !== runtime.fingerprint) throw new Error('installation is incomplete');
    const fingerprint = codexBrowserFingerprint(
      readFileSync(join(runtime.dir, 'package.json'), 'utf8'),
      readFileSync(join(runtime.dir, 'pnpm-lock.yaml'), 'utf8'),
      readPatches(runtime.dir, runtime.patchPaths),
    );
    if (fingerprint !== runtime.fingerprint) throw new Error('installed lockfile does not match');
    const pkg = JSON.parse(readFileSync(join(runtime.dir, 'node_modules/chrome-devtools-mcp/package.json'), 'utf8')) as {
      version?: string;
    };
    if (pkg.version !== runtime.packageVersion) throw new Error('installed version does not match');
    if (!statSync(runtime.bin).isFile()) throw new Error('browser executable is missing');
    if (!realpathSync(runtime.bin).startsWith(`${realpathSync(runtime.dir)}${sep}`))
      throw new Error('browser executable is outside its runtime');
    return { ok: true, detail: `chrome-devtools-mcp ${runtime.packageVersion}` };
  } catch {
    return { ok: false, detail: `Codex browser runtime is missing or incomplete. ${CODEX_BROWSER_SETUP}` };
  }
}
