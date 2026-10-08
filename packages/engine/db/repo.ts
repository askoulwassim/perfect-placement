import { BOOLEAN_COLUMNS, TABLES, type TableName } from '@perfect-placement/contracts';
import type { Db } from './connection.js';

/*
 * Typed repository layer over better-sqlite3. No ORM: one generic repo per contract table.
 * Converts `*_json` columns and BOOLEAN_COLUMNS between SQLite and contract shapes.
 * Op handlers (lane B) are the only callers that write; this layer only does mechanics.
 */

/** Contract row type for a table (zod output; avoids a direct zod dependency). */
export type Row<T extends TableName> = (typeof TABLES)[T]['_zod']['output'];
type SqlValue = string | number | bigint | Buffer | null;

const APPEND_ONLY: ReadonlySet<TableName> = new Set(['score', 'event']);

/** SQLite row -> contract shape (parse JSON, 0/1 -> boolean). */
export function hydrate<T extends TableName>(table: T, raw: Record<string, unknown>): Row<T> {
  const bools: readonly string[] = BOOLEAN_COLUMNS[table] ?? [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.endsWith('_json') && typeof v === 'string') out[k] = JSON.parse(v);
    else if (bools.includes(k) && typeof v === 'number') out[k] = v === 1;
    else out[k] = v;
  }
  return out as Row<T>;
}

/** Contract shape -> SQLite values (stringify JSON, boolean -> 0/1). */
export function dehydrate(table: TableName, row: Record<string, unknown>): Record<string, SqlValue> {
  const out: Record<string, SqlValue> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    if (k.endsWith('_json')) out[k] = v === null ? null : JSON.stringify(v);
    else if (typeof v === 'boolean') out[k] = v ? 1 : 0;
    else out[k] = v as SqlValue;
  }
  void table;
  return out;
}

const COLS: Record<TableName, ReadonlySet<string>> = Object.fromEntries(
  Object.entries(TABLES).map(([t, s]) => [t, new Set(Object.keys(s.shape))]),
) as unknown as Record<TableName, ReadonlySet<string>>;

function assertCols(table: TableName, keys: string[]): void {
  for (const k of keys) if (!COLS[table].has(k)) throw new Error(`${table}: unknown column ${k}`);
}

export type Where = Record<string, SqlValue | boolean>;

export class Repo<T extends TableName> {
  constructor(
    readonly db: Db,
    readonly table: T,
  ) {}

  get(id: string): Row<T> | undefined {
    const raw = this.db.prepare(`SELECT * FROM ${this.table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return raw ? hydrate(this.table, raw) : undefined;
  }

  has(id: string): boolean {
    return this.db.prepare(`SELECT 1 FROM ${this.table} WHERE id = ?`).get(id) !== undefined;
  }

  /** Equality filter on columns; `orderBy` is a column name (optionally ` DESC`). */
  list(where: Where = {}, opts: { orderBy?: string; limit?: number } = {}): Row<T>[] {
    const keys = Object.keys(where);
    assertCols(this.table, keys);
    const clause = keys.length ? ` WHERE ${keys.map((k) => (where[k] === null ? `${k} IS NULL` : `${k} = @${k}`)).join(' AND ')}` : '';
    let order = '';
    if (opts.orderBy) {
      const [col, dir] = opts.orderBy.split(/\s+/);
      assertCols(this.table, [col as string]);
      order = ` ORDER BY ${col}${dir?.toUpperCase() === 'DESC' ? ' DESC' : ''}`;
    }
    const limit = opts.limit ? ` LIMIT ${Math.floor(opts.limit)}` : '';
    const params = dehydrate(this.table, Object.fromEntries(keys.filter((k) => where[k] !== null).map((k) => [k, where[k]])));
    return (this.db.prepare(`SELECT * FROM ${this.table}${clause}${order}${limit}`).all(params) as Record<string, unknown>[]).map((r) =>
      hydrate(this.table, r),
    );
  }

  count(where: Where = {}): number {
    const keys = Object.keys(where);
    assertCols(this.table, keys);
    const clause = keys.length ? ` WHERE ${keys.map((k) => (where[k] === null ? `${k} IS NULL` : `${k} = @${k}`)).join(' AND ')}` : '';
    const params = dehydrate(this.table, Object.fromEntries(keys.filter((k) => where[k] !== null).map((k) => [k, where[k]])));
    return (this.db.prepare(`SELECT count(*) n FROM ${this.table}${clause}`).get(params) as { n: number }).n;
  }

  /** Validate against the contract schema, then insert. */
  insert(row: Row<T>): Row<T> {
    const parsed = TABLES[this.table].parse(row) as Row<T>;
    const vals = dehydrate(this.table, parsed as Record<string, unknown>);
    const keys = Object.keys(vals);
    this.db.prepare(`INSERT INTO ${this.table} (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`).run(vals);
    return parsed;
  }

  /** Insert unless a row with this id exists. Returns true when inserted. */
  insertIfAbsent(row: Row<T>): boolean {
    if (this.has((row as { id: string }).id)) return false;
    this.insert(row);
    return true;
  }

  /** Patch columns of one row; the merged row is validated. Refused on append-only tables. */
  update(id: string, patch: Partial<Row<T>>): Row<T> {
    if (APPEND_ONLY.has(this.table)) throw new Error(`${this.table} is append-only`);
    const cur = this.get(id);
    if (!cur) throw new Error(`${this.table} ${id} not found`);
    const merged = TABLES[this.table].parse({ ...cur, ...patch }) as Row<T>;
    const vals = dehydrate(this.table, Object.fromEntries(Object.keys(patch).map((k) => [k, (merged as Record<string, unknown>)[k]])));
    const keys = Object.keys(vals).filter((k) => k !== 'id');
    assertCols(this.table, keys);
    if (keys.length)
      this.db.prepare(`UPDATE ${this.table} SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...vals, id });
    return merged;
  }
}

export type Repos = { [T in TableName]: Repo<T> };

/** One repo per contract table. */
export function repos(db: Db): Repos {
  return Object.fromEntries(Object.keys(TABLES).map((t) => [t, new Repo(db, t as TableName)])) as unknown as Repos;
}
