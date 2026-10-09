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

/**
 * The fixture seed for a db before 009 (#98): contact links without `path` / `via_tie_json`; outreach
 * without `about_contact_id`, the bridge intro filed under its target as it was before.
 */
const seedBefore009 = () =>
  readFileSync(FIXTURE_SEED_SQL, 'utf8')
    .replace(
      /^(INSERT INTO contact_link \([^)]*?), path, via_tie_json\) VALUES (.*), (?:NULL|'[^']*'), (?:NULL|'[^']*')\);$/gm,
      '$1) VALUES $2);',
    )
    .replace(
      /^INSERT INTO outreach \(([^)]*?), about_contact_id\) VALUES \('([^']*)', '([^']*)', (.*), (?:NULL|'([^']*)')\);$/gm,
      (_l, cols: string, id: string, recipient: string, rest: string, about?: string) =>
        `INSERT INTO outreach (${cols}) VALUES ('${id}', '${about ?? recipient}', ${rest});`,
    );

/** The fixture seed for a db before 008: no Ask threads (#69). */
const seedBefore008 = () => seedBefore009().replace(/^INSERT INTO ask_thread .*$/gm, '');

/** The fixture seed for a db before 007: onboarding sessions without `interview_json` (#22). */
const seedBefore007 = () =>
  seedBefore008().replace(/^(INSERT INTO onboard_session \([^)]*?), interview_json\) VALUES (.*), '[^']*'\);$/gm, '$1) VALUES $2);');

/** The fixture seed for a db before 006: contact rows without `email_source` / `email_confidence` (#37). */
const seedBefore006 = () =>
  seedBefore007().replace(
    /^(INSERT INTO contact \([^)]*?), email_source, email_confidence\) VALUES (.*), (?:NULL|'[a-z]+'), (?:NULL|[0-9.]+)\);$/gm,
    '$1) VALUES $2);',
  );

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
    old.exec(seedBefore006());
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
    old.exec(seedBefore006());
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
    old.exec(seedBefore006());
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
    for (const k of DECISION_KINDS.filter((x) => x !== 'people.email')) ins.run(`tmp_${k}`, k, 'human');
    expect(() => ins.run('tmp_bad', 'nope', 'human')).toThrow(/CHECK/);
    expect(() => ins.run('tmp_submit', 'apply.submit', 'auto')).toThrow(/CHECK/);
    old.exec('ROLLBACK TO s; RELEASE s');
    expect(old.pragma('foreign_key_check')).toEqual([]);
    expect(old.prepare('SELECT max(version) v FROM schema_migrations').get()).toEqual({ v: 5 });
    old.close();
  });
});

describe('migration 006 (contact email source + confidence, decision kind people.email, #37)', () => {
  it('adds the columns, backfills known addresses, keeps every decision and accepts people.email', () => {
    const db5 = new Database(':memory:');
    for (const v of ['001', '002', '003', '004', '005']) db5.exec(migration(v));
    const addContact = db5.prepare(
      `INSERT INTO contact (id, name, headline, linkedin_url, email, source, notes) VALUES (?, ?, NULL, NULL, ?, ?, NULL)`,
    );
    addContact.run('ct_a', 'Ann Example', 'ann@example.com', 'jd');
    addContact.run('ct_b', 'Bo Example', 'bo@example.com', 'gmail');
    addContact.run('ct_c', 'Cy Example', null, 'linkedin');
    db5
      .prepare(
        `INSERT INTO decision (id, ts, kind, subject_type, subject_id, question_json, backend, answer_json, p, impact, policy_outcome, status) VALUES ('dc_keep','x','people.classify','contact','ct_a','{}','rule','{}',0.5,'low','human','pending')`,
      )
      .run();
    const before = db5.prepare('SELECT * FROM decision ORDER BY id').all();
    const ins = db5.prepare(
      `INSERT INTO decision (id, ts, kind, subject_type, subject_id, question_json, backend, answer_json, p, impact, policy_outcome, status) VALUES (?,'x',?,'contact','ct_a','{}','rule','{}',0.5,'medium',?,'pending')`,
    );
    expect(() => ins.run('tmp_pe', 'people.email', 'human')).toThrow(/CHECK/);
    db5.exec(migration('006'));
    expect(db5.prepare('SELECT * FROM decision ORDER BY id').all()).toEqual(before);
    expect(db5.prepare('SELECT id, email_source, email_confidence FROM contact ORDER BY id').all()).toEqual([
      { id: 'ct_a', email_source: 'public', email_confidence: 0.9 },
      { id: 'ct_b', email_source: 'gmail', email_confidence: 1 },
      { id: 'ct_c', email_source: null, email_confidence: null },
    ]);
    db5.exec('SAVEPOINT s');
    for (const k of DECISION_KINDS) ins.run(`tmp_${k}`, k, 'human');
    expect(() => db5.exec(`UPDATE contact SET email_source = 'guess' WHERE id = 'ct_a'`)).toThrow(/CHECK/);
    expect(() => db5.exec(`UPDATE contact SET email_confidence = 1.5 WHERE id = 'ct_a'`)).toThrow(/CHECK/);
    db5.exec('ROLLBACK TO s; RELEASE s');
    expect(db5.pragma('foreign_key_check')).toEqual([]);
    expect(db5.prepare('SELECT max(version) v FROM schema_migrations').get()).toEqual({ v: 6 });
    db5.close();
  });
});

