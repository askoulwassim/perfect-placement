/*
 * Register the stdio `pp-mcp` server with agent clients (Claude Code, Codex, Cursor, Claude Desktop).
 * Rules: only the `pp` entry is touched, other servers are kept; a file is backed up
 * (`<file>.bak-<timestamp>`) before it is changed; an identical entry is left alone (idempotent);
 * unparseable files are refused, never overwritten. Formats: packages/mcp/README.md "Client config".
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { ops } from '@perfect-placement/engine';
import type { SystemDeps } from './deps.js';

export const CLIENT_IDS = ['claude-code', 'codex', 'cursor', 'claude-desktop'] as const;
export type ClientId = (typeof CLIENT_IDS)[number];
export const CLIENT_LABEL: Record<ClientId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  'claude-desktop': 'Claude Desktop',
};
export const SERVER_KEY = 'pp';

export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ClientChange {
  client: ClientId;
  status: 'added' | 'updated' | 'unchanged' | 'failed';
  /** File or command that changed. */
  target: string;
  backup?: string;
  detail?: string;
}

/** Absolute path of the built `pp-mcp` bin (packages/mcp/dist/bin.js). */
export function ppMcpBin(): string {
  return join(dirname(createRequire(import.meta.url).resolve('@perfect-placement/mcp')), 'bin.js');
}

/** Absolute node + absolute bin + PP_HOME: GUI clients do not inherit your shell PATH. */
export const mcpSpec = (ppHome: string, nodePath: string, bin = ppMcpBin()): McpServerSpec => ({
  command: nodePath,
  args: [bin],
  env: { PP_HOME: ppHome },
});

