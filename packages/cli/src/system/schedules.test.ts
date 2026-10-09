/*
 * Job state compares paths by file identity (#97): a repo moved behind a symlink, a vault reached by a
 * link, or node via the Homebrew opt link vs its Cellar target is still `installed`. Temp HOME, real
 * symlinks in a temp dir, fake deps; nothing touches the real LaunchAgents.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeDeps, fakeDeps } from './fake-deps.test-helpers.js';
import { jobStatus, planJobs, type Schedules, samePath } from './schedules.js';

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
