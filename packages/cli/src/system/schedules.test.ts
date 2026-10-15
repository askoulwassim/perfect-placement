/*
 * Job state compares paths by file identity (#97): a repo moved behind a symlink, a vault reached by a
 * link, or node via the Homebrew opt link vs its Cellar target is still `installed`. Temp HOME, real
 * symlinks in a temp dir, fake deps; nothing touches the real LaunchAgents.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ops } from '@perfect-placement/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeDeps, fakeDeps } from './fake-deps.test-helpers.js';
import { jobStatus, planJobs, type Schedules, samePath, scheduleLogDir, syncJobs } from './schedules.js';

let root: string;
let d: FakeDeps;
const schedules: Schedules = { inbox: 'daily 07:30', freshness: 'off', scout_score: 'fri 05:30' };

const touch = (p: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '');
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pp-sched-real-'));
  touch(join(root, 'repo.nosync', 'dist', 'index.js'));
  symlinkSync(join(root, 'repo.nosync'), join(root, 'repo'));
  mkdirSync(join(root, 'vault.real'));
  symlinkSync(join(root, 'vault.real'), join(root, 'vault'));
  touch(join(root, 'brew', 'Cellar', 'node@22', '22.23.3_1', 'bin', 'node'));
  mkdirSync(join(root, 'brew', 'opt'));
  symlinkSync(join(root, 'brew', 'Cellar', 'node@22', '22.23.3_1'), join(root, 'brew', 'opt', 'node@22'));
  touch(join(root, 'other', 'dist', 'index.js'));
  d = fakeDeps(join(root, 'home'), { env: { PATH: '/usr/bin' }, nodePath: join(root, 'brew', 'opt', 'node@22', 'bin', 'node') });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const linkCli = () => join(root, 'repo', 'dist', 'index.js');
const realCli = () => join(root, 'repo.nosync', 'dist', 'index.js');
const cellarNode = () => join(root, 'brew', 'Cellar', 'node@22', '22.23.3_1', 'bin', 'node');

/** Write the jobs as `pp schedules install` would, from these inputs. */
function install(home: string, cli: string, nodePath = d.nodePath) {
  for (const p of planJobs(home, schedules, { ...d, nodePath }, { cli }))
    for (const f of p.files) {
      touch(f.path);
      writeFileSync(f.path, f.content);
    }
}
const states = (home: string, cli: string) => Object.values(jobStatus(home, schedules, d, { cli }));

describe('schedule job state by file identity (#97)', () => {
  it('job written with the symlink cli, expected with the real path: installed', () => {
    install(join(root, 'vault'), linkCli());
    expect(states(join(root, 'vault'), realCli())).toEqual(['installed', 'off', 'installed']);
  });

  it('job written with the real cli and vault, expected through the symlinks: installed', () => {
    install(join(root, 'vault.real'), realCli());
    expect(states(join(root, 'vault'), linkCli())).toEqual(['installed', 'off', 'installed']);
  });

  it('node via the opt link vs its Cellar realpath: installed, and the plist keeps the opt path', () => {
    install(join(root, 'vault'), realCli(), cellarNode());
    expect(states(join(root, 'vault'), realCli())).toEqual(['installed', 'off', 'installed']);
    const plan = planJobs(join(root, 'vault'), schedules, d, { cli: realCli() })[0];
    expect(plan?.files[0]?.content).toContain(`<string>${d.nodePath}</string>`);
  });

  it('a genuinely different cli is stale', () => {
    install(join(root, 'vault'), join(root, 'other', 'dist', 'index.js'));
    expect(states(join(root, 'vault'), realCli())).toEqual(['stale', 'off', 'stale']);
  });

  it('a cli that no longer exists is stale', () => {
    install(join(root, 'vault'), join(root, 'gone', 'dist', 'index.js'));
    expect(states(join(root, 'vault'), realCli())).toEqual(['stale', 'off', 'stale']);
  });

  it('samePath uses the injected realpath and falls back to string equality when it throws', () => {
    const fail = () => {
      throw new Error('ENOENT');
    };
    expect(samePath('/a', '/a', fail)).toBe(true);
    expect(samePath('/a', '/b', fail)).toBe(false);
    expect(samePath('/a', '/b', () => '/same')).toBe(true);
  });
});

async function selectRunner(command: 'codex' | 'claude' | 'cursor-agent') {
  const engine = ops.openEngine({ home: join(root, 'vault') });
  try {
    const result = await engine.runOp('config.update', { patch: { runner: { command } } }, { actor: 'human', now: d.now });
    expect(result.status, JSON.stringify(result)).toBe('ok');
  } finally {
    engine.close();
  }
}