export function claudeDesktopConfigPath(d: Pick<SystemDeps, 'platform' | 'home' | 'env'>): string | null {
  if (d.platform === 'darwin') return join(d.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (d.platform === 'win32' && d.env.APPDATA) return join(d.env.APPDATA, 'Claude', 'claude_desktop_config.json');
  return null; // Claude Desktop documents macOS and Windows only
}
export const cursorConfigPath = (d: Pick<SystemDeps, 'home'>) => join(d.home, '.cursor', 'mcp.json');
export const codexConfigPath = (d: Pick<SystemDeps, 'home' | 'env'>) => join(d.env.CODEX_HOME || join(d.home, '.codex'), 'config.toml');

/** Which clients are installed on this machine. */
export function detectClients(d: SystemDeps): Record<ClientId, boolean> {
  const desktop = claudeDesktopConfigPath(d);
  return {
    'claude-code': d.which('claude') !== null,
    codex: d.which('codex') !== null || existsSync(dirname(codexConfigPath(d))),
    cursor:
      d.which('cursor') !== null ||
      existsSync(join(d.home, '.cursor')) ||
      (d.platform === 'darwin' && existsSync(join(d.appsDir, 'Cursor.app'))),
    'claude-desktop':
      desktop !== null && (existsSync(dirname(desktop)) || (d.platform === 'darwin' && existsSync(join(d.appsDir, 'Claude.app')))),
  };
}

export const stamp = (d: Pick<SystemDeps, 'now'>) => d.now().toISOString().replace(/[:.]/g, '-');

/** Copy `file` to `<file>.bak-<timestamp>` (if it exists). */
export function backup(file: string, d: Pick<SystemDeps, 'now'>): string | undefined {
  if (!existsSync(file)) return undefined;
  const to = `${file}.bak-${stamp(d)}`;
  copyFileSync(file, to);
  return to;
}

function writeWithBackup(file: string, text: string, d: Pick<SystemDeps, 'now'>): string | undefined {
  const bak = backup(file, d);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return bak;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Cursor and Claude Desktop: `{ "mcpServers": { "pp": { command, args, env } } }`. */
export function registerJsonClient(client: ClientId, file: string, spec: McpServerSpec, d: Pick<SystemDeps, 'now'>): ClientChange {
  let doc: Record<string, unknown> = {};
  if (existsSync(file)) {
    const raw = readFileSync(file, 'utf8');
    if (raw.trim()) {
      try {
        doc = JSON.parse(raw) as Record<string, unknown>;
      } catch (e) {
        return { client, status: 'failed', target: file, detail: `not valid JSON, left as is (${(e as Error).message})` };
      }
      if (typeof doc !== 'object' || doc === null || Array.isArray(doc))
        return { client, status: 'failed', target: file, detail: 'not a JSON object, left as is' };
    }
  }
  const servers = doc.mcpServers;
  if (servers !== undefined && (typeof servers !== 'object' || servers === null || Array.isArray(servers)))
    return { client, status: 'failed', target: file, detail: '"mcpServers" is not an object, left as is' };
  const current = (servers as Record<string, unknown> | undefined)?.[SERVER_KEY];
  const entry = { command: spec.command, args: spec.args, env: spec.env };
  if (current !== undefined && sameJson(current, entry)) return { client, status: 'unchanged', target: file };
  const next = { ...doc, mcpServers: { ...((servers as Record<string, unknown>) ?? {}), [SERVER_KEY]: entry } };
  const bak = writeWithBackup(file, `${JSON.stringify(next, null, 2)}\n`, d);
  return { client, status: current === undefined ? 'added' : 'updated', target: file, ...(bak ? { backup: bak } : {}) };
}

const tomlStr = (s: string) => JSON.stringify(s); // a JSON string is a valid TOML basic string
const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlStr(k));

export function renderCodexBlock(spec: McpServerSpec): string {
  const env = Object.entries(spec.env)
    .map(([k, v]) => `${tomlKey(k)} = ${tomlStr(v)}`)
    .join(', ');
  return [
    `[mcp_servers.${SERVER_KEY}]`,
    `command = ${tomlStr(spec.command)}`,
    `args = [${spec.args.map(tomlStr).join(', ')}]`,
    `env = { ${env} }`,
  ].join('\n');
}

const HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;
const isPpTable = (name: string) => {
  const n = name.replace(/\s+/g, '').replace(/"pp"/g, 'pp').replace(/'pp'/g, 'pp');
  return n === `mcp_servers.${SERVER_KEY}` || n.startsWith(`mcp_servers.${SERVER_KEY}.`);
};

/** Replace the `[mcp_servers.pp]` table (and its sub-tables) in place, or append it. Everything else is kept byte for byte. */
export function upsertCodexToml(text: string, block: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let skipping = false;
  let inserted = false;
  for (const line of lines) {
    const h = HEADER.exec(line);
    if (h) {
      if (isPpTable(h[1] as string)) {
        if (!inserted) {
          out.push(...block.split('\n'));
          inserted = true;
        }
        skipping = true;
        continue;
      }
      if (skipping) out.push('');
      skipping = false;
    }
    if (!skipping) out.push(line);
  }
  if (inserted) {
    let s = out.join('\n');
    if (!s.endsWith('\n')) s += '\n';
    return s;
  }
  const base = text.replace(/\s+$/, '');
  return `${base ? `${base}\n\n` : ''}${block}\n`;
}

/** Codex: `[mcp_servers.pp]` in ~/.codex/config.toml (or $CODEX_HOME/config.toml). */
export function registerCodex(file: string, spec: McpServerSpec, d: Pick<SystemDeps, 'now'>): ClientChange {
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const had = before.split('\n').some((l) => {
    const h = HEADER.exec(l);
    return h ? isPpTable(h[1] as string) : false;
  });
  const after = upsertCodexToml(before, renderCodexBlock(spec));
  if (after === before) return { client: 'codex', status: 'unchanged', target: file };
  const bak = writeWithBackup(file, after, d);
  return { client: 'codex', status: had ? 'updated' : 'added', target: file, ...(bak ? { backup: bak } : {}) };
}

/** `claude mcp add --scope user pp -e PP_HOME=<home> -- <node> <pp-mcp>` (the args after `--` are the server command). */
export const claudeAddArgs = (spec: McpServerSpec) => [
  'mcp',
  'add',
  '--scope',
  'user',
  SERVER_KEY,
  ...Object.entries(spec.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
  '--',
  spec.command,
  ...spec.args,
];

/** Claude Code through its own CLI (user scope). ~/.claude.json is backed up before a change. */
export function registerClaudeCode(spec: McpServerSpec, d: SystemDeps): ClientChange {
  const claude = d.which('claude');
  if (!claude) return { client: 'claude-code', status: 'failed', target: 'claude', detail: '`claude` is not on PATH' };
  const got = d.capture(claude, ['mcp', 'get', SERVER_KEY]);
  const text = `${got.stdout}\n${got.stderr}`;
  const exists = got.code === 0 && !/No MCP server named/i.test(text);
  const wanted = [spec.command, ...spec.args, ...Object.entries(spec.env).map(([k, v]) => `${k}=${v}`)];
  if (exists && wanted.every((w) => text.includes(w)) && /user/i.test(text))
    return { client: 'claude-code', status: 'unchanged', target: `${claude} mcp get ${SERVER_KEY}` };
  const bak = backup(join(d.home, '.claude.json'), d);
  if (exists) {
    const rm = d.capture(claude, ['mcp', 'remove', SERVER_KEY, '--scope', 'user']);
    if (rm.code !== 0)
      return {
        client: 'claude-code',
        status: 'failed',
        target: `claude mcp remove ${SERVER_KEY} --scope user`,
        detail: `a "${SERVER_KEY}" server exists outside user scope; remove it with \`claude mcp remove ${SERVER_KEY}\` and rerun`,
        ...(bak ? { backup: bak } : {}),
      };
  }
  const args = claudeAddArgs(spec);
  const add = d.capture(claude, args);
  const cmd = `claude ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
  if (add.code !== 0)
    return {
      client: 'claude-code',
      status: 'failed',
      target: cmd,
      detail: (add.stderr || add.stdout).trim(),
      ...(bak ? { backup: bak } : {}),
    };
  return { client: 'claude-code', status: exists ? 'updated' : 'added', target: cmd, ...(bak ? { backup: bak } : {}) };
}

export function registerClient(client: ClientId, spec: McpServerSpec, d: SystemDeps): ClientChange {
  switch (client) {
    case 'claude-code':
      return registerClaudeCode(spec, d);
    case 'codex':
      return registerCodex(codexConfigPath(d), spec, d);
    case 'cursor':
      return registerJsonClient('cursor', cursorConfigPath(d), spec, d);
    case 'claude-desktop': {
      const file = claudeDesktopConfigPath(d);
      if (!file)
        return {
          client,
          status: 'failed',
          target: 'claude-desktop',
          detail: 'Claude Desktop config path is documented for macOS and Windows only',
        };
      return registerJsonClient('claude-desktop', file, spec, d);
    }
  }
}

/** The `pp` entry's command as registered in one client's config (read only; never runs the client). */
export interface RegisteredNode {
  client: ClientId;
  file: string;
  command: string;
}

function readJsonCommand(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, { command?: unknown }> };
    const c = doc?.mcpServers?.[SERVER_KEY]?.command;
    return typeof c === 'string' ? c : null;
  } catch {
    return null;
  }
}

function readCodexCommand(file: string): string | null {
  if (!existsSync(file)) return null;
  let inPp = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const h = HEADER.exec(line);
    if (h) {
      inPp = (h[1] as string).replace(/\s+/g, '').replace(/"pp"|'pp'/g, 'pp') === `mcp_servers.${SERVER_KEY}`;
      continue;
    }
    const m = inPp ? /^\s*command\s*=\s*("(?:[^"\\]|\\.)*")\s*(#.*)?$/.exec(line) : null;
    if (m) {
      try {
        return JSON.parse(m[1] as string) as string;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Every agent config that registers the `pp` server, with the node it points at. Claude Code: `~/.claude.json` user scope. */
export function registeredNodes(d: Pick<SystemDeps, 'platform' | 'home' | 'env'>): RegisteredNode[] {
  const found: RegisteredNode[] = [];
  const json = (client: ClientId, file: string | null) => {
    const command = file ? readJsonCommand(file) : null;
    if (file && command) found.push({ client, file, command });
  };
  json('claude-code', join(d.home, '.claude.json'));
  const codex = codexConfigPath(d);
  const codexCmd = readCodexCommand(codex);
  if (codexCmd) found.push({ client: 'codex', file: codex, command: codexCmd });
  json('cursor', cursorConfigPath(d));
  json('claude-desktop', claudeDesktopConfigPath(d));
  return found;
}

/** Why a node path will not (or soon will not) start: missing, or inside a versioned Homebrew keg. Null when fine. */
export function nodePathProblem(command: string, exists: (p: string) => boolean = existsSync): string | null {
  if (!exists(command)) return `${command} no longer exists`;
  if (ops.CELLAR_NODE.test(command)) return `${command} is a versioned Homebrew path (breaks on brew upgrade)`;
  return null;
}

/**
 * `pp doctor` machine checks (#33): the runner's node and each registered agent's node must exist and
 * not sit in a versioned Homebrew folder. The fix for either is rerunning `./install.sh` and `pp setup`.
 */
export function nodePathChecks(
  ppHome: string,
  d: Pick<SystemDeps, 'platform' | 'home' | 'env'>,
  exists: (p: string) => boolean = existsSync,
): { name: string; ok: boolean; detail?: string }[] {
  const runner = ops.defaultMcpServer(ppHome, ops.stableNodePath(d.env, process.execPath, exists)).command;
  const runnerProblem = nodePathProblem(runner, exists);
  const registered = registeredNodes(d);
  const bad = registered.flatMap((r) => {
    const p = nodePathProblem(r.command, exists);
    return p ? [`${CLIENT_LABEL[r.client]} (${r.file}): ${p}`] : [];
  });
  return [
    runnerProblem
      ? { name: 'runner_node', ok: false, detail: `${runnerProblem}; rerun ./install.sh` }
      : { name: 'runner_node', ok: true, detail: runner },
    bad.length
      ? { name: 'mcp_node', ok: false, detail: `${bad.join('; ')}; rerun pp setup` }
      : { name: 'mcp_node', ok: true, detail: `${registered.length} agent config${registered.length === 1 ? '' : 's'}` },
  ];
}

/*
 * Uninstall (`pp uninstall`): the reverse of registration. Same rules: only the `pp` entry goes, other
 * servers and keys are kept, the file is backed up first, a file without `pp` is never written,
 * an unparseable file is left as is. Detection is read only.
 */

export interface ClientRemoval {
  client: ClientId;
  status: 'removed' | 'absent' | 'failed';
  target: string;
  backup?: string;
  detail?: string;
}

/** Write `text` next to `file` and rename it over, keeping the file's mode. */
function replaceFile(file: string, text: string): void {
  const tmp = `${file}.pp-tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: statSync(file).mode & 0o777 });
  renameSync(tmp, file);
}

