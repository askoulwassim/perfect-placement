import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type APPLICATION_FILES,
  type ArchiveReason,
  DREAM_AFFINITY,
  type Frontmatter,
  PROFILE_COMPONENT_KEYS,
  PROFILE_COMPONENT_KIND,
  ROLE_STATUSES,
  type RoleStatus,
  type TableName,
  vaultPath,
} from '@perfect-placement/contracts';
import { convertV1Profile, V1_FILES, type V1Inputs, type V1Source } from '../../profile/convert-v1.js';
import { type Db, openDb } from '../connection.js';
import { countsByStatus } from '../doctor.js';
import { newId, nowIso, roleId, slugify } from '../ids.js';
import { type Row, repos } from '../repo.js';
import { dbPath, findGitRoot, initVault, vaultAbs, writeMd } from '../vault.js';
import {
  atsFromUrl,
  dayIso,
  dayMs,
  flagKey,
  GREEN_ARCHIVED_BASIS,
  inferArchiveReason,
  intOrNull,
  isDate,
  mapFacing,
  mapRemoteOk,
  mapWorkplace,
  matchRoleFiles,
  normId,
  parseRoleFileName,
  runOp,
  type V1Role,
  type V1RoleFile,
  type V1Score,
  validUrl,
} from './map.js';

/** v1 `00_System/rubric.json` (only the keys the importer reads). */
interface V1Rubric {
  version?: string;
  updated?: string;
  weights?: Record<string, number>;
  criteria?: Record<string, string>;
  bands?: Record<string, unknown>;
  dream_companies?: string[];
  [k: string]: unknown;
}

/*
 * `pp migrate --from <v1 repo>`: import a v1 Perfect Placement folder into a PP_HOME vault + pp.db.
 * Two phases: `planV1Import` reads v1 (read-only) and builds every row and file deterministically;
 * `applyPlan` inserts rows that are absent and writes files that are absent. Rerunning changes nothing.
 */

const V1_STATUS_FOLDERS = ['inbox', 'active', 'on-deck', 'draft-ready', 'applied', 'interviews', 'offers', 'archive'] as const;
const FUNNEL_DONE: ReadonlySet<string> = new Set(['applied', 'interviews', 'offers']);

export type PlannedFile = { rel: string; kind: 'md'; fm: Frontmatter; body: string } | { rel: string; kind: 'copy'; src: string };

type Rows = { [T in TableName]?: Row<T>[] };

export interface V1Plan {
  from: string;
  rows: Rows;
  files: PlannedFile[];
  warnings: string[];
  /** v1 meta.counts as recorded in pipeline.json. */
  v1Counts: Record<string, number>;
  /** Role counts by status the plan produces. */
  counts: Record<RoleStatus, number>;
  archiveReasons: Record<string, number>;
  fileMatches: { file_field: number; id: number; fuzzy: number; none: number };
  /** v1 role id -> v2 role id. */
  idMap: Map<string, string>;
  /** Score records in v1 scores.json. */
  v1ScoreCount: number;
}

export interface ApplyResult {
  inserted: Partial<Record<TableName, number>>;
  skipped: Partial<Record<TableName, number>>;
  filesWritten: number;
  filesSkipped: number;
  runId: string | null;
}

export interface MigrateV1Report extends ApplyResult {
  from: string;
  home: string;
  dryRun: boolean;
  v1Counts: Record<string, number>;
  planned: Record<RoleStatus, number>;
  /** Role counts in the db after the import (all roles, not only migrated ones). */
  dbCounts: Record<RoleStatus, number>;
  countsMatch: boolean;
  archiveReasons: Record<string, number>;
  fileMatches: V1Plan['fileMatches'];
  scores: { v1: number; planned: number };
  warnings: string[];
}

function readJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null;
}

const readText = (path: string): string | null => (existsSync(path) ? readFileSync(path, 'utf8') : null);
const listDir = (path: string): string[] => (existsSync(path) ? readdirSync(path).sort() : []);
const isDir = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();

