/*
 * pp uninstall end to end on a temp HOME + temp PP_HOME with injected command runners (fake claude,
 * launchctl, systemctl, crontab) and fake processes. Nothing touches the real machine.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeBackend, fakeLauncher, noNetwork } from '@perfect-placement/engine/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import type { Io } from '../io.js';
import { type FakeDeps, fakeDeps } from '../system/fake-deps.test-helpers.js';
import { kevPaths } from '../system/kev.js';

let root: string;
let home: string;
let ppHome: string;
let bin: string;
let out: string[];
let err: string[];
let asked: string[];
let d: FakeDeps;
let io: Io;
/** The fake `claude` CLI's view of ~/.claude.json, and whether `mcp remove` fails. */
let claudeRemoveFails: boolean;

const claudeJson = () => join(home, '.claude.json');
const cursorJson = () => join(home, '.cursor', 'mcp.json');
const desktopJson = () => join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
const codexToml = () => join(home, '.codex', 'config.toml');
const plist = (key: string) => join(home, 'Library', 'LaunchAgents', `com.perfectplacement.${key}.plist`);
const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const text = () => out.join('\n');
const PP = { command: '/opt/node22/bin/node', args: ['/repo/packages/mcp/dist/bin.js'], env: { PP_HOME: '/v' } };
const OTHER = { command: 'npx', args: ['other-server'] };

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'pp-uninstall-'));
  home = join(root, 'home');
  ppHome = join(root, 'vault');
  bin = join(home, '.local', 'bin');
  mkdirSync(home);
  out = [];
  err = [];
  asked = [];
  claudeRemoveFails = false;
  d = fakeDeps(home, { bins: ['git', 'uv', 'claude'], env: { PATH: '/usr/bin' } });
  const capture = d.capture;
  d.capture = (cmd, args) => {
    // Fake `claude mcp remove --scope user pp`: edits ~/.claude.json the way Claude Code does.
    if (cmd === '/usr/bin/claude' && args[1] === 'remove') {
      d.captures.push({ cmd, args });
      if (claudeRemoveFails) return { code: 1, stdout: '', stderr: 'No user-scoped MCP server named pp' };
      const doc = readJson(claudeJson());
      delete doc.mcpServers.pp;
      writeFileSync(claudeJson(), JSON.stringify(doc, null, 2));
      return { code: 0, stdout: 'Removed MCP server pp', stderr: '' };
    }
    return capture(cmd, args);
  };
  io = {
    env: { PP_HOME: ppHome },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    stdin: () => '',
    ask: async (q, def) => {
      asked.push(q);
      return def;
    },
    sys: d,
    services: { fetch: noNetwork, launcher: fakeLauncher(), backends: { kev: fakeBackend('kev', 'down') }, freshnessDelayMs: 0, env: {} },
  };
  expect(await runCli(['init'], io)).toBe(0);
  out.length = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Everything pp setup / kev / schedules / install.sh would have left, plus other tools' entries. */
async function installEverything() {
  writeFileSync(claudeJson(), JSON.stringify({ numStartups: 3, mcpServers: { pp: PP, other: OTHER }, projects: {} }, null, 2));
  mkdirSync(join(home, '.cursor'));
  writeFileSync(cursorJson(), JSON.stringify({ mcpServers: { pp: PP, other: OTHER } }, null, 2));
  mkdirSync(join(desktopJson(), '..'), { recursive: true });
  writeFileSync(desktopJson(), JSON.stringify({ mcpServers: { pp: PP }, globalShortcut: 'x' }, null, 2));
  mkdirSync(join(home, '.codex'));
  writeFileSync(codexToml(), `model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.pp]\ncommand = "/n"\nargs = []\n`);
  expect(await runCli(['schedules', 'install'], io)).toBe(0);
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'pp'), '#!/bin/sh\nPP_NODE="/n" exec "/n" "/repo/packages/cli/dist/index.js" "$@"\n');
  writeFileSync(join(bin, 'pp-mcp'), '#!/bin/sh\nexec /usr/local/bin/something-else "$@"\n');
  // A Kev that pp started.
  mkdirSync(kevPaths(ppHome).dir, { recursive: true });
  writeFileSync(kevPaths(ppHome).state, '{}');
  writeFileSync(kevPaths(ppHome).pid, '777\n');
  d.livePids.add(777);
  out.length = 0;
  d.captures.length = 0;
}

