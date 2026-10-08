import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type OpOutput, ROLE_STATUSES, type RoleStatus } from '@perfect-placement/contracts';
import { appliedVersions, type Db, listMigrations, openDb } from './connection.js';
import { configPath, dbPath, findClaudeMdInParents, findGitRoot, parseMd, readConfig, vaultAbs } from './vault.js';

/*
 * system.doctor: read-only integrity checks over a PP_HOME.
 * Output matches OPS['system.doctor'].output. Lane B wires the op handler to `doctor()`.
 */

export type DoctorResult = OpOutput<'system.doctor'>;
type Check = DoctorResult['checks'][number];

export interface DoctorOptions {
  home: string;
  /** Directory whose parent chain is checked for CLAUDE.md (default process.cwd()). */
  cwd?: string;
  /** Use an already-open db instead of opening `<home>/pp.db`. */
  db?: Db;
}

/** Top-level vault folders whose markdown must be referenced by a db row. `files/` holds binaries and is not checked. */
const MD_ROOTS = ['profile', 'companies', 'roles', 'applications', 'interviews', 'outreach', 'runs'] as const;

/** Tables with a single md_path that must match the file's frontmatter id. */
const ID_LINKED: ReadonlyArray<{ table: string; col: string }> = [
  { table: 'role', col: 'md_path' },
  { table: 'company', col: 'md_path' },
  { table: 'outreach', col: 'md_path' },
  { table: 'run', col: 'log_path' },
];

function walkMd(home: string, rel: string, out: string[]): void {
  const abs = join(home, ...rel.split('/'));
  if (!existsSync(abs)) return;
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) walkMd(home, child, out);
    else if (e.name.endsWith('.md')) out.push(child);
  }
}

/** Every vault path the db references, with the id its frontmatter must carry (null = any id). */
export function referencedPaths(db: Db): Map<string, string | null> {
  const refs = new Map<string, string | null>();
  for (const { table, col } of ID_LINKED) {
    for (const r of db.prepare(`SELECT id, ${col} p FROM ${table} WHERE ${col} IS NOT NULL`).all() as { id: string; p: string }[])
      refs.set(r.p, r.id);
  }
  // Profile files are shared across versions; the frontmatter carries one component id.
  for (const r of db.prepare(`SELECT md_path p FROM profile_component WHERE md_path IS NOT NULL`).all() as { p: string }[])
    if (!refs.has(r.p)) refs.set(r.p, null);
  for (const r of db.prepare(`SELECT prep_path, retro_path FROM interview`).all() as {
    prep_path: string | null;
    retro_path: string | null;
  }[]) {
    if (r.prep_path && !refs.has(r.prep_path)) refs.set(r.prep_path, null);
    if (r.retro_path && !refs.has(r.retro_path)) refs.set(r.retro_path, null);
  }
  for (const r of db.prepare(`SELECT package_paths_json j FROM application`).all() as { j: string }[]) {
    for (const p of Object.values(JSON.parse(r.j) as Record<string, string>)) if (!refs.has(p)) refs.set(p, null);
  }
  return refs;
}

export function countsByStatus(db: Db): Record<RoleStatus, number> {
  const counts = Object.fromEntries(ROLE_STATUSES.map((s) => [s, 0])) as Record<RoleStatus, number>;
  for (const r of db.prepare(`SELECT status, count(*) n FROM role GROUP BY status`).all() as { status: RoleStatus; n: number }[])
    counts[r.status] = r.n;
  return counts;
}

export function doctor(opts: DoctorOptions): DoctorResult {
  const { home } = opts;
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
  const list = (xs: string[], n = 10) => (xs.length > n ? `${xs.slice(0, n).join(', ')} (+${xs.length - n} more)` : xs.join(', '));
  const empty = Object.fromEntries(ROLE_STATUSES.map((s) => [s, 0])) as Record<RoleStatus, number>;

  // Location checks first: they do not need a db.
  const git = findGitRoot(home);
  add('pp_home_not_in_git', git === null, git ? `PP_HOME is inside the git repo at ${git}` : undefined);
  const claude = findClaudeMdInParents(opts.cwd ?? process.cwd());
  add('no_claude_md', claude.length === 0, claude.length ? `CLAUDE.md disables AGENTS.md: ${claude.join(', ')}` : undefined);

  if (!existsSync(configPath(home))) add('config', false, 'config.json missing');
  else {
    try {
      readConfig(home);
      add('config', true);
    } catch (e) {
      add('config', false, `config.json invalid: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  if (!opts.db && !existsSync(dbPath(home))) {
    add('db_exists', false, `${dbPath(home)} not found`);
    return { ok: false, checks, counts: empty };
  }
  const db = opts.db ?? openDb(dbPath(home), { readonly: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    add('db_integrity', integrity === 'ok', integrity === 'ok' ? undefined : String(integrity));

    const fk = db.pragma('foreign_key_check') as unknown[];
    add('db_foreign_keys', fk.length === 0, fk.length ? `${fk.length} foreign key violations` : undefined);

    const applied = new Set(appliedVersions(db));
    const pending = listMigrations().filter((f) => !applied.has(Number(f.slice(0, 3))));
    add('db_migrations', pending.length === 0, pending.length ? `pending: ${pending.join(', ')}` : undefined);

    const refs = referencedPaths(db);
    const missing: string[] = [];
    const badId: string[] = [];
    for (const [rel, id] of refs) {
      let abs: string;
      try {
        abs = vaultAbs(home, rel);
      } catch {
        badId.push(`${rel} (not vault-relative)`);
        continue;
      }
      if (!existsSync(abs)) {
        missing.push(rel);
        continue;
      }
      if (!rel.endsWith('.md')) continue;
      const fm = parseMd(readFileSync(abs, 'utf8')).frontmatter;
      if (typeof fm.id !== 'string' || typeof fm.type !== 'string') badId.push(`${rel} (no frontmatter id/type)`);
      else if (id !== null && fm.id !== id) badId.push(`${rel} (frontmatter id ${fm.id} != ${id})`);
    }
    add('md_paths_exist', missing.length === 0, missing.length ? `${missing.length} missing: ${list(missing)}` : `${refs.size} paths`);
    add('md_frontmatter', badId.length === 0, badId.length ? list(badId) : undefined);

    const onDisk: string[] = [];
    for (const r of MD_ROOTS) walkMd(home, r, onDisk);
    const orphans = onDisk.filter((p) => !refs.has(p));
    add('no_orphan_files', orphans.length === 0, orphans.length ? `${orphans.length} unreferenced: ${list(orphans)}` : undefined);

    const counts = countsByStatus(db);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    add(
      'counts',
      true,
      `${total} roles: ${ROLE_STATUSES.filter((s) => counts[s])
        .map((s) => `${s} ${counts[s]}`)
        .join(', ')}`,
    );

    return { ok: checks.every((c) => c.ok), checks, counts };
  } finally {
    if (!opts.db) db.close();
  }
}
