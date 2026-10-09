import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOOLEAN_COLUMNS,
  COMPONENT_DATA_SCHEMAS,
  CRITERIA,
  DECISION_KINDS,
  DEFAULT_CONFIG,
  EVENT_TYPES,
  isHardHuman,
  PROFILE_COMPONENT_KEYS,
  type ProfileComponentKey,
  ROLE_STATUSES,
  RubricSnapshot,
  TABLES,
  type TableName,
} from '@perfect-placement/contracts';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  companies,
  decisions,
  FIXTURE_SEED_SQL,
  FIXTURE_VAULT_DIR,
  fixtureTotal,
  profileComponents,
  RUBRIC,
  roles,
  scores,
  toSeedSql,
  vaultFiles,
} from './index.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../engine/db/migrations', import.meta.url));
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const migration = (prefix: string) => readFileSync(join(MIGRATIONS_DIR, MIGRATIONS.find((f) => f.startsWith(prefix)) as string), 'utf8');

let dir: string;
let db: Database.Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pp-fixtures-'));
  db = new Database(join(dir, 'pp.db'));
  for (const f of MIGRATIONS) db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
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

describe('migrations 001..004', () => {
  it('are numbered 001 to 004 and recorded', () => {
    expect(MIGRATIONS.slice(0, 4)).toEqual(['001_init.sql', '002_wave2.sql', '003_fresh_start.sql', '004_run_queued.sql']);
    const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[];
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3, 4]);
  });

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

  it('enforces append-only scores and events, and apply.submit = human', () => {
    expect(() => db.exec(`UPDATE score SET total = 1`)).toThrow(/append-only/);
    expect(() => db.exec(`DELETE FROM event`)).toThrow(/append-only/);
    const ins = db.prepare(
      `INSERT INTO decision (id, ts, kind, subject_type, subject_id, question_json, backend, answer_json, p, impact, policy_outcome, status) VALUES (?,'x',?,'role','r','{}',?,'{}',0.99,?,?,'applied')`,
    );
    db.exec('SAVEPOINT d');
    expect(() => ins.run('x1', 'apply.submit', 'kev', 'high', 'auto')).toThrow();
    expect(() => ins.run('x2', 'apply.submit', 'agent', 'high', 'auto_undo')).toThrow();
    // #24: a non-excluded high-impact decision may be auto + undo; `agent` is a backend.
    expect(() => ins.run('x3', 'roles.archive', 'agent', 'high', 'auto_undo')).not.toThrow();
    expect(() => ins.run('x4', 'other', 'nope', 'low', 'auto')).toThrow();
    db.exec('ROLLBACK TO d; RELEASE d');
  });

  it('002 adds archive reason duplicate and keeps role indexes, FKs and data', () => {
    db.exec('SAVEPOINT r');
    db.prepare(
      `INSERT INTO role (id, company_id, title, source, found_at, status, archive_reason, created_at, updated_at) VALUES ('tmp_dup', 'stripe', 't', 'scout', 'x', 'archived', 'duplicate', 'x', 'x')`,
    ).run();
    expect(() =>
      db.exec(
        `INSERT INTO role (id, company_id, title, source, found_at, status, created_at, updated_at) VALUES ('tmp_fk', 'no_such_co', 't', 'scout', 'x', 'inbox', 'x', 'x')`,
      ),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      db.exec(
        `INSERT INTO role (id, company_id, title, url, source, found_at, created_at, updated_at) SELECT 'tmp_url', company_id, title, url, source, found_at, created_at, updated_at FROM role WHERE url IS NOT NULL LIMIT 1`,
      ),
    ).toThrow(/UNIQUE/);
    db.exec('ROLLBACK TO r; RELEASE r');
    const idx = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='role' AND name NOT LIKE 'sqlite_%'`).all() as {
        name: string;
      }[]
    )
      .map((r) => r.name)
      .sort();
    expect(idx).toEqual(['role_ats_job_idx', 'role_company_idx', 'role_status_idx', 'role_url_uq']);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('002 preserves rows written under 001', () => {
    const old = new Database(':memory:');
    old.exec(migration('001'));
    // Seed as 001 would accept it: no onboard_session, no `agent` backend.
    const seed001 = readFileSync(FIXTURE_SEED_SQL, 'utf8')
      .replace(/^INSERT INTO onboard_session .*$/gm, '')
      .replace(/^INSERT INTO decision .*$/gm, (line) => line.replaceAll("'agent'", "'llm'"));
    old.exec(seed001);
    const before = (t: string) => old.prepare(`SELECT * FROM ${t} ORDER BY id`).all() as unknown[];
    const roles001 = before('role');
    const decisions001 = before('decision');
    old.exec(migration('002'));
    expect(old.prepare('SELECT * FROM role ORDER BY id').all()).toEqual(roles001);
    expect(old.prepare('SELECT * FROM decision ORDER BY id').all()).toEqual(decisions001);
    expect(old.pragma('foreign_key_check')).toEqual([]);
    old.close();
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

  it('score with the v1 formula from a valid RubricSnapshot', () => {
    expect(RubricSnapshot.safeParse(RUBRIC).success).toBe(true);
    for (const s of scores) {
      expect(RubricSnapshot.safeParse(s.rubric_json).success, s.id).toBe(true);
      expect(s.rubric_json.scale).toBe('v1');
      expect(s.total, s.id).toBe(
        fixtureTotal(
          CRITERIA.map((c) => s[c]),
          s.affinity_mod,
        ),
      );
    }
    // All 4s, no affinity = 80 on the v1 scale.
    expect(fixtureTotal([4, 4, 4, 4, 4, 4, 4, 4, 4], 0)).toBe(80);
  });

  it('profile component data matches the per-key schemas', () => {
    for (const c of profileComponents) {
      const r = COMPONENT_DATA_SCHEMAS[c.key as ProfileComponentKey].safeParse(c.data_json);
      expect(r.success, `${c.id} ${c.key}: ${r.error?.message}`).toBe(true);
    }
  });

  it('decisions respect the hard exclusions', () => {
    for (const d of decisions) if (isHardHuman({ kind: d.kind, op: d.action_json?.op })) expect(d.policy_outcome, d.id).toBe('human');
    const dc1 = decisions.find((d) => d.id === 'dc_0001');
    expect(dc1?.action_json?.when).toBe(false);
    expect(decisions.find((d) => d.id === 'dc_0101')?.action_json?.undo?.op).toBe('roles.move');
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
