/*
 * Schedules as OS jobs (#29): one job per schedule in `config.schedules`, so runs happen with the UI
 * closed. Each job runs `node <cli> run <skill> --schedule --home <PP_HOME>`: enqueue through
 * `runs.start` (actor schedule), then drain the queue until the run (and what it triggers) is done.
 *   macOS   launchd: ~/Library/LaunchAgents/com.perfectplacement.<key>.plist (StartCalendarInterval),
 *           loaded with `launchctl bootstrap gui/<uid>`
 *   Linux   systemd user timers: ~/.config/systemd/user/pp-<key>.{service,timer} (Persistent=true)
 *   other   no job manager: crontab lines are printed for the user to add (state `manual`)
 * Every machine call goes through SystemDeps (tests: temp HOME, fake capture). Each job file carries a
 * fingerprint line (key, spec, vault, node, cli) so status compares files without asking launchd. The paths
 * compare by file identity (realpath), so a symlinked repo, vault or node is not reported stale (#97).
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ParsedSchedule,
  type PolicyConfig,
  parseSchedule,
  SCHEDULE_KEYS,
  SCHEDULE_SKILL,
  type ScheduleJobState,
  type ScheduleKey,
} from '@perfect-placement/contracts';
import { ops } from '@perfect-placement/engine';
import type { SystemDeps } from './deps.js';

export type Schedules = PolicyConfig['schedules'];
export type JobManager = 'launchd' | 'systemd' | 'cron';

const HERE = dirname(fileURLToPath(import.meta.url));

/** `packages/cli/dist/index.js` (from src/system or dist/system): what each job runs, by absolute path. */
export function ppCliBin(): string {
  return join(HERE, '..', '..', 'dist', 'index.js');
}

export function jobManager(d: Pick<SystemDeps, 'platform' | 'which'>): JobManager {
  if (d.platform === 'darwin') return 'launchd';
  if (d.platform === 'linux' && d.which('systemctl')) return 'systemd';
  return 'cron';
}

export const jobLabel = (key: ScheduleKey) => `com.perfectplacement.${key}`;
export const unitName = (key: ScheduleKey) => `pp-${key.replace(/_/g, '-')}`;
export const launchAgentsDir = (d: Pick<SystemDeps, 'home'>) => join(d.home, 'Library', 'LaunchAgents');
export const systemdUserDir = (d: Pick<SystemDeps, 'home' | 'env'>) =>
  join(d.env.XDG_CONFIG_HOME || join(d.home, '.config'), 'systemd', 'user');
export function scheduleLogDir(d: Pick<SystemDeps, 'platform' | 'home' | 'env'>): string {
  if (d.platform === 'darwin') return join(d.home, 'Library', 'Logs', 'perfect-placement');
  return join(d.env.XDG_STATE_HOME || join(d.home, '.local', 'state'), 'perfect-placement');
}

/** The file whose fingerprint says which job is installed (plist, or the systemd service). */
export function jobFile(d: Pick<SystemDeps, 'platform' | 'which' | 'home' | 'env'>, key: ScheduleKey): string | null {
  const m = jobManager(d);
  if (m === 'launchd') return join(launchAgentsDir(d), `${jobLabel(key)}.plist`);
  if (m === 'systemd') return join(systemdUserDir(d), `${unitName(key)}.service`);
  return null;
}

/** PATH inside the job (launchd and systemd start with a bare one): node's dir, the runner's, this shell's PATH, system dirs. */
export function jobPath(d: Pick<SystemDeps, 'which' | 'env'>, node: string, runner?: string): string {
  const dirs = [dirname(node)];
  const r = runner ? d.which(runner) : null;
  if (r) dirs.push(dirname(r));
  dirs.push(...(d.env.PATH ?? '').split(':'), '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin');
  return [...new Set(dirs.filter(Boolean))].join(':');
}

export interface JobInputs {
  key: ScheduleKey;
  spec: string;
  home: string;
  node: string;
  cli: string;
}

/** One line identifying the job (base64 JSON: safe inside an XML comment and a unit file). */
export const fingerprint = (j: JobInputs) =>
  `pp-schedule ${Buffer.from(JSON.stringify({ key: j.key, spec: j.spec, home: j.home, node: j.node, cli: j.cli })).toString('base64')}`;

/** The command a job runs. */
export const jobArgs = (j: Pick<JobInputs, 'key' | 'home' | 'node' | 'cli'>) => [
  j.node,
  j.cli,
  'run',
  SCHEDULE_SKILL[j.key],
  '--schedule',
  '--home',
  j.home,
];

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const str = (s: string) => `<string>${xml(s)}</string>`;
const int = (n: number) => `<integer>${n}</integer>`;

