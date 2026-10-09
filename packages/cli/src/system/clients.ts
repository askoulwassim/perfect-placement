/*
 * Register the stdio `pp-mcp` server with agent clients (Claude Code, Codex, Cursor, Claude Desktop).
 * Rules: only the `pp` entry is touched, other servers are kept; a file is backed up
 * (`<file>.bak-<timestamp>`) before it is changed; an identical entry is left alone (idempotent);
 * unparseable files are refused, never overwritten. Formats: packages/mcp/README.md "Client config".
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
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

const stamp = (d: Pick<SystemDeps, 'now'>) => d.now().toISOString().replace(/[:.]/g, '-');

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
