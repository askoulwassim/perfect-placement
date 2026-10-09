/*
 * Kev (the local System One model, https://github.com/jaredpalmer/kev) managed by pp.
 * Everything lives in $PP_HOME/kev/: repo/ (the clone + uv venv), installed.json, kev.pid, kev.log.
 * These are runtime files, not vault data; the vault itself is only written through ops.
 * Source for commands, model ids and revisions: the Kev README (checked 2026-10-08).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SystemDeps } from './deps.js';

export const KEV_REPO_URL = 'https://github.com/jaredpalmer/kev.git';

export const KEV_MODELS = {
  'kev-0.8b': { hub: 'jaredpalmer/kev-0.8b', revision: '9a45d25e', memory: '~4 GB', minRamGb: 8 },
  'kev-4b': { hub: 'jaredpalmer/kev-4b', revision: '139fdd94', memory: '8 GB+ free', minRamGb: 24 },
  'kev-9b': { hub: 'jaredpalmer/kev-9b', revision: 'b5d8c18e', memory: '~17 GB', minRamGb: 32 },
  'kev-27b': { hub: 'jaredpalmer/kev-27b', revision: '28be62e9', memory: '~51 GB', minRamGb: 96 },
} as const;
export type KevModel = keyof typeof KEV_MODELS;
export const DEFAULT_KEV_MODEL: KevModel = 'kev-4b';
export const isKevModel = (m: unknown): m is KevModel => typeof m === 'string' && m in KEV_MODELS;

export interface KevPaths {
  dir: string;
  repo: string;
  state: string;
  pid: string;
  log: string;
}
export const kevPaths = (home: string): KevPaths => {
  const dir = join(home, 'kev');
  return { dir, repo: join(dir, 'repo'), state: join(dir, 'installed.json'), pid: join(dir, 'kev.pid'), log: join(dir, 'kev.log') };
};

const GB = 1024 ** 3;
export const ramGb = (d: Pick<SystemDeps, 'totalMem'>) => Math.round(d.totalMem / GB);

export interface KevSupport {
  backend: 'mlx' | 'cuda' | null;
  message: string;
}

/** Apple Silicon runs MLX; Linux with an NVIDIA GPU runs the README's PyTorch/CUDA path; nothing else is supported. */
export function kevSupport(d: Pick<SystemDeps, 'platform' | 'arch' | 'which'>): KevSupport {
  if (d.platform === 'darwin' && d.arch === 'arm64') return { backend: 'mlx', message: 'Apple Silicon (MLX)' };
  if (d.platform === 'linux' && d.which('nvidia-smi'))
    return { backend: 'cuda', message: 'Linux + NVIDIA GPU (PyTorch/CUDA, per the Kev README; less tested than MLX)' };
  return {
    backend: null,
    message:
      'Kev needs an Apple Silicon Mac (MLX) or Linux with an NVIDIA GPU (CUDA). This machine is not supported. ' +
      'pp works without Kev: decisions go to your agent session or Needs you.',
  };
}

/** The model to suggest for this machine: 4B wants 8 GB+ free, so 16 GB machines get 0.8B. */
export const suggestedModel = (d: Pick<SystemDeps, 'totalMem'>): KevModel => (ramGb(d) < 24 ? 'kev-0.8b' : 'kev-4b');

export function memoryWarning(model: KevModel, d: Pick<SystemDeps, 'totalMem'>): string | null {
  const m = KEV_MODELS[model];
  if (ramGb(d) >= m.minRamGb) return null;
  return `${model} wants ${m.memory} of memory; this machine has ${ramGb(d)} GB. Consider --model ${suggestedModel(d)}.`;
}

export const kevInstalled = (home: string) => existsSync(kevPaths(home).state);