/** Read v1 (never writes) and build the full import plan. */
export function planV1Import(from: string): V1Plan {
  const warnings: string[] = [];
  const pipeline = readJson<{ meta?: { counts?: Record<string, number>; generated?: string }; roles: V1Role[] }>(
    join(from, '02_Pipeline/data/pipeline.json'),
  );
  if (!pipeline) throw new Error(`${from}: 02_Pipeline/data/pipeline.json not found (is this a v1 Perfect Placement repo?)`);
  const scoresDoc = readJson<{ meta?: Record<string, unknown>; scores: V1Score[] }>(join(from, '02_Pipeline/data/scores.json'));
  const rubric = readJson<V1Rubric>(join(from, '00_System/rubric.json'));
  const greenMin = Number((rubric?.bands as { green_min?: number } | undefined)?.green_min ?? 75);
  const fallbackDate = isDate(pipeline.meta?.generated) ? pipeline.meta.generated : '2000-01-01';

  // --- role files -----------------------------------------------------------
  const roleFiles: V1RoleFile[] = [];
  for (const folder of V1_STATUS_FOLDERS) {
    for (const name of listDir(join(from, '02_Pipeline', folder))) {
      if (!name.endsWith('.md') || name.startsWith('_')) continue;
      const p = parseRoleFileName(folder, name);
      if (!p) {
        warnings.push(`role file with an unexpected name skipped: 02_Pipeline/${folder}/${name}`);
        continue;
      }
      roleFiles.push({ ...p, path: `02_Pipeline/${folder}/${name}` });
    }
  }
  const v1Roles = pipeline.roles;
  const match = matchRoleFiles(v1Roles, roleFiles);
  for (const f of match.unmatchedFiles) warnings.push(`role file matches no pipeline.json role, not imported: ${f.path}`);

  // --- scores (all history, grouped per v1 id) ------------------------------
  const v1Scores = scoresDoc?.scores ?? [];
  const scoresByRole = new Map<string, V1Score[]>();
  for (const s of v1Scores) {
    const k = normId(s.id);
    scoresByRole.set(k, [...(scoresByRole.get(k) ?? []), s]);
  }
  for (const list of scoresByRole.values()) list.sort((a, b) => String(a.scored ?? '').localeCompare(String(b.scored ?? '')));

  // --- companies ------------------------------------------------------------
  const coSlugByName = new Map<string, string>();
  for (const r of v1Roles) {
    const f = match.byRole.get(r.id);
    if (f && !coSlugByName.has(r.company)) coSlugByName.set(r.company, slugify(f.companySlug) || 'unknown');
  }
  for (const r of v1Roles) if (!coSlugByName.has(r.company)) coSlugByName.set(r.company, slugify(r.company) || 'unknown');
  const companies = new Map<string, Row<'company'>>();
  for (const r of v1Roles) {
    const slug = coSlugByName.get(r.company) as string;
    const url = validUrl(r.url);
    const ats = atsFromUrl(url);
    const cur = companies.get(slug);
    if (!cur)
      companies.set(slug, {
        id: slug,
        slug,
        name: r.company,
        domain: null,
        ats_type: ats.type,
        ats_board: ats.board,
        affinity: 0,
        md_path: null,
      });
    else if (cur.ats_type === 'unknown' || (cur.ats_type === 'other' && ats.type !== 'unknown')) {
      cur.ats_type = ats.type;
      cur.ats_board = ats.board;
    }
  }

  // Dream companies get the default affinity nudge (wave1-decisions #10; capped, no dealbreaker bypass).
  const dream = new Set((rubric?.dream_companies ?? []).map((d) => slugify(d)));
  for (const c of companies.values()) if (dream.has(c.slug) || dream.has(slugify(c.name))) c.affinity = DREAM_AFFINITY;

  // --- roles ----------------------------------------------------------------
  const roles: Row<'role'>[] = [];
  const events: Row<'event'>[] = [];
  const scores: Row<'score'>[] = [];
  const files: PlannedFile[] = [];
  const idMap = new Map<string, string>();
  const taken = new Set<string>();
  const seenUrls = new Set<string>();
  const archiveReasons: Record<string, number> = {};
  const rubricSnapshot = {
    source: 'v1',
    version: (scoresDoc?.meta?.rubric_version as string | undefined) ?? rubric?.version ?? 'v1',
    weights: (scoresDoc?.meta?.weights as Record<string, number> | undefined) ?? rubric?.weights ?? {},
    criteria: (scoresDoc?.meta?.criteria as Record<string, string> | undefined) ?? rubric?.criteria ?? {},
    bands: rubric?.bands ?? scoresDoc?.meta?.bands ?? {},
  };

  for (const r of v1Roles) {
    if (!(ROLE_STATUSES as readonly string[]).includes(r.status)) {
      warnings.push(`role ${r.id}: unknown v1 status "${r.status}", skipped`);
      continue;
    }
    const status = r.status as RoleStatus;
    const f = match.byRole.get(r.id);
    const co = coSlugByName.get(r.company) as string;
    const nid = normId(r.id);
    const titleSlug = slugify(f?.titleSlug ?? (nid.startsWith(`${co}-`) ? nid.slice(co.length + 1) : r.role)) || 'role';
    const id = roleId(co, titleSlug, (x) => taken.has(x));
    taken.add(id);
    idMap.set(r.id, id);

    const history = scoresByRole.get(nid) ?? [];
    const latest = history.at(-1);
    const foundDate = f?.date ?? history.find((s) => isDate(s.scored))?.scored ?? fallbackDate;
    const dates = [foundDate, ...history.map((s) => s.scored).filter(isDate), ...(isDate(r.applied_date) ? [r.applied_date] : [])].sort();
    const found_at = dayIso(foundDate);

    let url = validUrl(r.url);
    const flags: Record<string, unknown> = { v1_id: r.id };
    if (url && seenUrls.has(url)) {
      warnings.push(`role ${r.id}: duplicate url, stored in flags only`);
      flags.duplicate_url = true;
      url = null;
    }
    if (url) seenUrls.add(url);
    for (const fl of Array.isArray(r.flags) ? (r.flags as unknown[]) : []) flags[flagKey(String(fl))] = true;
    const { id: _i, company: _c, role: _r, status: _s, ...rest } = r;
    flags.v1 = rest;
    if (f) flags.v1_file = f.path;

    let archive_reason: ArchiveReason | null = null;
    if (status === 'archived') {
      const inf = inferArchiveReason(r, latest, greenMin);
      archive_reason = inf.reason;
      flags.archive_basis = inf.basis;
      // wave1-decisions #20: a green score v1 archived without confirmed remote stays archived as a
      // dealbreaker, tagged so the approved v2 rescore can revisit it.
      if (inf.reason === 'dealbreaker' && inf.basis === GREEN_ARCHIVED_BASIS && mapRemoteOk(r.remote_ok) !== true)
        flags.verify_remote = true;
      archiveReasons[inf.reason] = (archiveReasons[inf.reason] ?? 0) + 1;
    }
    const comp_min = intOrNull(r.comp_min);
    const comp_max = intOrNull(r.comp_max);
    const md_path = vaultPath.role(id);
    roles.push({
      id,
      company_id: co,
      title: r.role,
      url,
      ats_job_id: r.job_id === undefined || r.job_id === null ? null : String(r.job_id),
      source: 'migration',
      found_at,
      posted_at: null,
      workplace: mapWorkplace(r.workplace),
      remote_ok: mapRemoteOk(r.remote_ok),
      location: null,
      comp_min,
      comp_max,
      comp_currency: comp_min !== null || comp_max !== null ? 'USD' : null,
      facing: mapFacing(r.facing),
      seniority: null,
      status,
      archive_reason,
      held_reason: null,
      last_checked_at: null,
      freshness: archive_reason === 'closed' ? 'closed' : 'unknown',
      flags_json: flags,
      md_path,
      created_at: found_at,
      updated_at: dayIso(dates.at(-1) as string),
    });
    events.push({
      id: newId('event', dayMs(foundDate), `v1:role_added:${id}`),
      ts: found_at,
      type: 'role_added',
      subject_type: 'role',
      subject_id: id,
      payload_json: { source: 'migration', v1_id: r.id },
      actor: 'human',
      decision_id: null,
    });

    const body = f ? (readText(join(from, f.path)) ?? '') : `# ${r.role}, ${r.company}\n\nMigrated from v1 without a role file.`;
    files.push({ rel: md_path, kind: 'md', fm: { id, type: 'role' }, body });

    history.forEach((s, i) => {
      const crit = CRITERIA_V1.map((c) => s.criteria?.[c]);
      if (crit.some((v) => !Number.isInteger(v) || (v as number) < 1 || (v as number) > 5)) {
        warnings.push(`score ${s.id}#${i}: criteria out of range, skipped`);
        return;
      }
      const date = isDate(s.scored) ? s.scored : foundDate;
      const decision = s.decision === 'active' || s.decision === 'held' ? s.decision : 'archived';
      const band = s.band === 'green' || s.band === 'yellow' || s.band === 'red' ? s.band : 'red';
      const scoreId = newId('score', dayMs(date), `v1:score:${r.id}:${i}:${date}:${s.total}`);
      const [c1, c2, c3, c4, c5, c6, c7, c8, c9] = crit as number[];
      scores.push({
        id: scoreId,
        role_id: id,
        profile_version_id: null,
        rubric_json: { ...rubricSnapshot, version: s.rubric_version ?? rubricSnapshot.version },
        c1: c1 as number,
        c2: c2 as number,
        c3: c3 as number,
        c4: c4 as number,
        c5: c5 as number,
        c6: c6 as number,
        c7: c7 as number,
        c8: c8 as number,
        c9: c9 as number,
        affinity_mod: 0,
        total: s.total,
        band,
        decision,
        facts_json: { source: 'v1', v1_id: s.id },
        created_at: dayIso(date),
      });
      events.push({
        id: newId('event', dayMs(date), `v1:role_scored:${scoreId}`),
        ts: dayIso(date),
        type: 'role_scored',
        subject_type: 'role',
        subject_id: id,
        payload_json: { source: 'migration', score_id: scoreId, total: s.total, band, decision },
        actor: 'human',
        decision_id: null,
      });
    });
  }
  const roleV1Ids = new Set(v1Roles.map((r) => normId(r.id)));
  for (const s of v1Scores) if (!roleV1Ids.has(normId(s.id))) warnings.push(`score for unknown role ${s.id}, skipped`);

  // --- 03_Applications: dossiers + packages ---------------------------------
  const applications: Row<'application'>[] = [];
  const appsRoot = join(from, '03_Applications');
  const roleById = new Map(roles.map((r) => [r.id, r]));
  const v1ById = new Map(v1Roles.map((r) => [r.id, r]));
  for (const folder of listDir(appsRoot)) {
    if (!isDir(join(appsRoot, folder)) || folder.startsWith('.') || folder.startsWith('_')) continue;
    const coId =
      companies.get(folder)?.id ?? [...companies.values()].find((c) => slugify(c.name) === folder || c.id === slugify(folder))?.id ?? null;
    let company = coId ? companies.get(coId) : undefined;
    const dossierSrc = join(appsRoot, folder, 'company_dossier.md');
    if (!company && existsSync(dossierSrc)) {
      const slug = slugify(folder);
      company = { id: slug, slug, name: folder, domain: null, ats_type: 'unknown', ats_board: null, affinity: 0, md_path: null };
      companies.set(slug, company);
      warnings.push(`03_Applications/${folder}: no pipeline company matches, created company ${slug}`);
    }
    if (company && existsSync(dossierSrc)) {
      company.md_path = vaultPath.dossier(company.slug);
      files.push({ rel: company.md_path, kind: 'md', fm: { id: company.id, type: 'dossier' }, body: readText(dossierSrc) ?? '' });
    }
    for (const pkg of listDir(join(appsRoot, folder))) {
      const pkgDir = join(appsRoot, folder, pkg);
      if (!isDir(pkgDir) || pkg.startsWith('.')) continue;
      const m = /^(\d{4}-\d{2}-\d{2})_(.+)$/.exec(pkg);
      const date = m?.[1] ?? fallbackDate;
      const slug = m?.[2] ?? pkg;
      const role = company ? findPackageRole(company.id, folder, slug, roles, idMap) : undefined;
      if (!role) {
        warnings.push(`03_Applications/${folder}/${pkg}: no role matches, not imported`);
        continue;
      }
      const v1 = [...idMap.entries()].find(([, v]) => v === role.id)?.[0];
      const v1r = v1 ? v1ById.get(v1) : undefined;
      const appId = newId('application', dayMs(date), `v1:application:${role.id}`);
      if (applications.some((a) => a.role_id === role.id)) {
        warnings.push(`03_Applications/${folder}/${pkg}: second package for ${role.id}, not imported`);
        continue;
      }
      const paths: Record<string, string> = {};
      if (company?.md_path) paths.dossier = company.md_path;
      for (const name of listDir(pkgDir)) {
        if (name.startsWith('.')) continue;
        const src = join(pkgDir, name);
        if (!statSync(src).isFile()) continue;
        const kind = APP_MD_KIND[name];
        if (kind) {
          const rel = vaultPath.application(role.id, kind);
          paths[kind] = rel;
          files.push({ rel, kind: 'md', fm: { id: `${appId}-${kind}`, type: APP_MD_TYPE[kind] }, body: readText(src) ?? '' });
        } else {
          const rel = vaultPath.file(`${role.id}/${name}`);
          paths[name.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()] = rel;
          files.push({ rel, kind: 'copy', src });
        }
      }
      const done = FUNNEL_DONE.has(role.status);
      const stage = done ? 'done' : paths.answers ? 'fill' : paths.resume || paths.cover_letter ? 'tailor' : 'research';
      applications.push({
        id: appId,
        role_id: role.id,
        stage,
        applied_at: done && isDate(v1r?.applied_date) ? dayIso(v1r.applied_date) : null,
        portal_url: validUrl(v1r?.url_portal) ?? roleById.get(role.id)?.url ?? null,
        package_paths_json: paths,
      });
    }
  }

  // --- runs -----------------------------------------------------------------
  const runs: Row<'run'>[] = [];
  for (const name of listDir(join(from, '02_Pipeline/runs'))) {
    const m = /^(\d{4}-\d{2}-\d{2})_(.+)\.md$/.exec(name);
    if (!m) continue;
    const date = m[1] as string;
    const id = newId('run', dayMs(date), `v1:run:${name}`);
    const rel = `runs/${name}`;
    runs.push({
      id,
      op: runOp(m[2] as string),
      started_at: dayIso(date),
      finished_at: dayIso(date),
      status: 'ok',
      summary_json: { source: 'v1', v1_file: `02_Pipeline/runs/${name}` },
      log_path: rel,
    });
    files.push({ rel, kind: 'md', fm: { id, type: 'run' }, body: readText(join(from, '02_Pipeline/runs', name)) ?? '' });
  }

  // --- profile (lane E converter) -------------------------------------------
  const profileVersions: Row<'profile_version'>[] = [];
  const components: Row<'profile_component'>[] = [];
  const inputs: V1Inputs = {};
  for (const [k, rel] of Object.entries(V1_FILES) as Array<[V1Source, string]>) {
    const text = readText(join(from, rel));
    if (text !== null) inputs[k] = text;
  }
  if (Object.keys(inputs).length) {
    const pDate = isDate(rubric?.updated) ? rubric.updated : fallbackDate;
    const conv = convertV1Profile(inputs, new Date(dayMs(pDate)));
    const pv = newId('profile_version', dayMs(pDate), 'v1:profile_version');
    profileVersions.push({ id: pv, created_at: dayIso(pDate), parent_id: null, reason: conv.version_reason, event_id: null });
    for (const key of PROFILE_COMPONENT_KEYS) {
      const c = conv.components[key];
      const id = newId('profile_component', dayMs(pDate), `v1:profile_component:${key}`);
      const md_path = c.markdown === null ? null : vaultPath.profileComponent(key);
      components.push({
        id,
        version_id: pv,
        key,
        kind: PROFILE_COMPONENT_KIND[key],
        confidence: c.confidence,
        weight: c.weight,
        data_json: c.data_json,
        md_path,
      });
      if (md_path && c.markdown !== null)
        files.push({ rel: md_path, kind: 'md', fm: { id, type: 'profile_component', key }, body: c.markdown });
    }
  }
  for (const pdf of listDir(from).filter((n) => /\.pdf$/i.test(n)))
    files.push({ rel: vaultPath.file(pdf), kind: 'copy', src: join(from, pdf) });

  const counts = Object.fromEntries(ROLE_STATUSES.map((s) => [s, 0])) as Record<RoleStatus, number>;
  for (const r of roles) counts[r.status]++;
  const fileMatches = { file_field: 0, id: 0, fuzzy: 0, none: 0 };
  for (const r of v1Roles) fileMatches[match.how.get(r.id) ?? 'none']++;

  return {
    from,
    rows: {
      profile_version: profileVersions,
      profile_component: components,
      company: [...companies.values()],
      role: roles,
      score: scores,
      event: events,
      application: applications,
      run: runs,
    },
    files,
    warnings,
    v1Counts: pipeline.meta?.counts ?? {},
    counts,
    archiveReasons,
    fileMatches,
    idMap,
    v1ScoreCount: v1Scores.length,
  };
}

