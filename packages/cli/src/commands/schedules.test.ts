/*
 * Schedules as OS jobs (#29): temp HOME + temp PP_HOME, fake launchctl / systemctl (SystemDeps.capture),
 * fake runner launcher. Nothing touches the real LaunchAgents, systemd or crontab.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ops } from '@perfect-placement/engine';
import { fakeBackend, fakeLauncher, noNetwork } from '@perfect-placement/engine/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import type { Io } from '../io.js';
import { awakeCommand, holdAwake } from '../system/awake.js';
import { type FakeDeps, fakeDeps } from '../system/fake-deps.test-helpers.js';
import { onCalendar } from '../system/schedules.js';

let root: string;
let home: string;
let ppHome: string;
let out: string[];
let err: string[];
let d: FakeDeps;
let launcher: ReturnType<typeof fakeLauncher>;
let io: Io;

const services = () => ({ fetch: noNetwork, launcher, backends: { kev: fakeBackend('kev', 'down') }, freshnessDelayMs: 0, env: {} });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'pp-sched-'));
  home = join(root, 'home');
  ppHome = join(root, 'vault');
  out = [];
  err = [];
  d = fakeDeps(home, { env: { PATH: '/usr/local/bin:/usr/bin' } });
  launcher = fakeLauncher();
  io = {
    env: { PP_HOME: ppHome },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    stdin: () => '',
    sys: d,
    services: services(),
    runnerAlive: () => true,
  };
  expect(await runCli(['init'], io)).toBe(0);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const agents = () => join(home, 'Library', 'LaunchAgents');
const plistOf = (key: string) => join(agents(), `com.perfectplacement.${key}.plist`);
const status = async () => {
  out.length = 0;
  await runCli(['schedules', 'status', '--json'], io);
  return JSON.parse(out.join('\n')) as Array<{ key: string; job: string; next_run: string | null; last_run: { status: string } | null }>;
};
const doctorCheck = async () => {
  out.length = 0;
  await runCli(['doctor', '--json'], io);
  return (JSON.parse(out.at(-1) as string) as { checks: { name: string; ok: boolean; detail?: string }[] }).checks.find(
    (c) => c.name === 'schedule_jobs',
  );
};
const launchctl = () => d.captures.filter((c) => c.cmd === 'launchctl').map((c) => c.args.join(' '));

describe('pp schedules on macOS (launchd)', () => {
  it('install writes one LaunchAgent per schedule that runs pp run <skill> --schedule, then loads it', async () => {
    expect(await doctorCheck()).toEqual({ name: 'schedule_jobs', ok: true, detail: 'not installed (pp schedules install)' });
    expect((await status()).map((s) => s.job)).toEqual(['missing', 'missing', 'missing']);

    expect(await runCli(['schedules', 'install'], io)).toBe(0);
    const scout = readFileSync(plistOf('scout_score'), 'utf8');
    expect(scout).toContain('<key>Label</key><string>com.perfectplacement.scout_score</string>');
    const args = [...scout.matchAll(/^ {4}<string>(.*)<\/string>$/gm)].map((m) => m[1]);
    expect(args).toEqual([
      '/opt/node22/bin/node',
      expect.stringMatching(/packages\/cli\/dist\/index\.js$/),
      'run',
      'scout',
      '--schedule',
      '--home',
      ppHome,
    ]);
    expect(scout).toContain(
      '<dict><key>Weekday</key><integer>5</integer><key>Hour</key><integer>5</integer><key>Minute</key><integer>30</integer></dict>',
    );
    expect(scout).toMatch(/<key>PATH<\/key><string>\/opt\/node22\/bin:\/usr\/local\/bin:\/usr\/bin:/);
    expect(scout).toContain(`<key>PP_HOME</key><string>${ppHome}</string>`);
    expect(scout).toContain(join(home, 'Library', 'Logs', 'perfect-placement', 'scout_score.log'));
    const inbox = readFileSync(plistOf('inbox'), 'utf8');
    expect(inbox).toContain(
      '<key>StartCalendarInterval</key>\n    <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>30</integer></dict>',
    );
    expect(launchctl()).toEqual(
      expect.arrayContaining([
        'bootout gui/501/com.perfectplacement.inbox',
        `bootstrap gui/501 ${plistOf('inbox')}`,
        `bootstrap gui/501 ${plistOf('scout_score')}`,
      ]),
    );
    expect((await status()).map((s) => s.job)).toEqual(['installed', 'installed', 'installed']);
    expect((await doctorCheck())?.ok).toBe(true);
  });

  it('turning a schedule off through config.update removes its job; a hand-edited job is stale in doctor', async () => {
    expect(await runCli(['schedules', 'install'], io)).toBe(0);
    d.captures.length = 0;
    expect(await runCli(['op', 'config.update', '--actor', 'human', '--input', '{"patch":{"schedules":{"inbox":"off"}}}'], io)).toBe(0);
    expect(existsSync(plistOf('inbox'))).toBe(false);
    expect(launchctl()).toEqual(['bootout gui/501/com.perfectplacement.inbox']);
    expect((await status()).map((s) => s.job)).toEqual(['off', 'installed', 'installed']);

    writeFileSync(plistOf('freshness'), readFileSync(plistOf('freshness'), 'utf8').replace(/pp-schedule \S+/, 'pp-schedule old'));
    expect(await doctorCheck()).toEqual({ name: 'schedule_jobs', ok: false, detail: 'freshness stale; run pp schedules install' });

    expect(await runCli(['schedules', 'remove'], io)).toBe(0);
    expect([plistOf('freshness'), plistOf('scout_score')].some(existsSync)).toBe(false);
    expect((await doctorCheck())?.ok).toBe(true);
  });

  it('a job launchctl refuses fails the install with the reason', async () => {
    d.capture = (cmd, args) => {
      d.captures.push({ cmd, args });
      return args[0] === 'bootstrap'
        ? { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' }
        : { code: 0, stdout: '', stderr: '' };
    };
    expect(await runCli(['schedules', 'install'], io)).toBe(1);
    expect(err.join('\n')).toContain('inbox: launchctl bootstrap failed: Bootstrap failed: 5: Input/output error');
  });
});

describe('pp schedules on Linux', () => {
  it('systemd user timers: a service + timer per schedule, Persistent, enabled', async () => {
    d.platform = 'linux';
    d.which = (c) => (c === 'systemctl' ? '/usr/bin/systemctl' : null);
    expect(await runCli(['schedules', 'install'], io)).toBe(0);
    const dir = join(home, '.config', 'systemd', 'user');
    const timer = readFileSync(join(dir, 'pp-scout-score.timer'), 'utf8');
    expect(timer).toContain('OnCalendar=Fri *-*-* 05:30:00');
    expect(timer).toContain('Persistent=true');
    const service = readFileSync(join(dir, 'pp-scout-score.service'), 'utf8');
    expect(service).toMatch(/ExecStart="\/opt\/node22\/bin\/node" ".+index\.js" "run" "scout" "--schedule" "--home" ".+vault"/);
    expect(service).toContain(`Environment="PP_HOME=${ppHome}"`);
    const calls = d.captures.filter((c) => c.cmd === 'systemctl').map((c) => c.args.join(' '));
    expect(calls).toEqual([
      '--user daemon-reload',
      '--user enable --now pp-inbox.timer',
      '--user enable --now pp-freshness.timer',
      '--user enable --now pp-scout-score.timer',
    ]);
    expect((await status()).map((s) => s.job)).toEqual(['installed', 'installed', 'installed']);
    expect(onCalendar({ days: [1, 4], hour: 8, minute: 0, daily: false })).toBe('Mon,Thu *-*-* 08:00:00');
  });

  it('no job manager: prints crontab lines, writes nothing, status manual', async () => {
    d.platform = 'linux';
    d.which = () => null;
    expect(await runCli(['schedules', 'install'], io)).toBe(0);
    expect(out.join('\n')).toContain('add these lines with crontab -e');
    expect(out.find((l) => l.includes("'scout'"))).toMatch(/^ {2}30 5 \* \* 5 PATH=.+ '--schedule' '--home'/);
    expect(d.captures).toEqual([]);
    expect((await status()).map((s) => s.job)).toEqual(['manual', 'manual', 'manual']);
  });
});

describe('pp run <skill> --schedule (what each job runs)', () => {
  it('queues a schedule run, drains the queue, waits for the runner to finish it', async () => {
    out.length = 0;
    const idOf = () => /scout run (\S+) queued/.exec(out.join('\n'))?.[1] as string;
    d.sleep = async () => {
      // The headless agent finishes its run while pp run waits.
      const e = ops.openEngine({ home: ppHome, services: services() });
      await e.runOp('runs.finish', { run_id: idOf(), status: 'ok', summary: { added: 0 } }, { actor: 'agent', now: () => new Date() });
      e.close();
    };
    expect(await runCli(['run', 'scout', '--schedule'], io)).toBe(0);
    const runId = idOf();
    expect(out[0]).toBe(`pp run: scout run ${runId} queued (schedule scout_score)`);
    expect(out).toContain(`pp run: scout run ${runId} ok`);
    expect(launcher.specs.map((s) => s.runId)).toEqual([runId]);
    const items = await status();
    expect(items.find((s) => s.key === 'scout_score')?.last_run?.status).toBe('ok');
  });

  it('holds a power assertion on its own pid while the scheduled run runs, released when it ends (#121)', async () => {
    d = fakeDeps(home, { env: { PATH: '/usr/bin' }, bins: ['caffeinate'] });
    io = { ...io, sys: d };
    const idOf = () => /inbox run (\S+) queued/.exec(out.join('\n'))?.[1] as string;
    let heldDuringRun = false;
    d.sleep = async () => {
      heldDuringRun = d.spawned.length === 1 && d.livePids.has((d.spawned[0] as { pid: number }).pid);
      const e = ops.openEngine({ home: ppHome, services: services() });
      await e.runOp('runs.finish', { run_id: idOf(), status: 'ok' }, { actor: 'agent', now: () => new Date() });
      e.close();
    };
    out.length = 0;
    expect(await runCli(['run', 'inbox', '--schedule'], io)).toBe(0);
    expect(d.spawned.map((s) => [s.cmd, s.args])).toEqual([['caffeinate', ['-i', '-s', '-w', String(process.pid)]]]);
    expect(heldDuringRun).toBe(true);
    const pid = (d.spawned[0] as { pid: number }).pid;
    expect(d.killed).toEqual([pid]);
    // A human's pp run holds nothing.
    d.sleep = async () => {
      const e = ops.openEngine({ home: ppHome, services: services() });
      const id = /inbox run (\S+) queued$/.exec(out.at(-1) ?? '')?.[1] as string;
      await e.runOp('runs.finish', { run_id: id, status: 'ok' }, { actor: 'agent', now: () => new Date() });
      e.close();
    };
    out.length = 0;
    expect(await runCli(['run', 'inbox'], io)).toBe(0);
    expect(d.spawned).toHaveLength(1);
  });

  it('awake command per platform: caffeinate, systemd-inhibit tied to the pid, or nothing', () => {
    expect(awakeCommand(fakeDeps(home, { bins: ['caffeinate'] }), 77)).toEqual({ cmd: 'caffeinate', args: ['-i', '-s', '-w', '77'] });
    expect(awakeCommand(fakeDeps(home, { bins: [] }), 77)).toBeNull();
    const linux = fakeDeps(home, { platform: 'linux', bins: ['systemd-inhibit', 'tail'] });
    expect(awakeCommand(linux, 77)?.args).toEqual([
      '--what=sleep:idle',
      '--who=Perfect Placement',
      '--why=scheduled run',
      '--mode=block',
      'tail',
      '--pid=77',
      '-f',
      '/dev/null',
    ]);
    expect(awakeCommand(fakeDeps(home, { platform: 'linux', bins: ['tail'] }), 77)).toBeNull();
    expect(awakeCommand(fakeDeps(home, { platform: 'win32', bins: ['caffeinate'] }), 77)).toBeNull();
    const hold = holdAwake(linux, { pid: 77, cwd: root });
    expect(hold.tool).toBe('systemd-inhibit');
    hold.release();
    hold.release();
    expect(linux.killed).toEqual([hold.pid]);
    const none = holdAwake(fakeDeps(home, { bins: [] }), { pid: 77, cwd: root });
    expect(none.tool).toBeNull();
    none.release();
  });

  it('a skill without a schedule is refused; --no-wait returns after queueing', async () => {
    expect(await runCli(['run', 'tailor', '--schedule'], io)).toBe(2);
    expect(await runCli(['run', 'inbox', '--schedule', '--no-wait'], io)).toBe(0);
    expect(out.at(-1)).toMatch(/^pp run: inbox run \S+ queued \(schedule inbox\)$/);
  });
});

describe('pp up catch-up', () => {
  it('queues a schedule that fired since its last run, once', async () => {
    const e = ops.openEngine({ home: ppHome, services: services() });
    const threeDaysAgo = () => new Date(Date.now() - 3 * 86_400_000);
    const o = await e.runOp('runs.start', { skill: 'inbox', schedule: 'inbox' }, { actor: 'schedule', now: threeDaysAgo });
    const old = (o as { output: { run: { id: string } } }).output.run.id;
    await e.runOp('runs.finish', { run_id: old, status: 'ok' }, { actor: 'agent', now: threeDaysAgo });
    e.close();
    const upIo: Io = { ...io, sys: undefined };
    delete upIo.sys;
    expect(await runCli(['up', '--port', '0', '--web', 'none', '--no-kev'], upIo, async () => {})).toBe(0);
    const line = out.find((l) => l.startsWith('pp up: caught up'));
    expect(line).toMatch(/^pp up: caught up inbox \(rn_\S+\)$/);
    out.length = 0;
    expect(await runCli(['up', '--port', '0', '--web', 'none', '--no-kev', '--no-catch-up'], upIo, async () => {})).toBe(0);
    expect(out.some((l) => l.startsWith('pp up: caught up'))).toBe(false);
  });
});
