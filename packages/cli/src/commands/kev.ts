/*
 * `pp kev install|start|stop|status`: Kev as a pp-managed background process ($PP_HOME/kev/).
 * The model choice is config (`backends.kev.model`, written with the config.update op).
 */
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { db, ops } from '@perfect-placement/engine';
import type { Args } from '../args.js';
import { CliError, confirm, type Io } from '../io.js';
import { realDeps, type SystemDeps } from '../system/deps.js';
import {
  DEFAULT_KEV_MODEL,
  installKev,
  isKevModel,
  KEV_MODELS,
  type KevModel,
  kevInstalled,
  kevPaths,
  kevReachable,
  kevSupport,
  loopbackPort,
  memoryWarning,
  ramGb,
  runningPid,
  startKev,
  stopKev,
  suggestedModel,
  UV_INSTALL_HINT,
  UV_INSTALLER,
  uvFallbackDirs,
} from '../system/kev.js';

export const sysOf = (io: Io): SystemDeps => io.sys ?? realDeps(io.env);

const kevConfig = (home: string) => ops.readConfig(home).backends.kev as { baseUrl: string; model?: string };

/** Configured model, else kev-4b. */
export function configuredModel(home: string): KevModel {
  const m = kevConfig(home).model;
  return isKevModel(m) ? m : DEFAULT_KEV_MODEL;
}

function parseModel(raw: string | undefined): KevModel | undefined {
  if (raw === undefined) return undefined;
  if (!isKevModel(raw)) throw new CliError(`--model must be one of ${Object.keys(KEV_MODELS).join(', ')}`);
  return raw;
}

async function saveModel(home: string, io: Io, model: KevModel): Promise<void> {
  if (kevConfig(home).model === model) return;
  const engine = ops.openEngine({ home, ...(io.services ? { services: io.services } : {}) });
  try {
    const o = await engine.runOp('config.update', { patch: { backends: { kev: { model } } } }, { actor: 'human', now: () => new Date() });
    if (o.status !== 'ok') throw new Error(o.status === 'error' ? o.message : 'config.update needs a human');
  } finally {
    engine.close();
  }
  io.out(`kev: model ${model} saved to config (backends.kev.model)`);
}

const requireVault = (home: string) => {
  if (!existsSync(db.dbPath(home))) throw new CliError(`no vault at ${home} (run pp setup)`);
};

export async function kevInstall(home: string, io: Io, opts: { yes: boolean; model?: KevModel | undefined }): Promise<number> {
  requireVault(home);
  const d = sysOf(io);
  const support = kevSupport(d);
  if (!support.backend) {
    io.err(`kev: ${support.message}`);
    return 1;
  }
  if (!d.which('uv')) {
    io.err(`kev: needs uv (Python package manager). Install it with:\n  ${UV_INSTALL_HINT(d)}\nthen rerun pp kev install.`);
    return 1;
  }
  const model = opts.model ?? (isKevModel(kevConfig(home).model) ? configuredModel(home) : suggestedModel(d));
  io.out(`kev: ${support.message}, ${ramGb(d)} GB RAM, model ${model} (${KEV_MODELS[model].memory})`);
  io.out(`kev: installs into ${kevPaths(home).dir}; the first start downloads the model from Hugging Face (multi-GB).`);
  const warn = memoryWarning(model, d);
  if (warn) io.out(`kev: warning: ${warn}`);
  if (kevInstalled(home)) {
    io.out('kev: already installed');
    await saveModel(home, io, model);
    return 0;
  }
  if (!(await confirm(io, opts.yes, 'Install Kev now?'))) {
    io.out('kev: skipped');
    return 0;
  }
  try {
    await installKev(home, d, io.out);
  } catch (e) {
    io.err(`kev: ${(e as Error).message}`);
    return 1;
  }
  await saveModel(home, io, model);
  io.out('kev: installed. The model downloads on the first start (pp up starts it on demand; or pp kev start).');
  return 0;
}

export interface UvCheck {
  ok: boolean;
  /** Why uv is still missing (for the setup summary). */
  detail?: string;
  /** The command that fixes it. */
  fix?: string;
}

/**
 * Kev needs uv. If it is missing, offer to install it, asking first (`brew install uv` on macOS with
 * Homebrew, else the official installer). The official installer puts uv in ~/.local/bin, which may
 * not be on PATH yet: that dir is added to PATH for the rest of this run, with a note.
 */