export function plist(j: JobInputs, p: ParsedSchedule, env: { PATH: string }, log: string): string {
  const slot = (day?: number) =>
    `<dict>${day === undefined ? '' : `<key>Weekday</key>${int(day)}`}<key>Hour</key>${int(p.hour)}<key>Minute</key>${int(p.minute)}</dict>`;
  const calendar = p.daily ? `    ${slot()}` : `    <array>\n${p.days.map((d) => `      ${slot(d)}`).join('\n')}\n    </array>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<!-- ${fingerprint(j)} -->`,
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${str(jobLabel(j.key))}`,
    '  <key>ProgramArguments</key>',
    `  <array>\n${jobArgs(j)
      .map((a) => `    ${str(a)}`)
      .join('\n')}\n  </array>`,
    '  <key>EnvironmentVariables</key>',
    `  <dict><key>PATH</key>${str(env.PATH)}<key>PP_HOME</key>${str(j.home)}<key>PP_NODE</key>${str(j.node)}</dict>`,
    '  <key>StartCalendarInterval</key>',
    calendar,
    `  <key>StandardOutPath</key>${str(log)}`,
    `  <key>StandardErrorPath</key>${str(log)}`,
    '  <key>RunAtLoad</key><false/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

const SYSTEMD_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const two = (n: number) => String(n).padStart(2, '0');

export function onCalendar(p: ParsedSchedule): string {
  const time = `*-*-* ${two(p.hour)}:${two(p.minute)}:00`;
  return p.daily ? time : `${p.days.map((d) => SYSTEMD_DAYS[d]).join(',')} ${time}`;
}

const q = (s: string) => `"${s.replace(/(["\\])/g, '\\$1')}"`;

export function systemdUnits(j: JobInputs, p: ParsedSchedule, env: { PATH: string }, log: string): { service: string; timer: string } {
  const head = `# ${fingerprint(j)}\n[Unit]\nDescription=Perfect Placement schedule ${j.key}\n`;
  return {
    service: `${head}\n[Service]\nType=oneshot\nEnvironment=${q(`PATH=${env.PATH}`)}\nEnvironment=${q(`PP_HOME=${j.home}`)}\nEnvironment=${q(`PP_NODE=${j.node}`)}\nExecStart=${jobArgs(j).map(q).join(' ')}\nStandardOutput=append:${log}\nStandardError=append:${log}\n`,
    timer: `${head}\n[Timer]\nOnCalendar=${onCalendar(p)}\nPersistent=true\nUnit=${unitName(j.key)}.service\n\n[Install]\nWantedBy=timers.target\n`,
  };
}

