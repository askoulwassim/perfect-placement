import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROFILE_COMPONENT_KEYS, TABLES, type TableName } from '@perfect-placement/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../connection.js';
import { doctor } from '../doctor.js';
import { hydrate } from '../repo.js';
import { SYNTHETIC_V1, writeSyntheticV1 } from '../testing/synthetic-v1.js';
import { dbPath, readMd } from '../vault.js';
import { migrateV1, planV1Import } from './import.js';

let tmp: string;
let from: string;
let home: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pp-v1-'));
  from = join(tmp, 'v1');
  home = join(tmp, 'home');
  writeSyntheticV1(from);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function snapshot(file: string): Record<string, unknown[]> {
  const db = openDb(file, { readonly: true });
  try {
    return Object.fromEntries(Object.keys(TABLES).map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()])) as Record<
      string,
      unknown[]
    >;
  } finally {
    db.close();
  }
}

describe('pp migrate (v1 importer)', () => {
  it('reproduces v1 counts, ids and inferred archive reasons', () => {
    const r = migrateV1({ from, home });
    expect(r.countsMatch).toBe(true);
    expect(r.planned).toMatchObject({ active: 1, 'on-deck': 1, applied: 1, archived: 5 });
    expect(r.dbCounts).toEqual(r.planned);
    const db = openDb(dbPath(home));
    for (const [v1, exp] of Object.entries(SYNTHETIC_V1.expected)) {
      const row = db.prepare(`SELECT * FROM role WHERE json_extract(flags_json, '$.v1_id') = ?`).get(v1) as Record<string, unknown>;
      expect(row?.id, v1).toBe(exp.id);
      expect(row.status, v1).toBe(exp.status);
      expect(row.archive_reason, v1).toBe(exp.reason);
      expect(row.source).toBe('migration');
    }
    const globex = hydrate('role', db.prepare(`SELECT * FROM role WHERE id = 'globex_pm-ai'`).get() as Record<string, unknown>);
    expect(globex.flags_json.dream_company).toBe(true);
    expect(globex.remote_ok).toBe(false);
    expect(globex.workplace).toBe('hybrid');
    const acme = db.prepare(`SELECT * FROM company WHERE id = 'acme-data'`).get() as Record<string, unknown>;
    expect(acme).toMatchObject({ ats_type: 'greenhouse', ats_board: 'acmedata', name: 'Acme Data' });
    const closed = db.prepare(`SELECT freshness FROM role WHERE id = 'initech_staff-pm-old'`).get() as { freshness: string };
    expect(closed.freshness).toBe('closed');
    db.close();
    expect(r.warnings.some((w) => w.includes('zzz-corp_orphan-role'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('duplicate url'))).toBe(true);
    expect(r.fileMatches).toEqual({ file_field: 1, id: 5, fuzzy: 1, none: 1 });
  });

  it('preserves every score record, including rescore history', () => {
    const r = migrateV1({ from, home });
    expect(r.scores).toEqual({ v1: SYNTHETIC_V1.scores.length, planned: SYNTHETIC_V1.scores.length });
    const db = openDb(dbPath(home));
    const hist = db
      .prepare(`SELECT total, band, c4, created_at FROM score WHERE role_id = 'acme-data_staff-pm-platform' ORDER BY created_at`)
      .all();
    expect(hist).toEqual([
      { total: 70, band: 'yellow', c4: 4, created_at: '2026-01-05T00:00:00.000Z' },
      { total: 82, band: 'green', c4: 5, created_at: '2026-01-09T00:00:00.000Z' },
    ]);
    for (const raw of db.prepare('SELECT * FROM score').all() as Record<string, unknown>[]) {
      expect(TABLES.score.safeParse(hydrate('score', raw)).success).toBe(true);
    }
    db.close();
  });

  it('imports applications, dossiers, runs, profile and binaries into the vault', () => {
    migrateV1({ from, home });
    const db = openDb(dbPath(home));
    const app = hydrate('application', db.prepare(`SELECT * FROM application`).get() as Record<string, unknown>);
    expect(app).toMatchObject({
      role_id: 'globex_pm-ai',
      stage: 'done',
      applied_at: '2026-01-07T00:00:00.000Z',
      portal_url: 'https://jobs.ashbyhq.com/globex/xyz/application',
    });
    expect(app.package_paths_json).toMatchObject({
      dossier: 'companies/globex/dossier.md',
      resume: 'applications/globex_pm-ai/resume.md',
      answers: 'applications/globex_pm-ai/answers.md',
      resume_docx: 'files/globex_pm-ai/resume.docx',
    });
    expect(readFileSync(join(home, 'files/globex_pm-ai/resume.docx'), 'utf8')).toBe('synthetic-docx-bytes');
    expect(readMd(home, 'companies/globex/dossier.md').frontmatter).toEqual({ id: 'globex', type: 'dossier' });
    const roleMd = readMd(home, 'roles/globex_manager-data-engineering.md');
    expect(roleMd.frontmatter).toEqual({ id: 'globex_manager-data-engineering', type: 'role' });
    expect(roleMd.body).toContain('Manager, Data Engineering');
    expect(readMd(home, 'roles/umbrella_head-of-product.md').body).toContain('without a role file');

    const runs = db.prepare(`SELECT op FROM run ORDER BY started_at`).all() as { op: string }[];
    expect(runs.map((r) => r.op)).toEqual(['roles.add', 'roles.score', 'migrate']);

    const comps = db.prepare(`SELECT key, kind, md_path, data_json FROM profile_component`).all() as Record<string, string>[];
    expect(comps.map((c) => c.key).sort()).toEqual([...PROFILE_COMPONENT_KEYS].sort());
    expect(readMd(home, 'profile/story.md').body).toContain('Synthetic STAR story');
    expect(readMd(home, 'profile/voice.md').body).toContain('Synthetic hook');
    const terms = JSON.parse(comps.find((c) => c.key === 'terms')?.data_json as string);
    expect(terms).toMatchObject({ stub: 'v1', comp_floor: 150000 });
    db.close();
  });

  it('is idempotent: a rerun changes nothing', () => {
    migrateV1({ from, home });
    const before = snapshot(dbPath(home));
    const again = migrateV1({ from, home });
    expect(Object.values(again.inserted).reduce((a, b) => (a ?? 0) + (b ?? 0), 0)).toBe(0);
    expect(again.filesWritten).toBe(0);
    expect(again.runId).toBeNull();
    expect(snapshot(dbPath(home))).toEqual(before);
  });

  it('leaves the vault doctor-green', () => {
    migrateV1({ from, home });
    const res = doctor({ home, cwd: tmp });
    expect(res.checks.filter((c) => !c.ok)).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.counts.archived).toBe(5);
  });

  it('dry run writes nothing', () => {
    const r = migrateV1({ from, home, dryRun: true });
    expect(r.countsMatch).toBe(true);
    expect(r.inserted.role).toBe(8);
    expect(existsSync(home)).toBe(false);
  });

  it('never writes into a git repo or the v1 source', () => {
    const repo = join(tmp, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    expect(() => migrateV1({ from, home: join(repo, 'vault') })).toThrow(/inside the git repo/);
    const plan = planV1Import(from);
    for (const f of plan.files) expect(f.rel.startsWith('/')).toBe(false);
  });

  it('keeps existing vault rows untouched (insert-if-absent)', () => {
    migrateV1({ from, home });
    const db = openDb(dbPath(home));
    db.prepare(`UPDATE role SET status = 'draft-ready', updated_at = '2026-02-01T00:00:00.000Z' WHERE id = 'acme-data_principal-pm'`).run();
    db.close();
    writeFileSync(join(home, 'roles/acme-data_principal-pm.md'), '---\nid: "acme-data_principal-pm"\ntype: "role"\n---\n\nEdited.\n');
    migrateV1({ from, home });
    const db2 = openDb(dbPath(home));
    expect((db2.prepare(`SELECT status FROM role WHERE id = 'acme-data_principal-pm'`).get() as { status: string }).status).toBe(
      'draft-ready',
    );
    db2.close();
    expect(readMd(home, 'roles/acme-data_principal-pm.md').body).toBe('Edited.\n');
  });
});

describe('row validity', () => {
  it('every imported row parses against its contract schema', () => {
    migrateV1({ from, home });
    const db = openDb(dbPath(home));
    for (const t of Object.keys(TABLES) as TableName[]) {
      for (const raw of db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[]) {
        const p = TABLES[t].safeParse(hydrate(t, raw));
        expect(p.success, `${t} ${raw.id}: ${p.error?.message}`).toBe(true);
      }
    }
    db.close();
  });
});
