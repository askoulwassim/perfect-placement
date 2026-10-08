import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { listMigrations, MIGRATIONS_DIR } from '../../db/index.js';

/*
 * SHIM for lane A's migration runner. Opens (or creates) a db and applies pending
 * numbered migrations from packages/engine/db/migrations. Wave 2: use lane A's runner.
 */

export function applyMigrations(db: Database.Database, dir: string = MIGRATIONS_DIR): number[] {
  const hasTable = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'`).get();
  const done = new Set(
    hasTable ? (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version) : [],
  );
  const applied: number[] = [];
  for (const file of listMigrations(dir)) {
    const version = Number(file.slice(0, 3));
    if (done.has(version)) continue;
    db.exec(readFileSync(join(dir, file), 'utf8'));
    db.prepare(`INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`).run(
      version,
      file.replace(/\.sql$/, ''),
      new Date().toISOString(),
    );
    applied.push(version);
  }
  return applied;
}

export function openDb(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applyMigrations(db);
  return db;
}
