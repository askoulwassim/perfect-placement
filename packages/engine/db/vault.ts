import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  CONFIG_FILE,
  DB_FILE,
  DEFAULT_CONFIG,
  type Frontmatter,
  PolicyConfig,
  PP_HOME_DEFAULT,
  PP_HOME_ENV,
  VAULT_DIRS,
} from '@perfect-placement/contracts';

/** Resolve PP_HOME: explicit arg, then $PP_HOME, then ~/.perfect-placement. `~` is expanded. */
export function resolvePpHome(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = explicit || env[PP_HOME_ENV] || PP_HOME_DEFAULT;
  const expanded = raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
  return resolve(expanded);
}

export const dbPath = (home: string): string => join(home, DB_FILE);
export const configPath = (home: string): string => join(home, CONFIG_FILE);

/** Absolute path for a vault-relative POSIX path; refuses escapes. */
export function vaultAbs(home: string, rel: string): string {
  if (isAbsolute(rel) || rel.split('/').includes('..')) throw new Error(`not a vault-relative path: ${rel}`);
  return join(home, ...rel.split('/'));
}

/** Create the vault tree and a default config.json if missing. Never overwrites. */
export function initVault(home: string): void {
  // Owner-only: folders and files created here are 0700 / 0600. An existing vault keeps its permissions.
  mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const d of VAULT_DIRS) mkdirSync(join(home, d), { recursive: true, mode: 0o700 });
  if (!existsSync(configPath(home))) writeFileSync(configPath(home), `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { mode: 0o600 });
}

export function readConfig(home: string): PolicyConfig {
  return PolicyConfig.parse(JSON.parse(readFileSync(configPath(home), 'utf8')));
}

/** Nearest ancestor (including `dir`) that contains `.git`, or null. */
export function findGitRoot(dir: string): string | null {
  let cur = resolve(dir);
  for (;;) {
    if (existsSync(join(cur, '.git'))) return cur;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/** Every CLAUDE.md in `dir` and its parent chain (decisions.md #8). */
export function findClaudeMdInParents(dir: string): string[] {
  const hits: string[] = [];
  let cur = resolve(dir);
  for (;;) {
    const f = join(cur, 'CLAUDE.md');
    if (existsSync(f)) hits.push(f);
    const up = dirname(cur);
    if (up === cur) return hits;
    cur = up;
  }
}

// ---------------------------------------------------------------------------
// Frontmatter. Format matches the fixtures: `key: <JSON value>` lines between `---`.
// Markdown is never parsed for structured fields; only `id` and `type` are read back.
// ---------------------------------------------------------------------------

export interface MdDoc {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function renderMd(fm: Frontmatter, body: string): string {
  const head = Object.entries(fm)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n');
  return `---\n${head}\n---\n\n${body.replace(/^\s+/, '').replace(/\s+$/, '')}\n`;
}

/** Parse frontmatter. Values are JSON when possible, else the raw string. No frontmatter -> empty object. */
export function parseMd(text: string): MdDoc {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { frontmatter: {}, body: text };
  const frontmatter: Record<string, unknown> = {};
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const raw = line.slice(i + 1).trim();
    try {
      frontmatter[key] = JSON.parse(raw);
    } catch {
      frontmatter[key] = raw.replace(/^['"]|['"]$/g, '');
    }
  }
  return { frontmatter, body: text.slice(m[0].length).replace(/^\r?\n/, '') };
}

export function readMd(home: string, rel: string): MdDoc {
  return parseMd(readFileSync(vaultAbs(home, rel), 'utf8'));
}

/** Write a markdown file with frontmatter. Returns false (and writes nothing) if it exists and `overwrite` is not set. */
export function writeMd(home: string, rel: string, fm: Frontmatter, body: string, opts: { overwrite?: boolean } = {}): boolean {
  const abs = vaultAbs(home, rel);
  if (!opts.overwrite && existsSync(abs)) return false;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, renderMd(fm, body));
  return true;
}

/** Vault-relative POSIX form of an absolute path inside `home`. */
export function toVaultRel(home: string, abs: string): string {
  const root = resolve(home) + sep;
  const a = resolve(abs);
  if (!a.startsWith(root)) throw new Error(`${abs} is outside the vault`);
  return a.slice(root.length).split(sep).join('/');
}