describe('migration 007 (onboard_session interview plan, #22)', () => {
  it('adds interview_json with an empty plan and keeps every session', () => {
    const db6 = new Database(':memory:');
    for (const v of ['001', '002', '003', '004', '005', '006']) db6.exec(migration(v));
    db6.exec(seedBefore007());
    const before = db6.prepare('SELECT * FROM onboard_session ORDER BY id').all() as Record<string, unknown>[];
    expect(before.length).toBeGreaterThan(0);
    db6.exec(migration('007'));
    expect(db6.prepare('SELECT * FROM onboard_session ORDER BY id').all()).toEqual(before.map((r) => ({ ...r, interview_json: '{}' })));
    expect(db6.pragma('foreign_key_check')).toEqual([]);
    expect(db6.prepare('SELECT max(version) v FROM schema_migrations').get()).toEqual({ v: 7 });
    db6.close();
  });
});

describe('migration 008 (ask_thread, #69)', () => {
  it('adds ask_thread empty, keeps every other row, and checks the runner', () => {
    const db7 = new Database(':memory:');
    for (const v of ['001', '002', '003', '004', '005', '006', '007']) db7.exec(migration(v));
    db7.exec(seedBefore008());
    const before = db7.prepare('SELECT * FROM onboard_session ORDER BY id').all();
    db7.exec(migration('008'));
    expect(db7.prepare('SELECT * FROM onboard_session ORDER BY id').all()).toEqual(before);
    expect(db7.prepare('SELECT count(*) n FROM ask_thread').get()).toEqual({ n: 0 });
    const ins = db7.prepare(`INSERT INTO ask_thread (id, created_at, updated_at, runner) VALUES (?, 'x', 'x', ?)`);
    expect(() => ins.run('ask_a', 'claude')).not.toThrow();
    expect(() => ins.run('ask_b', 'gpt')).toThrow(/CHECK/);
    expect(db7.prepare(`SELECT turns_json, session_id FROM ask_thread WHERE id = 'ask_a'`).get()).toEqual({
      turns_json: '[]',
      session_id: null,
    });
    expect(db7.prepare('SELECT max(version) v FROM schema_migrations').get()).toEqual({ v: 8 });
    db7.close();
  });
});

describe('migration 009 (connect path, #98)', () => {
  it('adds path and via_tie_json to contact_link, null on every existing link, and checks the path', () => {
    const db8 = new Database(':memory:');
    for (const v of ['001', '002', '003', '004', '005', '006', '007']) db8.exec(migration(v));
    db8.exec(seedBefore008());
    db8.exec(migration('008'));
    const before = db8.prepare('SELECT * FROM contact_link ORDER BY id').all() as Record<string, unknown>[];
    expect(before.length).toBeGreaterThan(0);
    expect(db8.prepare(`SELECT contact_id FROM outreach WHERE id = 'or_0002'`).get()).toEqual({ contact_id: 'ct_0003' });
    db8.exec(migration('009'));
    expect(db8.prepare('SELECT * FROM contact_link ORDER BY id').all()).toEqual(
      before.map((r) => ({ ...r, path: null, via_tie_json: null })),
    );
    // The bridge intro filed under its target (Lina K.) is refiled under the mutual (Dev P.), about Lina.
    expect(db8.prepare(`SELECT contact_id, about_contact_id FROM outreach WHERE id = 'or_0002'`).get()).toEqual({
      contact_id: 'ct_0002',
      about_contact_id: 'ct_0003',
    });
    expect(db8.prepare(`SELECT count(*) n FROM outreach WHERE about_contact_id IS NOT NULL`).get()).toEqual({ n: 1 });
    expect(db8.pragma('foreign_key_check')).toEqual([]);
    const upd = db8.prepare('UPDATE contact_link SET path = ? WHERE id = ?');
    const id = before[0]?.id as string;
    expect(() => upd.run('direct', id)).not.toThrow();
    expect(() => upd.run('bridge', id)).not.toThrow();
    expect(() => upd.run('email', id)).toThrow(/CHECK/);
    expect(db8.prepare('SELECT max(version) v FROM schema_migrations').get()).toEqual({ v: 9 });
    db8.close();
  });
});