const CRITERIA_V1 = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9'] as const;

const APP_MD_KIND: Record<string, keyof typeof APPLICATION_FILES> = {
  'resume.md': 'resume',
  'cover_letter.md': 'cover_letter',
  'fit_map.md': 'fit_map',
  'application_answers.md': 'answers',
  'answers.md': 'answers',
};
const APP_MD_TYPE = {
  resume: 'application_resume',
  cover_letter: 'application_cover_letter',
  fit_map: 'application_fit_map',
  answers: 'application_answers',
} as const;

function findPackageRole(
  coId: string,
  folder: string,
  slug: string,
  roles: Row<'role'>[],
  idMap: Map<string, string>,
): Row<'role'> | undefined {
  const inCo = roles.filter((r) => r.company_id === coId);
  const exact = inCo.find((r) => r.id === `${coId}_${slug}`);
  if (exact) return exact;
  const want = normId(`${folder}-${slug}`);
  for (const [v1, v2] of idMap) if (normId(v1) === want) return roles.find((r) => r.id === v2);
  const st = new Set(slug.split('-'));
  let best: { r: Row<'role'>; n: number } | undefined;
  for (const r of inCo) {
    const n = r.id
      .slice(coId.length + 1)
      .split('-')
      .filter((t) => st.has(t)).length;
    if (n > 0 && (!best || n > best.n)) best = { r, n };
  }
  return best?.r;
}

