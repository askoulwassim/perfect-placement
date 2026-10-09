/*
 * `pp uninstall`: what pp put on this machine, removed in reverse (setup, kev, schedules, install.sh).
 * `planUninstall` only reads (files, `crontab -l`, a loopback health check) and returns one item per
 * thing it found, each with a `run` that does it. Default: a setup reset that keeps the vault.
 * `--purge` also deletes the vault (after a verified tar.gz backup unless --no-backup) and Kev's model
 * files in the Hugging Face cache. Never: Node, pnpm, uv, Homebrew, the repo checkout, other MCP servers.
 */
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { SCHEDULE_KEYS } from '@perfect-placement/contracts';
import { db, ops } from '@perfect-placement/engine';
import { ensureBackupDir, listTarGz, writeTarGz } from './backup.js';
import { CLIENT_IDS, CLIENT_LABEL, claudeRemoveArgs, clientPpState, jsonHasPp, stamp, unregisterClient } from './clients.js';
import type { SystemDeps } from './deps.js';
import { applyHfPlan, formatBytes, planHfCache } from './hf-cache.js';
import { kevInstalled, kevPaths, kevReachable, runningPid, stopKev } from './kev.js';
import { installedJobFiles, jobManager, removeJobs, scheduleLogDir } from './schedules.js';

export interface UninstallOptions {
  /** PP_HOME (resolved). */
  home: string;
  purge: boolean;
  /** Back up the vault before a purge (default true; --no-backup). */
  backup: boolean;
  /** Purge a PP_HOME that does not look like a vault, sits in a git repo, or while pp up answers. */
  force: boolean;
  /** Where install.sh put the `pp` / `pp-mcp` launchers. */
  binDir: string;
  /** This checkout (never touched; for the optional reset commands and a safety check). */
  repo: string;
  /** `pp up` port, to refuse a purge while it runs. */
  upPort: number;
}

export interface Outcome {
  result: 'ok' | 'skipped' | 'failed';
  detail: string;
  fix?: string;
}

export interface PlanItem {
  step: string;
  /** What will happen (null: nothing to do here). */
  verb: 'stop' | 'remove' | 'edit' | 'delete' | 'backup' | null;
  /** The exact target(s) (or why there is nothing to do). */
  what: string;
  /** Extra plan lines (paths, crontab lines). */
  more?: string[];
  run?: () => Promise<Outcome>;
}

export interface UninstallPlan {
  items: PlanItem[];
  /** Set when the purge is refused: nothing at all runs. */
  refusal: string | null;
}

/** install.sh's own test: a launcher it wrote mentions this clone's `/packages/` path. */
export function isPpLauncher(file: string): boolean {
  try {
    return statSync(file).isFile() && readFileSync(file, 'utf8').includes('/packages/');
  } catch {
    return false;
  }
}

const lexists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** A pp vault: pp.db and config.json. */
export const looksLikeVault = (home: string) => existsSync(db.dbPath(home)) && existsSync(join(home, 'config.json'));

