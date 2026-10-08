import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appliedVersions, applyMigrations, listMigrations, MIGRATIONS_DIR, openDb } from './connection.js';
import { newId, roleId, slugify, ulid } from './ids.js';
import { repos } from './repo.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pp-db-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
