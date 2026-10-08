import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  type Frontmatter,
  PolicyConfig,
  PP_HOME_DEFAULT,
  PP_HOME_ENV,
  VaultPath,
} from '@perfect-placement/contracts';
import { OpError } from './errors.js';

/** Resolve PP_HOME (env override, else ~/.perfect-placement). */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[PP_HOME_ENV] || PP_HOME_DEFAULT;
  return resolve(raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw);
}

/** Render a vault markdown file: frontmatter (`id`, `type`, extras) then body. */
export function renderMarkdown(fm: Frontmatter, body: string): string {
  const head = Object.entries(fm)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n');
  return `---\n${head}\n---\n\n${body.trim()}\n`;
}

/** Body without the frontmatter block. Markdown is never parsed for structured fields. */
export function stripFrontmatter(md: string): string {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(md);
  return (m ? md.slice(m[0].length) : md).replace(/^\n+/, '');
}

type Pending = { kind: 'write' | 'append'; path: string; content: string };

/**
 * Vault writes staged during an op and flushed only after the db transaction commits,
 * so a failed or dry-run op leaves the vault untouched.
 */
export class VaultTx {
  private pending: Pending[] = [];
  constructor(readonly home: string) {}

  abs(rel: string): string {
    const parsed = VaultPath.safeParse(rel);
    if (!parsed.success || isAbsolute(rel)) throw new OpError('internal', `not a vault-relative path: ${rel}`);
    return join(this.home, rel);
  }

  write(rel: string, content: string): void {
    this.abs(rel);
    this.pending.push({ kind: 'write', path: rel, content });
  }

  append(rel: string, content: string): void {
    this.abs(rel);
    this.pending.push({ kind: 'append', path: rel, content });
  }

  /** Current content, including staged writes. */
  read(rel: string): string | null {
    let base: string | null = null;
    const abs = this.abs(rel);
    if (existsSync(abs)) base = readFileSync(abs, 'utf8');
    for (const p of this.pending) {
      if (p.path !== rel) continue;
      base = p.kind === 'write' ? p.content : (base ?? '') + p.content;
    }
    return base;
  }

  exists(rel: string): boolean {
    return this.read(rel) !== null;
  }

  flush(): void {
    for (const p of this.pending) {
      const abs = this.abs(p.path);
      mkdirSync(dirname(abs), { recursive: true });
      if (p.kind === 'append') appendFileSync(abs, p.content, 'utf8');
      else {
        // write-then-rename so a crash never leaves a half file
        const tmp = `${abs}.tmp-${process.pid}`;
        writeFileSync(tmp, p.content, 'utf8');
        renameSync(tmp, abs);
      }
    }
    this.pending = [];
  }

  discard(): void {
    this.pending = [];
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep merge for config patches. Arrays and scalars replace; `null` deletes a key. */
export function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k] as Record<string, unknown>, v);
    else out[k] = v;
  }
  return out;
}

/** `$PP_HOME/config.json` merged over DEFAULT_CONFIG. Missing file = defaults. */
export function readConfig(home: string): PolicyConfig {
  const abs = join(home, CONFIG_FILE);
  if (!existsSync(abs)) return DEFAULT_CONFIG;
  const raw = JSON.parse(readFileSync(abs, 'utf8')) as Record<string, unknown>;
  return PolicyConfig.parse(deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, raw));
}