export function cronLine(j: JobInputs, p: ParsedSchedule, env: { PATH: string }, log: string): string {
  const dow = p.daily ? '*' : p.days.join(',');
  const cmd = jobArgs(j)
    .map((a) => `'${a.replace(/'/g, `'\\''`)}'`)
    .join(' ');
  return `${p.minute} ${p.hour} * * ${dow} PATH='${env.PATH}' PP_HOME='${j.home}' ${cmd} >> '${log}' 2>&1`;
}

export interface JobOptions {
  /** The pp CLI entry each job runs (default `ppCliBin()`). */
  cli?: string;
  /** Rewrite and reload every job that is on, even one already installed as is (`pp schedules install`). */
  force?: boolean;
}

export interface JobPlan {
  key: ScheduleKey;
  spec: string;
  on: boolean;
  /** Unparseable spec. */
  error?: string;
  files: { path: string; content: string }[];
  /** The crontab line (no job manager). */
  cron?: string;
}

/** The jobs config.schedules calls for, as files (launchd, systemd) or crontab lines. */
export function planJobs(home: string, schedules: Schedules, d: SystemDeps, opts: JobOptions = {}): JobPlan[] {
  const m = jobManager(d);
  const cli = opts.cli ?? ppCliBin();
  let runner: string | undefined;
  try {
    runner = ops.readConfig(home).runner.command;
  } catch {
    runner = undefined;
  }
  const env = { PATH: jobPath(d, d.nodePath, runner) };
  return SCHEDULE_KEYS.map((key): JobPlan => {
    const spec = schedules[key];
    if (spec === 'off') return { key, spec, on: false, files: [] };
    const p = parseSchedule(spec);
    if (!p)
      return { key, spec, on: true, error: `cannot read "${spec}" (daily HH:MM, weekdays HH:MM, fri HH:MM, mon,thu HH:MM)`, files: [] };
    const j: JobInputs = { key, spec, home, node: d.nodePath, cli };
    const log = join(scheduleLogDir(d), `${key}.log`);
    if (m === 'launchd') return { key, spec, on: true, files: [{ path: jobFile(d, key) as string, content: plist(j, p, env, log) }] };
    if (m === 'systemd') {
      const u = systemdUnits(j, p, env, log);
      const dir = systemdUserDir(d);
      return {
        key,
        spec,
        on: true,
        files: [
          { path: join(dir, `${unitName(key)}.service`), content: u.service },
          { path: join(dir, `${unitName(key)}.timer`), content: u.timer },
        ],
      };
    }
    return { key, spec, on: true, files: [], cron: cronLine(j, p, env, log) };
  });
}

const firstFingerprint = (content: string) => /pp-schedule \S+/.exec(content)?.[0] ?? null;

function parseFingerprint(line: string | null): JobInputs | null {
  if (!line) return null;
  try {
    const j = JSON.parse(Buffer.from(line.slice('pp-schedule '.length), 'base64').toString('utf8')) as Partial<JobInputs>;
    const fields = [j.key, j.spec, j.home, j.node, j.cli];
    return fields.every((f) => typeof f === 'string') ? (j as JobInputs) : null;
  } catch {
    return null;
  }
}

/**
 * Two paths name the same file: equal strings, or both resolve (realpath, injectable) to one file. A path
 * that does not resolve (missing file) only matches itself, so a job pointing at a gone file stays stale.
 */
export function samePath(a: string, b: string, realpath: (p: string) => string = realpathSync): boolean {
  if (a === b) return true;
  try {
    return realpath(a) === realpath(b);
  } catch {
    return false;
  }
}

/**
 * The installed fingerprint describes the job we would write: same key and spec, and home, node and cli
 * reaching the same files (#97). The written job keeps the stable node path (#33); only the comparison
 * resolves symlinks, so an opt link and its Cellar target, or a repo symlink and its real path, match.
 */
export function sameJob(installed: string | null, want: string | null, realpath?: (p: string) => string): boolean {
  if (!want || !installed) return false;
  if (installed === want) return true;
  const a = parseFingerprint(installed);
  const b = parseFingerprint(want);
  if (!a || !b || a.key !== b.key || a.spec !== b.spec) return false;
  return samePath(a.home, b.home, realpath) && samePath(a.node, b.node, realpath) && samePath(a.cli, b.cli, realpath);
}

/** Each schedule's job compared with config (file reads only; never asks launchd / systemd). */
export function jobStatus(home: string, schedules: Schedules, d: SystemDeps, opts: JobOptions = {}): Record<ScheduleKey, ScheduleJobState> {
  const m = jobManager(d);
  const out = {} as Record<ScheduleKey, ScheduleJobState>;
  for (const plan of planJobs(home, schedules, d, opts)) {
    const file = jobFile(d, plan.key);
    if (m === 'cron' || !file) {
      out[plan.key] = plan.on ? 'manual' : 'off';
      continue;
    }
    const exists = existsSync(file) && (m !== 'systemd' || existsSync(file.replace(/\.service$/, '.timer')));
    if (!plan.on) out[plan.key] = existsSync(file) ? 'orphan' : 'off';
    else if (!exists) out[plan.key] = 'missing';
    else {
      const want = plan.files[0] ? firstFingerprint(plan.files[0].content) : null;
      out[plan.key] = sameJob(firstFingerprint(readFileSync(file, 'utf8')), want, d.realpath) ? 'installed' : 'stale';
    }
  }
  return out;
}

export interface SyncResult {
  ok: boolean;
  lines: string[];
}

/** The job files of one schedule that exist on disk (plist; or systemd service + timer). Read only. */
export function installedJobFiles(d: Pick<SystemDeps, 'platform' | 'which' | 'home' | 'env'>, key: ScheduleKey): string[] {
  const file = jobFile(d, key);
  if (!file) return [];
  const all = jobManager(d) === 'systemd' ? [file, file.replace(/\.service$/, '.timer')] : [file];
  return all.filter((f) => existsSync(f));
}

function removeJob(d: SystemDeps, key: ScheduleKey, lines: string[]): boolean {
  const m = jobManager(d);
  const files = installedJobFiles(d, key);
  if (!files.length) return false;
  if (m === 'launchd') d.capture('launchctl', ['bootout', `gui/${d.uid}/${jobLabel(key)}`]);
  if (m === 'systemd') d.capture('systemctl', ['--user', 'disable', '--now', `${unitName(key)}.timer`]);
  for (const f of files) rmSync(f, { force: true });
  lines.push(`schedules: ${key}: removed ${files.join(', ')}`);
  return true;
}

/**
 * Make the OS jobs match `schedules`: write and load the ones on, unload and remove the ones off. A job
 * already installed for the same key, spec, vault, node and cli is left alone unless `force`.
 */
export async function syncJobs(home: string, schedules: Schedules, d: SystemDeps, opts: JobOptions = {}): Promise<SyncResult> {
  const m = jobManager(d);
  const lines: string[] = [];
  let ok = true;
  const plans = planJobs(home, schedules, d, opts);
  if (m === 'cron') {
    const on = plans.filter((p) => p.cron);
    for (const p of plans.filter((x) => x.error)) {
      ok = false;
      lines.push(`schedules: ${p.key}: ${p.error}`);
    }
    if (on.length) {
      mkdirSync(scheduleLogDir(d), { recursive: true });
      lines.push('schedules: no launchd or systemd here; add these lines with crontab -e:');
      for (const p of on) lines.push(`  ${p.cron}`);
    } else lines.push('schedules: all off; nothing to add to crontab');
    return { ok, lines };
  }
  let reload = false;
  const changed: ScheduleKey[] = [];
  const current = opts.force ? null : jobStatus(home, schedules, d, opts);
  for (const p of plans) {
    if (!p.on) {
      if (removeJob(d, p.key, lines)) reload = true;
      else lines.push(`schedules: ${p.key}: off`);
      continue;
    }
    if (p.error) {
      ok = false;
      lines.push(`schedules: ${p.key}: ${p.error}`);
      continue;
    }
    if (current?.[p.key] === 'installed') {
      lines.push(`schedules: ${p.key}: ${p.spec} (unchanged)`);
      continue;
    }
    changed.push(p.key);
    mkdirSync(scheduleLogDir(d), { recursive: true });
    for (const f of p.files) {
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, f.content);
    }
    const file = p.files[0]?.path as string;
    if (m === 'launchd') {
      // Reload: bootout fails harmlessly when the job is not loaded yet.
      d.capture('launchctl', ['bootout', `gui/${d.uid}/${jobLabel(p.key)}`]);
      const r = d.capture('launchctl', ['bootstrap', `gui/${d.uid}`, file]);
      if (r.code !== 0) {
        ok = false;
        lines.push(`schedules: ${p.key}: launchctl bootstrap failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`} (${file})`);
        continue;
      }
    } else reload = true;
    lines.push(`schedules: ${p.key}: ${p.spec} -> ${file}`);
  }
  if (m === 'systemd' && reload) {
    const r = d.capture('systemctl', ['--user', 'daemon-reload']);
    if (r.code !== 0) {
      ok = false;
      lines.push(`schedules: systemctl --user daemon-reload failed: ${(r.stderr || r.stdout).trim()}`);
    }
    for (const p of plans.filter((x) => changed.includes(x.key))) {
      const e = d.capture('systemctl', ['--user', 'enable', '--now', `${unitName(p.key)}.timer`]);
      if (e.code !== 0) {
        ok = false;
        lines.push(`schedules: ${p.key}: systemctl --user enable failed: ${(e.stderr || e.stdout).trim() || `exit ${e.code}`}`);
      }
    }
  }
  return { ok, lines };
}