/** Insert absent rows (FK order) in one transaction and write absent files. `dryRun` rolls back and writes nothing. */
export function applyPlan(db: Db, home: string, plan: V1Plan, opts: { dryRun?: boolean } = {}): ApplyResult {
  const R = repos(db);
  const inserted: Partial<Record<TableName, number>> = {};
  const skipped: Partial<Record<TableName, number>> = {};
  const order: TableName[] = ['profile_version', 'profile_component', 'company', 'role', 'score', 'event', 'application', 'run'];
  let filesWritten = 0;
  let filesSkipped = 0;
  let runId: string | null = null;

  const tx = db.transaction(() => {
    for (const table of order) {
      const repo = R[table] as unknown as { insertIfAbsent(row: unknown): boolean; has(id: string): boolean };
      for (const row of (plan.rows[table] ?? []) as { id: string }[]) {
        let ok = false;
        if (table === 'role') ok = insertRole(db, row as Row<'role'>, plan.warnings) && repo.insertIfAbsent(row);
        else if (table === 'company') ok = insertCompany(db, row as Row<'company'>, repo);
        else if (table === 'application') ok = !roleHasApplication(db, row as Row<'application'>) && repo.insertIfAbsent(row);
        else ok = repo.insertIfAbsent(row);
        (ok ? inserted : skipped)[table] = ((ok ? inserted : skipped)[table] ?? 0) + 1;
      }
    }
    if (opts.dryRun) throw new DryRun();
  });
  try {
    tx();
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
    return { inserted, skipped, filesWritten: 0, filesSkipped: plan.files.length, runId: null };
  }

  for (const f of plan.files) {
    if (f.kind === 'md') {
      if (writeMd(home, f.rel, f.fm, f.body)) filesWritten++;
      else filesSkipped++;
    } else {
      const abs = vaultAbs(home, f.rel);
      if (existsSync(abs)) filesSkipped++;
      else {
        mkdirSync(dirname(abs), { recursive: true });
        copyFileSync(f.src, abs);
        filesWritten++;
      }
    }
  }

  const changed = Object.values(inserted).some((n) => (n ?? 0) > 0) || filesWritten > 0;
  if (changed) {
    const now = nowIso();
    runId = newId('run');
    const rel = vaultPath.runLog(now.slice(0, 10), `migrate-${runId.slice(-6)}`);
    const summary = { from: plan.from, inserted, skipped, filesWritten, filesSkipped, warnings: plan.warnings.length };
    R.run.insert({
      id: runId,
      op: 'migrate',
      started_at: now,
      finished_at: now,
      status: plan.warnings.length ? 'partial' : 'ok',
      summary_json: summary,
      log_path: rel,
    });
    writeMd(
      home,
      rel,
      { id: runId, type: 'run' },
      `# migrate\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n\n## Warnings\n\n${plan.warnings.map((w) => `- ${w}`).join('\n') || '- none'}`,
    );
  }
  return { inserted, skipped, filesWritten, filesSkipped, runId };
}