/** Path -> content (or link target) for every file under root: proves a run changed nothing. */
function snapshot(dir: string): Record<string, string> {
  const res: Record<string, string> = {};
  const walk = (p: string) => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) res[relative(root, p)] = `-> ${readlinkSync(p)}`;
    else if (st.isDirectory()) {
      res[`${relative(root, p)}/`] = '';
      for (const f of readdirSync(p)) walk(join(p, f));
    } else res[relative(root, p)] = `${st.mode}:${readFileSync(p, 'base64')}`;
  };
  walk(dir);
  return res;
}

describe('pp uninstall (setup reset: keeps the vault)', () => {
  it('removes only what pp added, backs up each config first, keeps the vault; rerun: nothing to remove', async () => {
    await installEverything();
    expect(await runCli(['uninstall', '--yes'], io)).toBe(0);

    // Kev: the pid pp started.
    expect(d.killed).toEqual([777]);
    // Schedules: unloaded, files gone.
    expect(existsSync(plist('inbox'))).toBe(false);
    expect(d.captures.filter((c) => c.cmd === 'launchctl' && c.args[0] === 'bootout').length).toBe(3);
    // Claude Code through its CLI, after a backup.
    expect(d.captures.find((c) => c.cmd === '/usr/bin/claude')?.args).toEqual(['mcp', 'remove', '--scope', 'user', 'pp']);
    expect(readJson(claudeJson())).toEqual({ numStartups: 3, mcpServers: { other: OTHER }, projects: {} });
    const backups = readdirSync(home).filter((f) => f.startsWith('.claude.json.bak-'));
    expect(backups.length).toBe(1);
    expect(readJson(join(home, backups[0] as string)).mcpServers.pp).toEqual(PP);
    // Cursor / Desktop / Codex: only pp, other servers and keys kept, backups made.
    expect(readJson(cursorJson())).toEqual({ mcpServers: { other: OTHER } });
    expect(readJson(desktopJson())).toEqual({ mcpServers: {}, globalShortcut: 'x' });
    expect(readFileSync(codexToml(), 'utf8')).toBe('model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n');
    expect(readdirSync(join(home, '.cursor')).some((f) => f.startsWith('mcp.json.bak-'))).toBe(true);
    expect(readdirSync(join(home, '.codex')).some((f) => f.startsWith('config.toml.bak-'))).toBe(true);
    // Launchers: ours deleted, someone else's pp-mcp left alone.
    expect(existsSync(join(bin, 'pp'))).toBe(false);
    expect(existsSync(join(bin, 'pp-mcp'))).toBe(true);
    // Vault kept.
    expect(existsSync(join(ppHome, 'pp.db'))).toBe(true);

    expect(text()).toContain(`pp uninstall: setup reset; your vault at ${ppHome} is kept (--purge removes it)`);
    expect(text()).toMatch(/Uninstall summary:/);
    expect(text()).toMatch(/ok {4}kev +stopped \(pid 777\)/);
    expect(text()).toMatch(/ok {4}mcp Claude Code +removed \(backup .+\.claude\.json\.bak-/);
    expect(text()).toMatch(/skip {2}launcher pp-mcp +.+ is not a Perfect Placement launcher; left alone/);
    expect(text()).toContain('corepack disable pnpm');
    expect(out.at(-1)).toBe('uninstall: done');

    out.length = 0;
    const before = snapshot(root);
    expect(await runCli(['uninstall', '--yes'], io)).toBe(0);
    expect(text()).toContain('pp uninstall: nothing to remove');
    expect(snapshot(root)).toEqual(before);
  });

  it('--dry-run prints the exact plan and changes nothing', async () => {
    await installEverything();
    const before = snapshot(root);
    expect(await runCli(['uninstall', '--dry-run'], io)).toBe(0);
    expect(snapshot(root)).toEqual(before);
    expect(d.killed).toEqual([]);
    expect(d.captures).toEqual([]);
    expect(asked).toEqual([]);
    expect(text()).toContain(`stop    kev`);
    expect(text()).toContain(plist('scout_score'));
    expect(text()).toContain('claude mcp remove --scope user pp');
    expect(text()).toContain(`remove the "pp" server from ${cursorJson()}`);
    expect(text()).toContain(join(bin, 'pp'));
    expect(text()).toContain('Dry run: nothing was changed.');
  });

  it('asks first and defaults to no', async () => {
    await installEverything();
    const before = snapshot(root);
    expect(await runCli(['uninstall'], io)).toBe(0);
    expect(asked).toEqual(['Remove the 7 item(s) above?']);
    expect(text()).toContain('cancelled; nothing was changed');
    expect(snapshot(root)).toEqual(before);
  });

  it('without the claude CLI edits ~/.claude.json directly (backup first, other keys kept)', async () => {
    await installEverything();
    d.which = (c) => (c === 'git' ? '/usr/bin/git' : null);
    expect(await runCli(['uninstall', '--yes'], io)).toBe(0);
    expect(d.captures.some((c) => c.cmd.endsWith('claude'))).toBe(false);
    expect(readJson(claudeJson())).toEqual({ numStartups: 3, mcpServers: { other: OTHER }, projects: {} });
    expect(readdirSync(home).some((f) => f.startsWith('.claude.json.bak-'))).toBe(true);
  });

  it('a failed item is marked FAIL with its fix and exits 1; the rest still runs', async () => {
    await installEverything();
    claudeRemoveFails = true;
    expect(await runCli(['uninstall', '--yes'], io)).toBe(1);
    expect(text()).toMatch(/FAIL {2}mcp Claude Code +No user-scoped MCP server named pp/);
    expect(text()).toMatch(/fix: remove "pp" from .+\.claude\.json by hand/);
    expect(out.at(-1)).toBe('uninstall: 1 item(s) failed (fixes above); rerun pp uninstall when done');
    expect(readJson(cursorJson()).mcpServers.pp).toBeUndefined();
  });

  it('an unparseable config is left as is and reported', async () => {
    mkdirSync(join(home, '.cursor'));
    writeFileSync(cursorJson(), '{nope');
    expect(await runCli(['uninstall', '--yes'], io)).toBe(0);
    expect(readFileSync(cursorJson(), 'utf8')).toBe('{nope');
    expect(text()).toContain('not valid JSON, left as is');
    expect(text()).toContain('nothing to remove');
  });

  it('--bin-dir: launchers elsewhere', async () => {
    const other = join(root, 'bin2');
    mkdirSync(other);
    writeFileSync(join(other, 'pp-mcp'), '#!/bin/sh\nexec "/n" "/x/packages/mcp/dist/bin.js" "$@"\n');
    expect(await runCli(['uninstall', '--yes', '--bin-dir', other], io)).toBe(0);
    expect(existsSync(join(other, 'pp-mcp'))).toBe(false);
  });

  it('Linux systemd: disables the timers, deletes the units, reloads', async () => {
    d.platform = 'linux';
    d.which = (c) => (c === 'systemctl' ? '/usr/bin/systemctl' : null);
    expect(await runCli(['schedules', 'install'], io)).toBe(0);
    const unitDir = join(home, '.config', 'systemd', 'user');
    expect(readdirSync(unitDir).length).toBe(6);
    d.captures.length = 0;
    expect(await runCli(['uninstall', '--yes'], io)).toBe(0);
    expect(readdirSync(unitDir)).toEqual([]);
    expect(d.captures.filter((c) => c.args.includes('disable')).map((c) => c.args.at(-1))).toEqual([
      'pp-inbox.timer',
      'pp-freshness.timer',
      'pp-scout-score.timer',
    ]);
    expect(d.captures.some((c) => c.args.includes('daemon-reload'))).toBe(true);
  });

  it('cron: prints the pp lines to remove, never edits the crontab', async () => {
    d.platform = 'linux';
    const line = `30 7 * * * PATH='/usr/bin' PP_HOME='${ppHome}' '/n' '/r/packages/cli/dist/index.js' 'run' 'inbox' '--schedule' '--home' '${ppHome}' >> '/l' 2>&1`;
    d.which = (c) => (c === 'crontab' ? '/usr/bin/crontab' : null);
    d.capture = (cmd, args) => {
      d.captures.push({ cmd, args });
      return { code: 0, stdout: `0 1 * * * backup.sh\n${line}\n`, stderr: '' };
    };
    expect(await runCli(['uninstall', '--yes'], io)).toBe(0);
    expect(text()).toContain('remove these lines yourself with crontab -e');
    expect(text()).toContain(line);
    expect(text()).not.toContain('backup.sh');
    expect(d.captures.map((c) => c.args)).toEqual([['-l']]);
  });
});

describe('pp uninstall --purge', () => {
  function kevCache() {
    const cache = join(home, '.cache', 'huggingface', 'hub');
    const repo = join(cache, 'models--jaredpalmer--kev-0.8b');
    mkdirSync(join(repo, 'blobs'), { recursive: true });
    mkdirSync(join(repo, 'snapshots', 'a'.repeat(40)), { recursive: true });
    writeFileSync(join(repo, 'blobs', 'h1'), 'adapter');
    symlinkSync('../../blobs/h1', join(repo, 'snapshots', 'a'.repeat(40), 'adapter_model.safetensors'));
    const other = join(cache, 'models--someone--else');
    mkdirSync(join(other, 'snapshots'), { recursive: true });
    return { repo, other };
  }

  it('backs up the vault (0600, readable, without kev/repo), deletes it and Kev models; rerun: nothing to remove', async () => {
    await installEverything();
    mkdirSync(join(kevPaths(ppHome).repo, '.venv'), { recursive: true });
    writeFileSync(join(kevPaths(ppHome).repo, '.venv', 'big'), 'x');
    writeFileSync(join(ppHome, 'note.md'), '---\nid: n\ntype: note\n---\n');
    const { repo, other } = kevCache();
    expect(await runCli(['uninstall', '--purge', '--yes'], io)).toBe(0);
    expect(existsSync(ppHome)).toBe(false);
    expect(existsSync(repo)).toBe(false);
    expect(existsSync(other)).toBe(true);
    const dir = join(home, 'perfect-placement-backups');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const [file] = readdirSync(dir);
    expect(file).toBe('vault-2026-10-08T12-00-00-000Z.tar.gz');
    const tgz = join(dir, file as string);
    expect(statSync(tgz).mode & 0o777).toBe(0o600);
    const list = spawnSync('tar', ['-tzf', tgz], { encoding: 'utf8' });
    expect(list.status).toBe(0);
    const names = list.stdout.split('\n');
    expect(names).toContain('vault/pp.db');
    expect(names).toContain('vault/config.json');
    expect(names).toContain('vault/note.md');
    expect(names).toContain('vault/kev/installed.json');
    expect(names.some((n) => n.startsWith('vault/kev/repo'))).toBe(false);
    expect(text()).toMatch(/ok {4}backup +.+vault-.+\.tar\.gz \(\d+ files, .+\); restore: tar -xzf /);
    expect(text()).toMatch(/ok {4}vault +deleted /);
    expect(text()).toMatch(/ok {4}kev models +1 model dir/);
    expect(out.at(-1)).toBe('uninstall: done');

    out.length = 0;
    expect(await runCli(['uninstall', '--purge', '--yes'], io)).toBe(0);
    expect(text()).toContain('nothing to remove');
    expect(readdirSync(dir).length).toBe(1);
  });

  it('--no-backup skips the backup', async () => {
    expect(await runCli(['uninstall', '--purge', '--no-backup', '--yes'], io)).toBe(0);
    expect(existsSync(ppHome)).toBe(false);
    expect(existsSync(join(home, 'perfect-placement-backups'))).toBe(false);
  });

  it('a failed backup keeps the vault and exits 1', async () => {
    writeFileSync(join(home, 'perfect-placement-backups'), 'a file, not a dir');
    expect(await runCli(['uninstall', '--purge', '--yes'], io)).toBe(1);
    expect(existsSync(join(ppHome, 'pp.db'))).toBe(true);
    expect(text()).toMatch(/FAIL {2}backup/);
    expect(text()).toMatch(/FAIL {2}vault +not deleted: the backup failed/);
  });

  it('--dry-run changes nothing', async () => {
    await installEverything();
    kevCache();
    const before = snapshot(root);
    expect(await runCli(['uninstall', '--purge', '--dry-run'], io)).toBe(0);
    expect(snapshot(root)).toEqual(before);
    expect(text()).toContain('models--jaredpalmer--kev-0.8b');
    expect(text()).toContain(join(home, 'perfect-placement-backups'));
  });

  it('refuses a dir that does not look like a vault, or one inside a git repo, unless --force; changes nothing', async () => {
    await installEverything();
    const notVault = join(root, 'stuff');
    mkdirSync(notVault);
    writeFileSync(join(notVault, 'thesis.txt'), 'precious');
    let before = snapshot(root);
    expect(await runCli(['uninstall', '--purge', '--yes', '--home', notVault], io)).toBe(1);
    expect(err.join('\n')).toMatch(/refusing to purge: .+ does not look like a pp vault .+Nothing was changed/);
    expect(snapshot(root)).toEqual(before);

    const repoVault = join(root, 'proj', 'vault');
    mkdirSync(join(root, 'proj', '.git'), { recursive: true });
    mkdirSync(repoVault);
    writeFileSync(join(repoVault, 'pp.db'), '');
    writeFileSync(join(repoVault, 'config.json'), '{}');
    before = snapshot(root);
    err.length = 0;
    expect(await runCli(['uninstall', '--purge', '--yes', '--home', repoVault], io)).toBe(1);
    expect(err.join('\n')).toContain('is inside the git repo');
    expect(snapshot(root)).toEqual(before);

    expect(await runCli(['uninstall', '--purge', '--yes', '--no-backup', '--force', '--home', notVault], io)).toBe(0);
    expect(existsSync(notVault)).toBe(false);
  });

  it('never purges HOME or a parent of it, even with --force', async () => {
    expect(await runCli(['uninstall', '--purge', '--yes', '--force', '--home', home], io)).toBe(1);
    expect(await runCli(['uninstall', '--purge', '--yes', '--force', '--home', root], io)).toBe(1);
    expect(err.join('\n')).toContain('your home directory or one of its parents');
    expect(existsSync(join(ppHome, 'pp.db'))).toBe(true);
  });

  it('refuses while pp up answers', async () => {
    d.fetch = (async (url: string | URL) =>
      String(url).endsWith('/api/health') ? new Response('{}', { status: 200 }) : Promise.reject(new Error('down'))) as typeof fetch;
    expect(await runCli(['uninstall', '--purge', '--yes'], io)).toBe(1);
    expect(err.join('\n')).toContain('pp up is running');
    expect(existsSync(join(ppHome, 'pp.db'))).toBe(true);
  });
});

describe('uninstall.sh', () => {
  const SCRIPT = fileURLToPath(new URL('../../../../uninstall.sh', import.meta.url));
  const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

  it('parses (sh -n) and prints its help', () => {
    expect(spawnSync('sh', ['-n', SCRIPT]).status).toBe(0);
    const r = spawnSync('sh', [SCRIPT, '--help'], { encoding: 'utf8' });
    expect(r.stdout).toContain('./uninstall.sh --purge');
  });

  it.skipIf(!existsSync(CLI))('--dry-run on a temp HOME runs pp uninstall with this node and changes nothing', () => {
    const before = snapshot(root);
    const r = spawnSync('sh', [SCRIPT, '--dry-run', '--purge', '--force'], {
      encoding: 'utf8',
      env: { HOME: home, PATH: '/usr/bin:/bin', PP_NODE: process.execPath, PP_HOME: ppHome, PP_NODE_KEGS: '' },
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`pp uninstall --purge: setup reset + vault ${ppHome}`);
    expect(r.stdout).toContain('Dry run: nothing was changed.');
    expect(snapshot(root)).toEqual(before);
  });
});