type JsonDoc = { ok: true; doc: Record<string, unknown> | null } | { ok: false; detail: string };

function readJsonDoc(file: string): JsonDoc {
  if (!existsSync(file)) return { ok: true, doc: null };
  const raw = readFileSync(file, 'utf8');
  if (!raw.trim()) return { ok: true, doc: null };
  try {
    const doc = JSON.parse(raw) as unknown;
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { ok: false, detail: 'not a JSON object, left as is' };
    return { ok: true, doc: doc as Record<string, unknown> };
  } catch (e) {
    return { ok: false, detail: `not valid JSON, left as is (${(e as Error).message})` };
  }
}

const serversOf = (doc: Record<string, unknown> | null) => {
  const s = doc?.mcpServers;
  return typeof s === 'object' && s !== null && !Array.isArray(s) ? (s as Record<string, unknown>) : null;
};

/** Does this `{ mcpServers }` JSON file hold a `pp` entry? (`~/.claude.json` user scope, Cursor, Claude Desktop.) */
export function jsonHasPp(file: string): { has: boolean; detail?: string } {
  const r = readJsonDoc(file);
  if (!r.ok) return { has: false, detail: r.detail };
  return { has: serversOf(r.doc)?.[SERVER_KEY] !== undefined };
}

/** Remove `mcpServers.pp` from a JSON config, keeping every other key (backup first). */
export function unregisterJsonClient(client: ClientId, file: string, d: Pick<SystemDeps, 'now'>): ClientRemoval {
  const r = readJsonDoc(file);
  if (!r.ok) return { client, status: 'failed', target: file, detail: r.detail };
  const servers = serversOf(r.doc);
  if (!r.doc || !servers || servers[SERVER_KEY] === undefined) return { client, status: 'absent', target: file };
  const { [SERVER_KEY]: _gone, ...rest } = servers;
  const bak = backup(file, d);
  replaceFile(file, `${JSON.stringify({ ...r.doc, mcpServers: rest }, null, 2)}\n`);
  return { client, status: 'removed', target: file, ...(bak ? { backup: bak } : {}) };
}