class DryRun extends Error {}

/** A role whose url already belongs to a different role id is skipped (unique url). */
function insertRole(db: Db, row: Row<'role'>, warnings: string[]): boolean {
  if (!row.url) return true;
  const hit = db.prepare('SELECT id FROM role WHERE url = ?').get(row.url) as { id: string } | undefined;
  if (hit && hit.id !== row.id) {
    warnings.push(`role ${row.id}: url already used by ${hit.id} in this vault, skipped`);
    return false;
  }
  return true;
}

/** Companies are matched by id or slug; an existing company keeps its fields. */
function insertCompany(db: Db, row: Row<'company'>, repo: { insertIfAbsent(row: unknown): boolean }): boolean {
  if (db.prepare('SELECT 1 FROM company WHERE slug = ? AND id <> ?').get(row.slug, row.id)) return false;
  return repo.insertIfAbsent(row);
}

function roleHasApplication(db: Db, row: Row<'application'>): boolean {
  return db.prepare('SELECT 1 FROM application WHERE role_id = ? AND id <> ?').get(row.role_id, row.id) !== undefined;
}

export interface MigrateV1Options {
  from: string;
  home: string;
  dryRun?: boolean;
  /** Allow a PP_HOME inside a git repo (tests only; personal data must never land in a repo). */
  allowGitHome?: boolean;
}

