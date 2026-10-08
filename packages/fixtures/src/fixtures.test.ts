import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOOLEAN_COLUMNS,
  DECISION_KINDS,
  DEFAULT_CONFIG,
  EVENT_TYPES,
  PROFILE_COMPONENT_KEYS,
  ROLE_STATUSES,
  TABLES,
  type TableName,
} from '@perfect-placement/contracts';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { companies, decisions, FIXTURE_SEED_SQL, FIXTURE_VAULT_DIR, roles, scores, toSeedSql, vaultFiles } from './index.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../engine/db/migrations', import.meta.url));

let dir: string;
let db: Database.Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pp-fixtures-'));
  db = new Database(join(dir, 'pp.db'));
  for (const f of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  }
  db.exec(readFileSync(FIXTURE_SEED_SQL, 'utf8'));
});

afterAll(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Turn a SQLite row back into the contract shape (JSON + booleans). */
function hydrate(table: TableName, row: Record<string, unknown>) {
  const bools = BOOLEAN_COLUMNS[table] ?? [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.endsWith('_json') && typeof v === 'string') out[k] = JSON.parse(v);
    else if (bools.includes(k) && typeof v === 'number') out[k] = v === 1;
    else out[k] = v;
  }
  return out;
}

describe('migration 001', () => {
  it('creates exactly the contract tables with exactly the contract columns', () => {
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'`)
      .all()
      .map((r) => (r as { name: string }).name)
      .sort();
    expect(tables).toEqual(Object.keys(TABLES).sort());
    for (const table of Object.keys(TABLES) as TableName[]) {
      const cols = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => (c as { name: string }).name)
        .sort();
      expect(cols, table).toEqual(Object.keys(TABLES[table].shape).sort());
    }
  });

  it('enforces enums from contracts', () => {
    const insert = db.prepare(
      `INSERT INTO role (id, company_id, title, source, found_at, status, archive_reason, held_reason, created_at, updated_at) VALUES (?, 'stripe', 't', 'scout', 'x', ?, ?, ?, 'x', 'x')`,
    );
    db.exec('SAVEPOINT s');
    for (const s of ROLE_STATUSES) insert.run(`tmp_${s}`, s, s === 'archived' ? 'closed' : null, s === 'held' ? 'company_cap' : null);
    expect(() => insert.run('tmp_bad', 'nope', null, null)).toThrow();
    expect(() => insert.run('tmp_noreason', 'archived', null, null)).toThrow();
    db.exec('ROLLBACK TO s; RELEASE s');
  });

  it('enforces append-only scores and events, and high impact = human', () => {
    expect(() => db.exec(`UPDATE score SET total = 1`)).toThrow(/append-only/);
    expect(() => db.exec(`DELETE FROM event`)).toThrow(/append-only/);
    expect(() =>
      db.exec(
        `INSERT INTO decision (id, ts, kind, subject_type, subject_id, question_json, backend, answer_json, p, impact, policy_outcome, status) VALUES ('x','x','apply.submit','role','r','{}','jev','{}',0.99,'high','auto','applied')`,
      ),
    ).toThrow();
  });
});

describe('fixtures', () => {
  it('load and every row parses against its contract schema', () => {
    for (const table of Object.keys(TABLES) as TableName[]) {
      const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      expect(rows.length, table).toBeGreaterThan(0);
      for (const row of rows) {
        const parsed = TABLES[table].safeParse(hydrate(table, row));
        expect(parsed.success, `${table} ${row.id}: ${parsed.error?.message}`).toBe(true);
      }
    }
  });

  it('cover the shape lanes need', () => {
    expect(companies).toHaveLength(12);
    expect(roles.length).toBeGreaterThanOrEqual(30);
    for (const s of ROLE_STATUSES)
      expect(
        roles.some((r) => r.status === s),
        s,
      ).toBe(true);
    const archivedReasons = new Set(roles.filter((r) => r.status === 'archived').map((r) => r.archive_reason));
    expect(archivedReasons.size).toBeGreaterThanOrEqual(5);
    const pv = db.prepare(`SELECT version_id, count(*) n FROM profile_component GROUP BY version_id`).all() as { n: number }[];
    for (const v of pv) expect(v.n).toBe(PROFILE_COMPONENT_KEYS.length);
    expect(decisions.filter((d) => d.status === 'pending').length).toBeGreaterThanOrEqual(5);
    for (const t of ['auto', 'auto_second', 'auto_undo', 'human'] as const)
      expect(
        decisions.some((d) => d.policy_outcome === t),
        t,
      ).toBe(true);
    for (const d of decisions) expect(DECISION_KINDS).toContain(d.kind);
  });

  it('respect the company cap and band thresholds', () => {
    const activeByCo = new Map<string, number>();
    for (const r of roles.filter((r) => r.status === 'active')) activeByCo.set(r.company_id, (activeByCo.get(r.company_id) ?? 0) + 1);
    for (const n of activeByCo.values()) expect(n).toBeLessThanOrEqual(DEFAULT_CONFIG.scoring.company_active_cap);
    const latest = new Map(scores.map((s) => [s.role_id, s]));
    for (const r of roles) {
      const s = latest.get(r.id);
      if (['active', 'held', 'on-deck', 'draft-ready'].includes(r.status)) expect(s?.band, r.id).toBe('green');
      if (r.archive_reason === 'below_threshold') expect(s?.band, r.id).not.toBe('green');
    }
  });

  it('every md_path exists in the vault with a matching frontmatter id', () => {
    for (const table of ['role', 'company', 'outreach', 'profile_component'] as const) {
      const rows = db.prepare(`SELECT id, md_path FROM ${table} WHERE md_path IS NOT NULL`).all() as { id: string; md_path: string }[];
      for (const { md_path } of rows) {
        const abs = join(FIXTURE_VAULT_DIR, md_path);
        expect(existsSync(abs), md_path).toBe(true);
        expect(readFileSync(abs, 'utf8')).toMatch(/^---\nid: /);
      }
    }
  });

  it('committed seed + vault are in sync with src/data.ts (run `gen` if this fails)', () => {
    expect(readFileSync(FIXTURE_SEED_SQL, 'utf8')).toBe(toSeedSql());
    for (const [rel, content] of vaultFiles()) expect(readFileSync(join(FIXTURE_VAULT_DIR, rel), 'utf8'), rel).toBe(content);
  });

  it('only use known event types', () => {
    const types = db.prepare(`SELECT DISTINCT type FROM event`).all() as { type: string }[];
    for (const { type } of types) expect(EVENT_TYPES).toContain(type);
  });
});