/** Why the vault at `home` must not be purged (null: fine). `hard` refusals ignore --force. */
export async function purgeRefusal(
  d: Pick<SystemDeps, 'home' | 'fetch'>,
  o: Pick<UninstallOptions, 'home' | 'force' | 'repo' | 'upPort'>,
): Promise<string | null> {
  const home = resolve(o.home);
  if (!lexists(home)) return null;
  if (lstatSync(home).isSymbolicLink())
    return `${home} is a symlink (to ${realpathSync(home)}); rerun with --home pointing at the real directory`;
  const real = realpathSync(home);
  const userHome = existsSync(d.home) ? realpathSync(d.home) : resolve(d.home);
  if (real === sep || inside(userHome, real)) return `${home} is your home directory or one of its parents; never purged`;
  const repo = existsSync(o.repo) ? realpathSync(o.repo) : resolve(o.repo);
  if (inside(repo, real)) return `${home} contains the Perfect Placement checkout (${repo}); never purged`;
  if (o.force) return null;
  const git = db.findGitRoot(real);
  if (git) return `${home} is inside the git repo ${git}; not a vault pp would create (--force to purge anyway)`;
  if (!looksLikeVault(real)) return `${home} does not look like a pp vault (no pp.db and config.json; --force to purge anyway)`;
  try {
    const r = await d.fetch(`http://127.0.0.1:${o.upPort}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) return `pp up is running (http://127.0.0.1:${o.upPort}); stop it first (Ctrl-C), or --force`;
  } catch {
    // not running
  }
  return null;
}

/** Crontab lines that run a pp schedule (no launchd / systemd: pp only printed them). */
export function ppCronLines(d: Pick<SystemDeps, 'capture' | 'which'>): string[] {
  if (!d.which('crontab')) return [];
  const r = d.capture('crontab', ['-l']);
  if (r.code !== 0) return [];
  return r.stdout.split('\n').filter((l) => l.includes("'--schedule'") && l.includes('packages/cli/dist/index.js'));
}

const ok = (detail: string): Outcome => ({ result: 'ok', detail });
const failed = (detail: string, fix?: string): Outcome => ({ result: 'failed', detail, ...(fix ? { fix } : {}) });
const errText = (e: unknown) => (e as Error).message;

export async function planUninstall(d: SystemDeps, o: UninstallOptions): Promise<UninstallPlan> {
  const items: PlanItem[] = [];
  const home = resolve(o.home);
  const refusal = o.purge ? await purgeRefusal(d, o) : null;
  if (refusal) return { items, refusal };
  const vault = lexists(home);

  // Kev: only the process pp started (its pid file).
  const pid = vault ? runningPid(home, d) : null;
  if (pid !== null)
    items.push({
      step: 'kev',
      verb: 'stop',
      what: `Kev started by pp (pid ${pid}, ${kevPaths(home).pid})`,
      run: async () => {
        stopKev(home, d);
        for (let i = 0; i < 20 && d.alive(pid); i++) await d.sleep(250);
        return d.alive(pid) ? failed(`pid ${pid} still running`, `kill ${pid}`) : ok(`stopped (pid ${pid})`);
      },
    });
  else {
    let what = 'not running (nothing pp started)';
    if (vault && kevInstalled(home)) {
      try {
        const url = (ops.readConfig(home).backends.kev as { baseUrl: string }).baseUrl;
        if (await kevReachable(url, d)) what = `a Kev at ${url} was not started by pp; left running`;
      } catch {
        // unreadable config: nothing to check
      }
    }
    items.push({ step: 'kev', verb: null, what });
  }

  // Schedules (OS jobs).
  const manager = jobManager(d);
  if (manager === 'cron') {
    const lines = ppCronLines(d);
    items.push(
      lines.length
        ? {
            step: 'schedules',
            verb: null,
            what: 'cron: pp never edits your crontab; remove these lines yourself with crontab -e',
            more: lines,
          }
        : { step: 'schedules', verb: null, what: 'no pp lines in crontab' },
    );
  } else {
    const files = SCHEDULE_KEYS.flatMap((k) => installedJobFiles(d, k));
    if (!files.length) items.push({ step: 'schedules', verb: null, what: `no ${manager} jobs installed` });
    else
      items.push({
        step: 'schedules',
        verb: 'remove',
        what: `unload and delete ${files.length} ${manager} job file${files.length === 1 ? '' : 's'}`,
        more: files,
        run: async () => {
          removeJobs(d);
          const left = files.filter((f) => existsSync(f));
          return left.length ? failed(`still there: ${left.join(', ')}`, `rm ${left.join(' ')}`) : ok(`${files.length} removed`);
        },
      });
  }

  // MCP: only the `pp` entry, backed up first.
  for (const client of CLIENT_IDS) {
    const step = `mcp ${CLIENT_LABEL[client]}`;
    const st = clientPpState(client, d);
    if (!st.file) {
      items.push({ step, verb: null, what: 'no config on this platform' });
      continue;
    }
    if (st.detail) {
      items.push({ step, verb: null, what: `${st.file}: ${st.detail}` });
      continue;
    }
    if (!st.has) {
      items.push({ step, verb: null, what: `not registered (${st.file})` });
      continue;
    }
    const viaCli = client === 'claude-code' && d.which('claude') !== null;
    items.push({
      step,
      verb: 'edit',
      what: viaCli
        ? `claude ${claudeRemoveArgs.join(' ')} (backup ${st.file}.bak-<timestamp> first)`
        : `remove the "pp" server from ${st.file} (backup .bak-<timestamp> first; other servers kept)`,
      run: async () => {
        try {
          const r = unregisterClient(client, d);
          const bak = r.backup ? ` (backup ${r.backup})` : '';
          if (r.status === 'failed') return failed(`${r.detail ?? 'failed'}${bak}`, `remove "pp" from ${st.file} by hand`);
          if (client === 'claude-code' && jsonHasPp(st.file as string).has)
            return failed(`"pp" still in ${st.file}${bak}`, 'claude mcp remove pp (in the scope it lists: claude mcp get pp)');
          return ok(r.status === 'removed' ? `removed${bak}` : 'already gone');
        } catch (e) {
          return failed(errText(e), `remove "pp" from ${st.file} by hand`);
        }
      },
    });
  }

  // Launchers from install.sh.
  for (const name of ['pp', 'pp-mcp']) {
    const file = join(o.binDir, name);
    const step = `launcher ${name}`;
    if (!lexists(file)) items.push({ step, verb: null, what: `not found (${file})` });
    else if (!isPpLauncher(file)) items.push({ step, verb: null, what: `${file} is not a Perfect Placement launcher; left alone` });
    else
      items.push({
        step,
        verb: 'delete',
        what: file,
        run: async () => {
          try {
            rmSync(file, { force: true });
            return ok(`deleted ${file}`);
          } catch (e) {
            return failed(errText(e), `rm ${file}`);
          }
        },
      });
  }

  if (!o.purge) return { items, refusal: null };

  // --purge: backup, vault, Kev models, schedule logs.
  let backupOk = !o.backup;
  if (!vault) items.push({ step: 'vault', verb: null, what: `no vault at ${home}` });
  else {
    if (o.backup) {
      const dir = join(d.home, 'perfect-placement-backups');
      const out = join(dir, `vault-${stamp(d)}.tar.gz`);
      items.push({
        step: 'backup',
        verb: 'backup',
        what: `${home} -> ${out} (tar.gz, 0600; without kev/repo)`,
        run: async () => {
          try {
            ensureBackupDir(dir);
            const kevDir = 'kev/';
            const w = await writeTarGz(home, out, (rel) => rel === `${kevDir}repo` || rel === `${kevDir}.venv`);
            const names = await listTarGz(out);
            if (names.length !== w.entries) return failed(`${out}: wrote ${w.entries} entries, read back ${names.length}`);
            backupOk = true;
            return ok(`${out} (${w.files} files, ${formatBytes(statSync(out).size)}); restore: tar -xzf ${out} -C ${dirname(home)}`);
          } catch (e) {
            return failed(`${out}: ${errText(e)}`, 'free disk space, or --no-backup to purge without one');
          }
        },
      });
    }
    items.push({
      step: 'vault',
      verb: 'delete',
      what: `${home} (pp.db, config.json, markdown, kev/)`,
      run: async () => {
        if (!backupOk) return failed('not deleted: the backup failed', 'fix the backup, then rerun');
        try {
          rmSync(home, { recursive: true, force: true });
          return ok(`deleted ${home}`);
        } catch (e) {
          return failed(errText(e), `rm -rf ${home}`);
        }
      },
    });
  }

  const hf = planHfCache(d);
  if (!hf.remove.length)
    items.push({
      step: 'kev models',
      verb: null,
      what: `no Kev models in ${hf.cache}${hf.notCached.length ? ` (pinned bases not cached: ${hf.notCached.join(', ')})` : ''}`,
    });
  else
    items.push({
      step: 'kev models',
      verb: 'delete',
      what: `${hf.cache}: ${hf.repos.length} model dir${hf.repos.length === 1 ? '' : 's'}, ${formatBytes(hf.bytes)}`,
      more: [
        ...hf.repos.map(
          (r) =>
            `${r.name}${r.whole ? '' : ` (snapshot ${r.snapshots.map((s) => s.slice(0, 12)).join(', ')} only)`}${r.why ? `  [${r.why}]` : ''}`,
        ),
        ...(hf.keptShared.length ? [`kept: ${hf.keptShared.length} blob(s) another model also uses`] : []),
      ],
      run: async () => {
        const r = applyHfPlan(hf);
        return r.failed.length
          ? failed(`not deleted: ${r.failed.join('; ')}`)
          : ok(`${hf.repos.length} model dir(s), ${formatBytes(hf.bytes)}`);
      },
    });

  const logs = scheduleLogDir(d);
  if (existsSync(logs))
    items.push({
      step: 'schedule logs',
      verb: 'delete',
      what: logs,
      run: async () => {
        try {
          rmSync(logs, { recursive: true, force: true });
          return ok(`deleted ${logs}`);
        } catch (e) {
          return failed(errText(e), `rm -rf ${logs}`);
        }
      },
    });
  return { items, refusal: null };
}

/** Commands for a full machine reset. Printed, never run. */
export function machineResetLines(d: Pick<SystemDeps, 'platform' | 'which'>, repo: string): string[] {
  const brew = d.platform === 'darwin' && d.which('brew') !== null;
  return [
    'Left alone: Node, pnpm, uv, Homebrew, this checkout, your agents and their other MCP servers, *.bak-* config backups.',
    'Full machine reset (optional; pp never runs these):',
    brew
      ? '  brew uninstall node@22                 # Node 22 (if you installed it for pp)'
      : '  nvm uninstall 22   # or your package manager: Node 22, if you installed it for pp',
    '  corepack disable pnpm                  # pnpm shims from corepack enable',
    '  uv cache clean                         # Python packages uv cached for Kev (before removing uv)',
    brew
      ? '  brew uninstall uv                      # or: rm ~/.local/bin/uv ~/.local/bin/uvx'
      : '  rm ~/.local/bin/uv ~/.local/bin/uvx    # uv from the official installer',
    `  rm -rf ${repo}`,
  ];
}
