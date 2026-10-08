import { BOOLEAN_COLUMNS, type TABLES, type TableName } from '@perfect-placement/contracts';
import type Database from 'better-sqlite3';
import type { z } from 'zod';

/*
 * SHIM for lane A's repository layer. Converts between SQLite rows and contract shapes
 * (`*_json` <-> parsed JSON, INTEGER 0/1 <-> boolean). Wave 2: swap for packages/engine/db.
 */

export type Row<T extends TableName> = z.infer<(typeof TABLES)[T]>;
type Raw = Record<string, unknown>;

export function hydrate<T extends TableName>(table: T, row: Raw): Row<T> {
  const bools: readonly string[] = BOOLEAN_COLUMNS[table] ?? [];
  const out: Raw = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.endsWith('_json') && typeof v === 'string') out[k] = JSON.parse(v);
    else if (bools.includes(k) && typeof v === 'number') out[k] = v === 1;
    else out[k] = v;
  }
  return out as Row<T>;
}

export function dehydrate<T extends TableName>(table: T, obj: Partial<Row<T>>): Raw {
  const bools: readonly string[] = BOOLEAN_COLUMNS[table] ?? [];
  const out: Raw = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (k.endsWith('_json')) out[k] = v === null ? null : JSON.stringify(v);
    else if (bools.includes(k) && typeof v === 'boolean') out[k] = v ? 1 : 0;
    else out[k] = v;
  }
  return out;
}

export function insert<T extends TableName>(db: Database.Database, table: T, obj: Row<T>): void {
  const raw = dehydrate(table, obj);
  const cols = Object.keys(raw);
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`).run(raw);
}

export function update<T extends TableName>(db: Database.Database, table: T, id: string, patch: Partial<Row<T>>): void {
  const raw = dehydrate(table, patch);
  delete raw.id;
  const cols = Object.keys(raw);
  if (cols.length === 0) return;
  db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @__id`).run({ ...raw, __id: id });
}

export function get<T extends TableName>(db: Database.Database, table: T, id: string): Row<T> | null {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Raw | undefined;
  return row ? hydrate(table, row) : null;
}

export function select<T extends TableName>(db: Database.Database, table: T, where = '1', params: unknown[] = []): Row<T>[] {
  return (db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(...params) as Raw[]).map((r) => hydrate(table, r));
}
