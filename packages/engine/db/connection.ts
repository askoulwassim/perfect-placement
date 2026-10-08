import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/** Absolute path to the numbered SQL migrations (works from src and dist). */
export const MIGRATIONS_DIR = fileURLToPath(
  new URL(import.meta.url.includes('/dist/') ? '../../db/migrations/' : './migrations/', import.meta.url),
);

/** Migration files in apply order. */
export function listMigrations(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort();
}

const versionOf = (file: string): number => Number(file.slice(0, 3));

/** Versions recorded in schema_migrations (empty if the table does not exist yet). */
export function appliedVersions(db: Db): number[] {
  const t = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`).get();
  if (!t) return [];
  return (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]).map((r) => r.version);
}

/** Apply pending migrations, each in its own transaction. Returns the files applied. */
export function applyMigrations(db: Db, dir: string = MIGRATIONS_DIR): string[] {
  const done = new Set(appliedVersions(db));
  const applied: string[] = [];
  for (const file of listMigrations(dir)) {
    const version = versionOf(file);
    if (done.has(version)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      // Migrations may record themselves (001 does); record the rest here.
      db.prepare(`INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`).run(
        version,
        file.replace(/\.sql$/, ''),
        new Date().toISOString(),
      );
    })();
    applied.push(file);
  }
  return applied;
}

export interface OpenDbOptions {
  /** Apply pending migrations on open (default true). */
  migrate?: boolean;
  readonly?: boolean;
}

/** Open (and by default migrate) a pp.db. Foreign keys on, WAL journal. */
export function openDb(file: string, opts: OpenDbOptions = {}): Db {
  const db = new Database(file, { readonly: opts.readonly ?? false, fileMustExist: opts.readonly ?? false });
  db.pragma('foreign_keys = ON');
  if (!opts.readonly) {
    db.pragma('journal_mode = WAL');
    if (opts.migrate ?? true) applyMigrations(db);
  }
  return db;
}
