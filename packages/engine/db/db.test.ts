import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DECISION_KINDS, RUN_STATUSES } from '@perfect-placement/contracts';
import { FIXTURE_SEED_SQL } from '@perfect-placement/fixtures';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appliedVersions, applyMigrations, listMigrations, MIGRATIONS_DIR, openDb } from './connection.js';
import { newId, roleId, slugify, ulid } from './ids.js';
import { repos } from './repo.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pp-db-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const migration = (prefix: string) =>
  readFileSync(join(MIGRATIONS_DIR, listMigrations().find((f) => f.startsWith(prefix)) as string), 'utf8');

describe('migrations', () => {
  it('are discoverable and start at 001', () => {
    expect(existsSync(MIGRATIONS_DIR)).toBe(true);
    expect(listMigrations()[0]).toBe('001_init.sql');
  });

  it('apply once and record every version; reopening is a no-op', () => {
    const file = join(dir, 'pp.db');
    const db = openDb(file);
    expect(appliedVersions(db)).toEqual(listMigrations().map((f) => Number(f.slice(0, 3))));
    expect(applyMigrations(db)).toEqual([]);
    db.close();
    const again = openDb(file);
    expect(appliedVersions(again).length).toBe(listMigrations().length);
    again.close();
  });
});

const company = {
  id: 'acme',
  slug: 'acme',
  name: 'Acme',
  domain: null,
  ats_type: 'unknown',
  ats_board: null,
  affinity: 0,
  md_path: null,
} as const;
const role = {
  id: 'acme_staff-pm',
  company_id: 'acme',
  title: 'Staff PM',
  url: 'https://example.com/1',
  ats_job_id: null,
  source: 'manual',
  found_at: '2026-01-01T00:00:00.000Z',
  posted_at: null,
  workplace: 'remote',
  remote_ok: true,
  location: null,
  comp_min: null,
  comp_max: null,
  comp_currency: null,
  facing: null,
  seniority: null,
  status: 'active',
  archive_reason: null,
  held_reason: null,
  last_checked_at: null,
  freshness: 'unknown',
  flags_json: { dream_company: true },
  md_path: 'roles/acme_staff-pm.md',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
} as const;

describe('repositories', () => {
  it('round-trip JSON and boolean columns', () => {
    const db = openDb(join(dir, 'pp.db'));
    const R = repos(db);
    R.company.insert({ ...company });
    R.role.insert({ ...role, flags_json: { ...role.flags_json } });
    const got = R.role.get('acme_staff-pm');
    expect(got?.remote_ok).toBe(true);
    expect(got?.flags_json).toEqual({ dream_company: true });
    expect((db.prepare('SELECT remote_ok, flags_json FROM role').get() as Record<string, unknown>).remote_ok).toBe(1);
    expect(R.role.list({ status: 'active' })).toHaveLength(1);
    expect(R.role.count({ remote_ok: true })).toBe(1);
    expect(R.role.list({ archive_reason: null })).toHaveLength(1);
    db.close();
  });

  it('validate against contracts and respect constraints', () => {
    const db = openDb(join(dir, 'pp.db'));
    const R = repos(db);
    R.company.insert({ ...company });
    expect(() => R.role.insert({ ...role, flags_json: {}, status: 'nope' as 'active' })).toThrow();
    R.role.insert({ ...role, flags_json: {} });
    expect(R.role.insertIfAbsent({ ...role, flags_json: {} })).toBe(false);
    expect(() => R.role.update('acme_staff-pm', { status: 'archived' })).toThrow(); // needs archive_reason (CHECK)
    const upd = R.role.update('acme_staff-pm', { status: 'archived', archive_reason: 'passed' });
    expect(upd.status).toBe('archived');
    expect(() => R.role.list({ bogus: 1 } as never)).toThrow(/unknown column/);
    db.close();
  });

  it('refuse updates on append-only tables', () => {
    const db = openDb(join(dir, 'pp.db'));
    expect(() => repos(db).score.update('x', { total: 1 })).toThrow(/append-only/);
    db.close();
  });
});

describe('ids', () => {
  it('are prefixed ULIDs, deterministic with a seed', () => {
    expect(newId('score')).toMatch(/^sc_[0-9a-z]{26}$/);
    expect(newId('event', 1000, 'x')).toBe(newId('event', 1000, 'x'));
    expect(newId('event', 1000, 'x')).not.toBe(newId('event', 1000, 'y'));
    expect(ulid(0, 'a').slice(0, 10)).toBe('0000000000');
  });

  it('slugify and role ids', () => {
    expect(slugify('Pokémon Company Intl.')).toBe('pokemon-company-intl');
    expect(slugify('Weights & Biases')).toBe('weights-and-biases');
    const taken = new Set(['acme_pm']);
    expect(roleId('acme', 'pm', (x) => taken.has(x))).toBe('acme_pm-2');
  });
});