describe('Codex browser locations in scheduled jobs', () => {
  const locations = () => ({
    HOME: d.home,
    XDG_CACHE_HOME: join(root, 'cache & <browser>'),
    XDG_CONFIG_HOME: join(root, 'config \' " $HOME \\%n'),
    CHROME_CONFIG_HOME: join(root, 'chrome-config'),
    LOCALAPPDATA: join(root, 'local-app-data'),
    APPDATA: join(root, 'app-data'),
  });
  function setLocations() {
    d.env = {
      ...d.env,
      ...locations(),
      HOME: '/must-not-override-system-deps-home',
      SECRET_TOKEN: 'do-not-copy',
      TMPDIR: join(root, 'shell-scratch'),
    };
  }
  const plan = () => planJobs(join(root, 'vault'), schedules, d, { cli: realCli() })[0];

  it('writes launchd locations, roundtrips XML metacharacters, and uses the injected user home', async () => {
    await selectRunner('codex');
    setLocations();
    const content = plan()?.files[0]?.content as string;
    const dict = /<key>EnvironmentVariables<\/key>\s*<dict>(.*?)<\/dict>/s.exec(content)?.[1] as string;
    const env = Object.fromEntries(
      [...dict.matchAll(/<key>(.*?)<\/key><string>(.*?)<\/string>/gs)].map((match) => [
        match[1],
        match[2]?.replace(/&#13;/g, '\r').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&'),
      ]),
    );
    expect(ops.codexBrowserEnvironment(env)).toEqual(locations());
    expect(content).not.toContain('do-not-copy');
    expect(content).not.toContain('/must-not-override-system-deps-home');
    expect(content).not.toContain('shell-scratch');
    expect(ops.codexBrowserRuntime({ env }).dir).toBe(ops.codexBrowserRuntime({ userHome: d.home, env: d.env }).dir);
  });

  it('quotes systemd location assignments without line injection or percent expansion', async () => {
    await selectRunner('codex');
    setLocations();
    d.platform = 'linux';
    d.which = (cmd) => (cmd === 'systemctl' ? '/usr/bin/systemctl' : null);
    d.env.XDG_CONFIG_HOME += '\nEnvironment=BAD=unexpected\r\t';
    const service = plan()?.files[0]?.content as string;
    const lines = service.split('\n').filter((line) => line.startsWith('Environment='));
    const env = Object.fromEntries(
      lines.map((line) => {
        const assignment = (JSON.parse(line.slice('Environment='.length)) as string).replace(/%%/g, '%');
        const equals = assignment.indexOf('=');
        return [assignment.slice(0, equals), assignment.slice(equals + 1)];
      }),
    );
    expect(ops.codexBrowserEnvironment(env)).toEqual({ ...locations(), XDG_CONFIG_HOME: d.env.XDG_CONFIG_HOME });
    expect(lines).toHaveLength(9); // PATH, PP_HOME, PP_NODE, and the six browser locations.
    expect(service).toContain('%%n');
    expect(service).not.toContain('\nEnvironment=BAD');
    expect(service).not.toContain('do-not-copy');
    expect(ops.codexBrowserRuntime({ env }).dir).toBe(ops.codexBrowserRuntime({ userHome: d.home, env: d.env }).dir);
  });

  it('roundtrips cron values through a real shell without evaluating their contents', async () => {
    await selectRunner('codex');
    setLocations();
    d.platform = 'linux';
    d.which = () => null;
    d.nodePath = process.execPath;
    const output = join(root, 'cron-env.json');
    const script = join(root, 'capture.mjs');
    writeFileSync(
      script,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.env));`,
    );
    const cron = planJobs(join(root, 'vault'), schedules, d, { cli: script })[0]?.cron as string;
    expect(cron).not.toContain('do-not-copy');
    mkdirSync(scheduleLogDir(d), { recursive: true });
    // Cron removes the backslash protecting each percent before sending the command to /bin/sh.
    const command = cron.replace(/^\S+ \S+ \S+ \S+ \S+ /, '').replace(/\\%/g, '%');
    const result = spawnSync('/bin/sh', ['-c', command], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' });
    expect(result.status).toBe(0);
    const env = JSON.parse(readFileSync(output, 'utf8')) as Record<string, string>;
    expect(ops.codexBrowserEnvironment(env)).toEqual(locations());
    expect(ops.codexBrowserRuntime({ env }).dir).toBe(ops.codexBrowserRuntime({ userHome: d.home, env: d.env }).dir);
  });

  it('reports unsupported cron line breaks instead of generating additional commands', async () => {
    await selectRunner('codex');
    setLocations();
    d.platform = 'linux';
    d.which = () => null;
    d.env.XDG_CACHE_HOME = '/tmp/cache\n* * * * * injected';
    expect(plan()).toMatchObject({ error: expect.stringContaining('cannot contain line breaks'), files: [] });
    expect(plan()?.cron).toBeUndefined();
  });

  it('marks old or changed browser environments stale and refreshes them through syncJobs', async () => {
    await selectRunner('claude');
    setLocations();
    install(join(root, 'vault'), realCli());
    expect(states(join(root, 'vault'), realCli())).toEqual(['installed', 'off', 'installed']);
    await selectRunner('codex');
    expect(states(join(root, 'vault'), realCli())).toEqual(['stale', 'off', 'stale']);
    expect((await syncJobs(join(root, 'vault'), schedules, d, { cli: realCli() })).ok).toBe(true);
    expect(states(join(root, 'vault'), realCli())).toEqual(['installed', 'off', 'installed']);
    d.env.XDG_CACHE_HOME = join(root, 'another-cache');
    expect(states(join(root, 'vault'), realCli())).toEqual(['stale', 'off', 'stale']);
    expect((await syncJobs(join(root, 'vault'), schedules, d, { cli: realCli() })).ok).toBe(true);
    expect(states(join(root, 'vault'), realCli())).toEqual(['installed', 'off', 'installed']);
    // A shell's temp dir varies (agent sandboxes set their own) and is not part of the job.
    d.env.TMPDIR = join(root, 'another-shell-scratch');
    expect(states(join(root, 'vault'), realCli())).toEqual(['installed', 'off', 'installed']);
    delete d.env.XDG_CONFIG_HOME;
    expect(states(join(root, 'vault'), realCli())).toEqual(['stale', 'off', 'stale']);
  });

  it('keeps other runners’ job environment and identity independent of browser locations', async () => {
    setLocations();
    for (const runner of ['claude', 'cursor-agent'] as const) {
      await selectRunner(runner);
      install(join(root, 'vault'), realCli());
      expect(plan()?.files[0]?.content).not.toContain('XDG_CACHE_HOME');
      d.env.XDG_CACHE_HOME += '-changed';
      expect(states(join(root, 'vault'), realCli())).toEqual(['installed', 'off', 'installed']);
    }
  });
});
