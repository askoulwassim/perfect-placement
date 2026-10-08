import type { TableName } from '@perfect-placement/contracts';
import type Database from 'better-sqlite3';
import { type Row, repos } from '../db/repo.js';

/*
 * Thin helpers over lane A's repositories (packages/engine/db/repo.ts), the only db access layer.
 * Handlers call these inside `runOp`; nothing here opens its own transaction.
 */

export type { Row };

export function get<T extends TableName>(db: Database.Database, table: T, id: string): Row<T> | null {
  return repos(db)[table].get(id) ?? null;
}

export function insert<T extends TableName>(db: Database.Database, table: T, row: Row<T>): Row<T> {
  return repos(db)[table].insert(row);
}

export function update<T extends TableName>(db: Database.Database, table: T, id: string, patch: Partial<Row<T>>): Row<T> {
  return repos(db)[table].update(id, patch);
}

/** Rows matching a read-only SQL condition (may end in ORDER BY / LIMIT). */
export function select<T extends TableName>(db: Database.Database, table: T, where = '1', params: readonly unknown[] = []): Row<T>[] {
  return repos(db)[table].select(where, params);
}