export function readPid(home: string): number | null {
  const f = kevPaths(home).pid;
  if (!existsSync(f)) return null;
  const pid = Number(readFileSync(f, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** The pid of the Kev that pp started, if it is still alive. */
export function runningPid(home: string, d: Pick<SystemDeps, 'alive'>): number | null {
  const pid = readPid(home);
  return pid !== null && d.alive(pid) ? pid : null;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Port from `backends.kev.baseUrl`; pp only manages a Kev on loopback. */
export function loopbackPort(baseUrl: string): number {
  const u = new URL(baseUrl);
  if (!LOOPBACK.has(u.hostname)) throw new Error(`backends.kev.baseUrl ${baseUrl} is not loopback; pp only manages a local Kev`);
  return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
}

/** Kev answers `GET /v1/models`. */
export async function kevReachable(baseUrl: string, d: Pick<SystemDeps, 'fetch'>, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await d.fetch(new URL('/v1/models', baseUrl), { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/** `uv run --extra serve python -m kev.serve --run <hub>@<revision> --port <port>` (binds 127.0.0.1 by default). */
export function serveArgs(model: KevModel, port: number): string[] {
  const m = KEV_MODELS[model];
  return ['run', '--extra', 'serve', 'python', '-m', 'kev.serve', '--run', `${m.hub}@${m.revision}`, '--port', String(port)];
}

export const UV_INSTALLER = 'curl -LsSf https://astral.sh/uv/install.sh | sh';
export const UV_INSTALL_HINT = (d: Pick<SystemDeps, 'platform' | 'which'>) =>
  d.platform === 'darwin' && d.which('brew') ? 'brew install uv' : UV_INSTALLER;

/** Where the official uv installer puts `uv` when that dir is not on PATH yet. */
export const uvFallbackDirs = (d: Pick<SystemDeps, 'home' | 'env'>): string[] =>
  [d.env.XDG_BIN_HOME, join(d.home, '.local', 'bin'), join(d.home, '.cargo', 'bin')].filter((x): x is string => !!x);

/** Clone (once) + `uv sync --extra serve`, then mark installed. Throws with a fix-it message on failure. */
export async function installKev(home: string, d: SystemDeps, log: (line: string) => void): Promise<void> {
  const p = kevPaths(home);
  const uv = d.which('uv');
  if (!uv) throw new Error(`uv is not installed. Install it with: ${UV_INSTALL_HINT(d)}`);
  const git = d.which('git');
  if (!git) throw new Error('git is not installed');
  mkdirSync(p.dir, { recursive: true });
  if (existsSync(join(p.repo, '.git'))) log(`kev: using the existing clone at ${p.repo}`);
  else {
    log(`kev: cloning ${KEV_REPO_URL} into ${p.repo}`);
    if ((await d.run(git, ['clone', '--depth', '1', KEV_REPO_URL, p.repo])) !== 0) throw new Error('git clone failed');
  }
  log('kev: uv sync --extra serve (Python deps; MLX on Apple Silicon)');
  if ((await d.run(uv, ['sync', '--extra', 'serve'], { cwd: p.repo })) !== 0) throw new Error(`uv sync failed in ${p.repo}`);
  const head = d.capture(git, ['-C', p.repo, 'rev-parse', 'HEAD']);
  writeFileSync(
    p.state,
    `${JSON.stringify({ repo: KEV_REPO_URL, commit: head.code === 0 ? head.stdout.trim() : null, installed_at: d.now().toISOString() }, null, 2)}\n`,
  );
}

/** Start Kev in the background; pid in kev.pid, output in kev.log. */
export function startKev(home: string, d: SystemDeps, opts: { model: KevModel; port: number }): number {
  const p = kevPaths(home);
  const uv = d.which('uv');
  if (!uv) throw new Error(`uv is not installed. Install it with: ${UV_INSTALL_HINT(d)}`);
  const pid = d.spawnDetached(uv, serveArgs(opts.model, opts.port), { cwd: p.repo, log: p.log });
  writeFileSync(p.pid, `${pid}\n`);
  return pid;
}

/** Stop the Kev that pp started. Returns its pid, or null if none was running. The pid file is cleared, not deleted. */
export function stopKev(home: string, d: Pick<SystemDeps, 'alive' | 'kill'>): number | null {
  const pid = runningPid(home, d);
  if (pid !== null) d.kill(pid);
  if (existsSync(kevPaths(home).pid)) writeFileSync(kevPaths(home).pid, '');
  return pid;
}
