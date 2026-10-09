import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeAddArgs,
  claudeDesktopConfigPath,
  codexConfigPath,
  cursorConfigPath,
  detectClients,
  mcpSpec,
  nodePathChecks,
  nodePathProblem,
  registerClaudeCode,
  registerCodex,
  registeredNodes,
  registerJsonClient,
  renderCodexBlock,
  upsertCodexToml,
} from './clients.js';
import { stableNodePath } from './deps.js';
import { fakeDeps } from './fake-deps.test-helpers.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pp-home-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const spec = mcpSpec('/vault', '/opt/node22/bin/node', '/repo/packages/mcp/dist/bin.js');
const backups = (file: string) => readdirSync(dirname(file)).filter((f) => f.includes('.bak-'));

describe('JSON clients (Cursor, Claude Desktop)', () => {
  it('creates the file, then is idempotent', () => {
    const d = fakeDeps(home);
    const file = cursorConfigPath(d);
    expect(registerJsonClient('cursor', file, spec, d)).toMatchObject({ status: 'added', target: file });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      mcpServers: { pp: { command: '/opt/node22/bin/node', args: ['/repo/packages/mcp/dist/bin.js'], env: { PP_HOME: '/vault' } } },
    });
    expect(registerJsonClient('cursor', file, spec, d)).toMatchObject({ status: 'unchanged' });
    expect(backups(file)).toEqual([]);
  });

  it('keeps other servers and keys, backs up before changing, updates a stale pp entry', () => {
    const d = fakeDeps(home);
    const file = claudeDesktopConfigPath(d) as string;
    expect(file).toBe(join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
    mkdirSync(dirname(file), { recursive: true });
    const original = { theme: 'dark', mcpServers: { other: { command: 'x' }, pp: { command: 'old' } } };
    writeFileSync(file, JSON.stringify(original));
    const change = registerJsonClient('claude-desktop', file, spec, d);
    expect(change.status).toBe('updated');
    expect(change.backup).toBe(`${file}.bak-2026-10-08T12-00-00-000Z`);
    expect(JSON.parse(readFileSync(change.backup as string, 'utf8'))).toEqual(original);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after.theme).toBe('dark');
    expect(after.mcpServers.other).toEqual({ command: 'x' });
    expect(after.mcpServers.pp.env).toEqual({ PP_HOME: '/vault' });
  });

  it('refuses a file that is not valid JSON (never clobbers)', () => {
    const d = fakeDeps(home);
    const file = cursorConfigPath(d);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ nope');
    expect(registerJsonClient('cursor', file, spec, d).status).toBe('failed');
    expect(readFileSync(file, 'utf8')).toBe('{ nope');
    expect(backups(file)).toEqual([]);
  });

  it('Claude Desktop paths: macOS, Windows; none documented for Linux', () => {
    expect(claudeDesktopConfigPath({ platform: 'win32', home: 'C:/Users/x', env: { APPDATA: 'C:/Users/x/AppData/Roaming' } })).toBe(
      join('C:/Users/x/AppData/Roaming', 'Claude', 'claude_desktop_config.json'),
    );
    expect(claudeDesktopConfigPath({ platform: 'linux', home: '/home/x', env: {} })).toBeNull();
  });
});

describe('Codex (~/.codex/config.toml)', () => {
  it('appends [mcp_servers.pp], keeps everything else, is idempotent', () => {
    const d = fakeDeps(home);
    const file = codexConfigPath(d);
    mkdirSync(dirname(file), { recursive: true });
    const before = 'model = "o5"\n\n[mcp_servers.other]\ncommand = "x"\n';
    writeFileSync(file, before);
    const c = registerCodex(file, spec, d);
    expect(c.status).toBe('added');
    expect(c.backup).toBeDefined();
    const text = readFileSync(file, 'utf8');
    expect(text).toBe(
      `${before}\n[mcp_servers.pp]\ncommand = "/opt/node22/bin/node"\nargs = ["/repo/packages/mcp/dist/bin.js"]\nenv = { PP_HOME = "/vault" }\n`,
    );
    expect(registerCodex(file, spec, d).status).toBe('unchanged');
    expect(backups(file)).toHaveLength(1);
  });

  it('replaces a stale pp table and its sub-tables in place', () => {
    const before = [
      'model = "o5"',
      '',
      '[mcp_servers.pp]',
      'command = "old"',
      '',
      '[mcp_servers.pp.env]',
      'PP_HOME = "/old"',
      '',
      '[mcp_servers.other]',
      'command = "x"',
      '',
    ].join('\n');
    const block = '[mcp_servers.pp]\ncommand = "new"';
    const after = upsertCodexToml(before, block);
    expect(after).toBe('model = "o5"\n\n[mcp_servers.pp]\ncommand = "new"\n\n[mcp_servers.other]\ncommand = "x"\n');
    expect(upsertCodexToml(after, block)).toBe(after);
    expect(upsertCodexToml('', block)).toBe(`${block}\n`);
  });
});