/** Unload and remove every schedule job (config untouched). */
export function removeJobs(d: SystemDeps): SyncResult {
  const lines: string[] = [];
  let any = false;
  for (const key of SCHEDULE_KEYS) any = removeJob(d, key, lines) || any;
  if (any && jobManager(d) === 'systemd') d.capture('systemctl', ['--user', 'daemon-reload']);
  if (!any) lines.push(jobManager(d) === 'cron' ? 'schedules: remove the pp lines with crontab -e' : 'schedules: no jobs installed');
  return { ok: true, lines };
}

/** The engine service (`EngineServices.scheduleJobs`): `schedules.status` and `config.update` use it. */
export function scheduleJobsService(home: string, d: SystemDeps, opts: JobOptions = {}): ops.ScheduleJobs {
  return {
    status: (schedules) => jobStatus(home, schedules, d, opts),
    sync: (schedules) => syncJobs(home, schedules, d, opts),
  };
}

/** One doctor line (#29): the OS jobs match config.schedules. No jobs at all is fine (declined; `pp up` catches up). */
export function scheduleJobsCheck(
  home: string,
  schedules: Schedules,
  d: SystemDeps,
  opts: JobOptions = {},
): { name: string; ok: boolean; detail: string } {
  const st = jobStatus(home, schedules, d, opts);
  const states = Object.entries(st) as [ScheduleKey, ScheduleJobState][];
  const name = 'schedule_jobs';
  if (states.some(([, s]) => s === 'manual')) return { name, ok: true, detail: 'cron: check crontab -l against pp schedules install' };
  const installed = states.filter(([, s]) => s === 'installed' || s === 'stale' || s === 'orphan');
  if (!installed.length)
    return { name, ok: true, detail: states.some(([, s]) => s === 'missing') ? 'not installed (pp schedules install)' : 'all off' };
  const bad = states.filter(([, s]) => s !== 'installed' && s !== 'off');
  if (bad.length) return { name, ok: false, detail: `${bad.map(([k, s]) => `${k} ${s}`).join(', ')}; run pp schedules install` };
  return { name, ok: true, detail: states.map(([k, s]) => `${k} ${s === 'off' ? 'off' : schedules[k]}`).join(', ') };
}