/** Plan + apply. Creates the vault and db if needed. */
export function migrateV1(opts: MigrateV1Options): MigrateV1Report {
  const { from, home } = opts;
  if (!existsSync(from)) throw new Error(`--from ${from} does not exist`);
  const git = findGitRoot(home);
  if (git && !opts.allowGitHome) throw new Error(`PP_HOME ${home} is inside the git repo ${git}; refusing to write personal data there`);
  const plan = planV1Import(from);
  if (!opts.dryRun) initVault(home);
  const db = opts.dryRun && !existsSync(dbPath(home)) ? openDb(':memory:') : openDb(dbPath(home));
  try {
    const res = applyPlan(db, home, plan, { dryRun: opts.dryRun ?? false });
    const dbCounts = countsByStatus(db);
    const countsMatch = Object.entries(plan.v1Counts).every(([s, n]) => (plan.counts as Record<string, number>)[s] === n);
    return {
      from,
      home,
      dryRun: opts.dryRun ?? false,
      ...res,
      v1Counts: plan.v1Counts,
      planned: plan.counts,
      dbCounts,
      countsMatch,
      archiveReasons: plan.archiveReasons,
      fileMatches: plan.fileMatches,
      scores: { v1: plan.v1ScoreCount, planned: plan.rows.score?.length ?? 0 },
      warnings: plan.warnings,
    };
  } finally {
    db.close();
  }
}