describe('Claude Code (claude mcp add --scope user)', () => {
  it('adds through the claude CLI with the absolute paths and PP_HOME, backing up ~/.claude.json', () => {
    const d = fakeDeps(home, { bins: ['claude'] });
    writeFileSync(join(home, '.claude.json'), '{}');
    d.capture = (cmd, args) => {
      d.captures.push({ cmd, args });
      return args[1] === 'get' ? { code: 1, stdout: '', stderr: 'No MCP server named "pp" found' } : { code: 0, stdout: '', stderr: '' };
    };
    const c = registerClaudeCode(spec, d);
    expect(c.status).toBe('added');
    expect(d.captures.at(-1)?.args).toEqual(claudeAddArgs(spec));
    expect(claudeAddArgs(spec)).toEqual([
      'mcp',
      'add',
      '--scope',
      'user',
      'pp',
      '-e',
      'PP_HOME=/vault',
      '--',
      '/opt/node22/bin/node',
      '/repo/packages/mcp/dist/bin.js',
    ]);
    expect(c.backup && existsSync(c.backup)).toBe(true);
  });

  it('leaves a matching registration alone and replaces a stale one', () => {
    const d = fakeDeps(home, { bins: ['claude'] });
    let current =
      'pp:\n  Scope: User config\n  Command: /opt/node22/bin/node\n  Args: /repo/packages/mcp/dist/bin.js\n  Environment:\n    PP_HOME=/vault\n';
    d.capture = (cmd, args) => {
      d.captures.push({ cmd, args });
      return { code: 0, stdout: args[1] === 'get' ? current : '', stderr: '' };
    };
    expect(registerClaudeCode(spec, d).status).toBe('unchanged');
    expect(d.captures).toHaveLength(1);
    current = current.replace('/vault', '/elsewhere');
    expect(registerClaudeCode(spec, d).status).toBe('updated');
    expect(d.captures.map((c) => c.args[1])).toEqual(['get', 'get', 'remove', 'add']);
  });
});

describe('detectClients', () => {
  it('finds clients by binary or config dir only', () => {
    const d = fakeDeps(home, { bins: ['claude'] });
    expect(detectClients(d)).toEqual({ 'claude-code': true, codex: false, cursor: false, 'claude-desktop': false });
    mkdirSync(join(home, '.codex'));
    mkdirSync(join(home, '.cursor'));
    mkdirSync(join(home, 'Applications', 'Claude.app'), { recursive: true });
    expect(detectClients(d)).toEqual({ 'claude-code': true, codex: true, cursor: true, 'claude-desktop': true });
  });
});

describe('stableNodePath', () => {
  it('prefers PP_NODE, then maps a Homebrew Cellar node to its opt link', () => {
    const has = (p: string) => p === '/opt/homebrew/opt/node@22/bin/node' || p === '/x/node';
    expect(stableNodePath({ PP_NODE: '/x/node' }, '/usr/bin/node', has)).toBe('/x/node');
    expect(stableNodePath({}, '/opt/homebrew/Cellar/node@22/22.23.3_1/bin/node', has)).toBe('/opt/homebrew/opt/node@22/bin/node');
    expect(stableNodePath({}, '/usr/local/bin/node', has)).toBe('/usr/local/bin/node');
  });
});

describe('node paths in agent configs (#33)', () => {
  const cellar = '/opt/homebrew/Cellar/node@22/22.23.3_1/bin/node';
  const opt = '/opt/homebrew/opt/node@22/bin/node';

  it('setup writes the stable opt path, never a Cellar one', () => {
    const d = fakeDeps(home, { nodePath: stableNodePath({}, cellar, (p) => p === opt) });
    const spec = mcpSpec('/v', d.nodePath, '/x/bin.js');
    registerJsonClient('cursor', cursorConfigPath(d), spec, d);
    registerCodex(codexConfigPath(d), spec, d);
    expect(readFileSync(cursorConfigPath(d), 'utf8')).not.toContain('/Cellar/');
    expect(readFileSync(codexConfigPath(d), 'utf8')).not.toContain('/Cellar/');
    expect(claudeAddArgs(spec).join(' ')).not.toContain('/Cellar/');
  });

  it('reads the registered node from every client config', () => {
    const d = fakeDeps(home);
    const spec = mcpSpec('/v', '/n/node', '/x/bin.js');
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { pp: { command: '/c/node' } } }));
    mkdirSync(join(home, '.codex'));
    writeFileSync(codexConfigPath(d), `[other]\ncommand = "/no"\n\n${renderCodexBlock(spec)}\n`);
    registerJsonClient('cursor', cursorConfigPath(d), spec, d);
    expect(registeredNodes(d).map((r) => [r.client, r.command])).toEqual([
      ['claude-code', '/c/node'],
      ['codex', '/n/node'],
      ['cursor', '/n/node'],
    ]);
  });

  it('flags a missing node and a versioned Homebrew node', () => {
    expect(nodePathProblem('/gone/node', () => false)).toMatch(/no longer exists/);
    expect(nodePathProblem(cellar, () => true)).toMatch(/versioned Homebrew/);
    expect(nodePathProblem(opt, () => true)).toBeNull();
  });

  it('doctor checks: green on stable paths, failing with the fix after a node upgrade', () => {
    const d = fakeDeps(home, { env: { PP_NODE: opt } });
    registerJsonClient('cursor', cursorConfigPath(d), mcpSpec('/v', cellar, '/x/bin.js'), d);
    const before = nodePathChecks('/v', d, (p) => p === opt || p === cellar);
    expect(before.find((c) => c.name === 'runner_node')).toEqual({ name: 'runner_node', ok: true, detail: opt });
    expect(before.find((c) => c.name === 'mcp_node')?.ok).toBe(false);
    // brew upgrade: the Cellar folder is gone
    const after = nodePathChecks('/v', d, (p) => p === opt);
    expect(after.find((c) => c.name === 'mcp_node')?.detail).toMatch(/no longer exists; rerun pp setup/);
    registerJsonClient('cursor', cursorConfigPath(d), mcpSpec('/v', opt, '/x/bin.js'), d);
    expect(nodePathChecks('/v', d, (p) => p === opt).every((c) => c.ok)).toBe(true);
  });
});