/** Header-less dotted forms of the pp table: `mcp_servers.pp = {...}` / `mcp_servers.pp.x = ..` at the root, `pp = {...}` in [mcp_servers]. */
const ROOT_DOTTED = /^\s*mcp_servers\s*\.\s*(pp|"pp"|'pp')\s*[.=]/;
const IN_SERVERS_DOTTED = /^\s*(pp|"pp"|'pp')\s*[.=]/;
const isServersTable = (name: string) => name.replace(/\s+/g, '') === 'mcp_servers';

/** Codex config.toml without the `[mcp_servers.pp]` table (and its sub-tables / one-line dotted forms). Everything else byte for byte. */
export function removeCodexToml(text: string): string {
  const out: string[] = [];
  let skipping = false;
  let table: string | null = null;
  let removed = false;
  for (const line of text.split('\n')) {
    const h = HEADER.exec(line);
    if (h) {
      table = h[1] as string;
      if (isPpTable(table)) {
        // Drop the blank lines that separated the removed table from what came before.
        while (out.length && (out.at(-1) as string).trim() === '') out.pop();
        skipping = true;
        removed = true;
        continue;
      }
      if (skipping && out.length) out.push('');
      skipping = false;
    }
    if (skipping) continue;
    if (!h && ((table === null && ROOT_DOTTED.test(line)) || (table !== null && isServersTable(table) && IN_SERVERS_DOTTED.test(line)))) {
      removed = true;
      continue;
    }
    out.push(line);
  }
  if (!removed) return text;
  const s = out.join('\n').replace(/\n+$/, '');
  return s ? `${s}\n` : '';
}