describe('migration 003 (fresh start, #26)', () => {
  it('drops archive reason legacy and source migration, mapping any leftovers', () => {
    const fx = new Database(':memory:');
    for (const f of listMigrations()) fx.exec(migration(f.slice(0, 3)));
    fx.exec(readFileSync(FIXTURE_SEED_SQL, 'utf8'));
    const insert = fx.prepare(
      `INSERT INTO role (id, company_id, title, source, found_at, status, archive_reason, created_at, updated_at) VALUES (?, 'stripe', 't', ?, 'x', ?, ?, 'x', 'x')`,
    );
    expect(() => insert.run('tmp_legacy', 'scout', 'archived', 'legacy')).toThrow(/CHECK/);
    expect(() => insert.run('tmp_mig', 'migration', 'inbox', null)).toThrow(/CHECK/);
    expect(() => insert.run('tmp_ok', 'manual', 'archived', 'passed')).not.toThrow();
    fx.close();

    const old = new Database(':memory:');
    old.exec(migration('001'));
    old.exec(migration('002'));
    old.exec(readFileSync(FIXTURE_SEED_SQL, 'utf8'));
    old.exec(`UPDATE role SET archive_reason = 'legacy' WHERE id = (SELECT id FROM role WHERE status = 'archived' ORDER BY id LIMIT 1)`);
    old.exec(`UPDATE role SET source = 'migration' WHERE id = (SELECT id FROM role WHERE status = 'inbox' ORDER BY id LIMIT 1)`);
    const roles002 = old.prepare('SELECT * FROM role ORDER BY id').all() as Record<string, unknown>[];
    const indexes = () =>
      (
        old
          .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='role' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
          .all() as { name: string }[]
      ).map((r) => r.name);
    const idx002 = indexes();
    old.exec(migration('003'));
    const expected = roles002.map((r) => ({
      ...r,
      archive_reason: r.archive_reason === 'legacy' ? 'passed' : r.archive_reason,
      source: r.source === 'migration' ? 'manual' : r.source,
    }));
    expect(old.prepare('SELECT * FROM role ORDER BY id').all()).toEqual(expected);
    expect(old.prepare(`SELECT count(*) n FROM role WHERE archive_reason = 'legacy' OR source = 'migration'`).get()).toEqual({ n: 0 });
    expect(indexes()).toEqual(idx002);
    expect(old.pragma('foreign_key_check')).toEqual([]);
    expect(() => old.exec(`DELETE FROM score`)).toThrow(/append-only/);
    old.close();
  });
});

describe('migration 004 (run status queued, #21)', () => {
  it('accepts every contract run status, rejects others, and keeps every run', () => {
    const old = new Database(':memory:');
    for (const v of ['001', '002', '003']) old.exec(migration(v));
    old.exec(readFileSync(FIXTURE_SEED_SQL, 'utf8'));
    const before = old.prepare('SELECT * FROM run ORDER BY id').all();
    expect(before.length).toBeGreaterThan(0);
    const ins = old.prepare(`INSERT INTO run (id, op, started_at, status) VALUES (?, 'scout', 'x', ?)`);
    expect(() => ins.run('tmp_q', 'queued')).toThrow(/CHECK/);
    old.exec(migration('004'));
    expect(old.prepare('SELECT * FROM run ORDER BY id').all()).toEqual(before);
    old.exec('SAVEPOINT s');
    for (const s of RUN_STATUSES) ins.run(`tmp_${s}`, s);
    expect(() => ins.run('tmp_bad', 'nope')).toThrow(/CHECK/);
    old.exec('ROLLBACK TO s; RELEASE s');
    expect(old.pragma('foreign_key_check')).toEqual([]);
    expect(old.prepare('SELECT max(version) v FROM schema_migrations').get()).toEqual({ v: 4 });
    old.close();
  });
});

describe('migration 005 (decision kind apply.fact_check, #54)', () => {
  it('accepts every contract decision kind, keeps every decision, its indexes and the apply.submit check', () => {
    const old = new Database(':memory:');
    for (const v of ['001', '002', '003', '004']) old.exec(migration(v));
    old.exec(readFileSync(FIXTURE_SEED_SQL, 'utf8'));
    const before = old.prepare('SELECT * FROM decision ORDER BY id').all();
    expect(before.length).toBeGreaterThan(0);
    const indexes = () =>
      (
        old
          .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='decision' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
          .all() as { name: string }[]
      ).map((r) => r.name);
    const idx004 = indexes();
    const ins = old.prepare(
      `INSERT INTO decision (id, ts, kind, subject_type, subject_id, question_json, backend, answer_json, p, impact, policy_outcome, status) VALUES (?,'x',?,'role','r','{}','rule','{}',0.5,'medium',?,'pending')`,
    );
    expect(() => ins.run('tmp_fc', 'apply.fact_check', 'human')).toThrow(/CHECK/);
    old.exec(migration('005'));
    expect(old.prepare('SELECT * FROM decision ORDER BY id').all()).toEqual(before);
    expect(indexes()).toEqual(idx004);
    old.exec('SAVEPOINT s');
    for (const k of DECISION_KINDS) ins.run(`tmp_${k}`, k, 'human');
    expect(() => ins.run('tmp_bad', 'nope', 'human')).toThrow(/CHECK/);
    expect(() => ins.run('tmp_submit', 'apply.submit', 'auto')).toThrow(/CHECK/);
    old.exec('ROLLBACK TO s; RELEASE s');
    expect(old.pragma('foreign_key_check')).toEqual([]);
    expect(old.prepare('SELECT max(version) v FROM schema_migrations').get()).toEqual({ v: 5 });
    old.close();
  });
});