export async function ensureUv(io: Io, yes: boolean): Promise<UvCheck> {
  const d = sysOf(io);
  if (d.which('uv')) return { ok: true };
  const hint = UV_INSTALL_HINT(d);
  const fix = `${hint} && pp kev install`;
  if (!(await confirm(io, yes, `Kev needs uv (Python package manager), which is missing. Install it now with: ${hint}?`, false))) {
    io.out(`kev: needs uv; install it with: ${hint}, then run pp kev install`);
    return { ok: false, detail: 'uv is missing (not installed)', fix };
  }
  io.out(`kev: installing uv: ${hint}`);
  const brew = d.which('brew');
  const code = hint === 'brew install uv' && brew ? await d.run(brew, ['install', 'uv']) : await d.run('sh', ['-c', UV_INSTALLER]);
  if (code !== 0) {
    io.err(`kev: installing uv failed (exit ${code})`);
    return { ok: false, detail: `uv install failed (exit ${code})`, fix };
  }
  if (!d.which('uv')) {
    const dir = uvFallbackDirs(d).find((x) => existsSync(join(x, 'uv')));
    if (dir) {
      d.env.PATH = d.env.PATH ? `${dir}${delimiter}${d.env.PATH}` : dir;
      io.out(`kev: uv is in ${dir}, which is not on your PATH; add it to your shell profile: export PATH="${dir}:$PATH"`);
    }
  }
  if (!d.which('uv')) {
    io.err('kev: uv installed but not found on PATH; open a new terminal, then run pp kev install');
    return { ok: false, detail: 'uv installed but not on PATH', fix: 'open a new terminal, then pp kev install' };
  }
  io.out(`kev: uv ready (${d.which('uv')})`);
  return { ok: true };
}

export interface KevStart {
  started: boolean;
  pid: number | null;
}

/** Start Kev unless it already answers. */
export async function kevStart(home: string, io: Io, opts: { model?: KevModel | undefined; wait?: number } = {}): Promise<KevStart> {
  const d = sysOf(io);
  if (!kevInstalled(home)) throw new CliError('kev is not installed (run pp kev install)');
  const { baseUrl } = kevConfig(home);
  const port = loopbackPort(baseUrl);
  const mine = runningPid(home, d);
  if (mine !== null) {
    io.out(`kev: already running (pid ${mine}) at ${baseUrl}`);
    return { started: false, pid: mine };
  }
  if (await kevReachable(baseUrl, d)) {
    io.out(`kev: already answering at ${baseUrl} (not started by pp)`);
    return { started: false, pid: null };
  }
  if (opts.model) await saveModel(home, io, opts.model);
  const model = opts.model ?? configuredModel(home);
  const warn = memoryWarning(model, d);
  if (warn) io.out(`kev: warning: ${warn}`);
  const pid = startKev(home, d, { model, port });
  io.out(`kev: started ${model} (pid ${pid}) at ${baseUrl}; log ${kevPaths(home).log}`);
  if (opts.wait && opts.wait > 0) {
    const until = d.now().getTime() + opts.wait * 1000;
    while (d.now().getTime() < until) {
      if (await kevReachable(baseUrl, d)) {
        io.out('kev: ready');
        return { started: true, pid };
      }
      if (!d.alive(pid)) throw new CliError(`kev exited; see ${kevPaths(home).log}`);
      await d.sleep(2000);
    }
    io.out(`kev: not answering yet (the first start downloads the model); see ${kevPaths(home).log}`);
  }
  return { started: true, pid };
}

export async function kevStatus(home: string, io: Io): Promise<number> {
  const d = sysOf(io);
  const { baseUrl } = kevConfig(home);
  const pid = runningPid(home, d);
  const reachable = await kevReachable(baseUrl, d);
  io.out(
    [
      `kev: ${kevInstalled(home) ? 'installed' : 'not installed'} (${kevPaths(home).dir})`,
      `model: ${configuredModel(home)}`,
      `process: ${pid !== null ? `running (pid ${pid})` : 'not started by pp'}`,
      `api: ${reachable ? 'answering' : 'not answering'} at ${baseUrl}`,
      `support: ${kevSupport(d).message}`,
    ].join('\n'),
  );
  return 0;
}

export async function kevCommand(args: Args, home: string, io: Io): Promise<number> {
  const sub = args._[1] ?? 'status';
  const model = parseModel(args.get('model'));
  switch (sub) {
    case 'install':
      return kevInstall(home, io, { yes: args.has('yes'), model });
    case 'start': {
      requireVault(home);
      const wait = args.has('wait') ? Number(args.get('timeout') ?? 600) : 0;
      await kevStart(home, io, { model, wait });
      return 0;
    }
    case 'stop': {
      const pid = stopKev(home, sysOf(io));
      io.out(pid === null ? 'kev: not running (nothing pp started)' : `kev: stopped (pid ${pid})`);
      return 0;
    }
    case 'status':
      return kevStatus(home, io);
    default:
      throw new CliError(`unknown subcommand "kev ${sub}" (install, start, stop, status)`);
  }
}

/**
 * `pp up`: start Kev on demand when it is installed and not answering. Returns a stop function only
 * when this call started it (so `pp up` stops only what it started).
 */
export async function kevForUp(home: string, io: Io): Promise<(() => void) | null> {
  if (!kevInstalled(home)) {
    if (!(await kevReachable(kevConfig(home).baseUrl, sysOf(io))))
      io.out('kev: not installed (pp kev install adds it); decisions fall back to the agent or Needs you');
    return null;
  }
  try {
    const r = await kevStart(home, io);
    if (!r.started) return null;
    const d = sysOf(io);
    return () => {
      stopKev(home, d);
      io.out('kev: stopped');
    };
  } catch (e) {
    io.err(`kev: not started (${(e as Error).message}); decisions fall back to the agent or Needs you`);
    return null;
  }
}