export function codexHasPp(file: string): boolean {
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  return removeCodexToml(text) !== text;
}

export function unregisterCodex(file: string, d: Pick<SystemDeps, 'now'>): ClientRemoval {
  if (!existsSync(file)) return { client: 'codex', status: 'absent', target: file };
  const before = readFileSync(file, 'utf8');
  const after = removeCodexToml(before);
  if (after === before) return { client: 'codex', status: 'absent', target: file };
  const bak = backup(file, d);
  replaceFile(file, after);
  return { client: 'codex', status: 'removed', target: file, ...(bak ? { backup: bak } : {}) };
}

export const claudeJsonPath = (d: Pick<SystemDeps, 'home'>) => join(d.home, '.claude.json');
export const claudeRemoveArgs = ['mcp', 'remove', '--scope', 'user', SERVER_KEY];

/**
 * Claude Code: `claude mcp remove --scope user pp` when `claude` is on PATH (it owns ~/.claude.json),
 * else the `mcpServers.pp` key is removed from ~/.claude.json directly. Backed up first either way.
 */
export function unregisterClaudeCode(d: SystemDeps): ClientRemoval {
  const file = claudeJsonPath(d);
  const found = jsonHasPp(file);
  if (!found.has)
    return found.detail
      ? { client: 'claude-code', status: 'failed', target: file, detail: found.detail }
      : { client: 'claude-code', status: 'absent', target: file };
  const claude = d.which('claude');
  if (!claude) return unregisterJsonClient('claude-code', file, d);
  const bak = backup(file, d);
  const cmd = `claude ${claudeRemoveArgs.join(' ')}`;
  const r = d.capture(claude, claudeRemoveArgs);
  if (r.code !== 0)
    return {
      client: 'claude-code',
      status: 'failed',
      target: cmd,
      detail: (r.stderr || r.stdout).trim() || `exit ${r.code}`,
      ...(bak ? { backup: bak } : {}),
    };
  return { client: 'claude-code', status: 'removed', target: cmd, ...(bak ? { backup: bak } : {}) };
}

/** Where each client keeps the pp entry, and whether it is there now (read only). */
export function clientPpState(client: ClientId, d: SystemDeps): { file: string | null; has: boolean; detail?: string } {
  switch (client) {
    case 'claude-code': {
      const file = claudeJsonPath(d);
      return { file, ...jsonHasPp(file) };
    }
    case 'codex': {
      const file = codexConfigPath(d);
      return { file, has: codexHasPp(file) };
    }
    case 'cursor': {
      const file = cursorConfigPath(d);
      return { file, ...jsonHasPp(file) };
    }
    case 'claude-desktop': {
      const file = claudeDesktopConfigPath(d);
      return file ? { file, ...jsonHasPp(file) } : { file: null, has: false };
    }
  }
}

export function unregisterClient(client: ClientId, d: SystemDeps): ClientRemoval {
  switch (client) {
    case 'claude-code':
      return unregisterClaudeCode(d);
    case 'codex':
      return unregisterCodex(codexConfigPath(d), d);
    case 'cursor':
      return unregisterJsonClient('cursor', cursorConfigPath(d), d);
    case 'claude-desktop': {
      const file = claudeDesktopConfigPath(d);
      return file ? unregisterJsonClient('claude-desktop', file, d) : { client, status: 'absent', target: 'claude-desktop' };
    }
  }
}
