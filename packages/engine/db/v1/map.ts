import type { ArchiveReason, AtsType, Workplace } from '@perfect-placement/contracts';
import { slugify } from '../ids.js';

/*
 * Pure v1 -> v2 mapping helpers (no fs). Everything here is deterministic so `pp migrate` is idempotent.
 */

export interface V1Role {
  id: string;
  company: string;
  role: string;
  status: string;
  [k: string]: unknown;
}

export interface V1Score {
  id: string;
  rubric_version?: string;
  scored?: string;
  criteria: Record<string, number>;
  total: number;
  band: string;
  decision: string;
  [k: string]: unknown;
}

export interface V1RoleFile {
  /** v1 repo-relative path, e.g. `02_Pipeline/archive/2026-01-02_acme_staff-pm.md`. */
  path: string;
  name: string;
  folder: string;
  date: string;
  companySlug: string;
  titleSlug: string;
}

const FILE_RE = /^(\d{4}-\d{2}-\d{2})_([^_]+)_(.+)\.md$/;

export function parseRoleFileName(folder: string, name: string): Omit<V1RoleFile, 'path'> | null {
  const m = FILE_RE.exec(name);
  if (!m) return null;
  return { name, folder, date: m[1] as string, companySlug: m[2] as string, titleSlug: m[3] as string };
}

/** v1 ids mix `acme-staff-pm` and `acme_staff-pm`; compare on the hyphen form. */
export const normId = (s: string): string => s.replace(/_/g, '-').toLowerCase();

const tokens = (s: string): Set<string> => new Set(slugify(s).split('-').filter(Boolean));

/** Does a role-file company slug belong to this v1 role's company? */
export function companyMatches(role: V1Role, fileCompanySlug: string): boolean {
  const name = slugify(role.company);
  return (
    name === fileCompanySlug ||
    name.startsWith(`${fileCompanySlug}-`) ||
    fileCompanySlug.startsWith(`${name}-`) ||
    normId(role.id).startsWith(`${fileCompanySlug}-`)
  );
}

export interface FileMatch {
  byRole: Map<string, V1RoleFile>;
  /** How each role matched: `file` field, id, or fuzzy (company + title tokens). */
  how: Map<string, 'file_field' | 'id' | 'fuzzy'>;
  unmatchedFiles: V1RoleFile[];
}

/**
 * Pair v1 roles with their markdown files: the role's `file` field, then the normalized id
 * (`<company>-<title>`), then a fuzzy pass inside the same company (title-token overlap; a
 * company with exactly one leftover role and one leftover file pairs them).
 */
export function matchRoleFiles(roles: V1Role[], files: V1RoleFile[]): FileMatch {
  const byRole = new Map<string, V1RoleFile>();
  const how = new Map<string, 'file_field' | 'id' | 'fuzzy'>();
  const used = new Set<string>();
  const take = (r: V1Role, f: V1RoleFile, h: 'file_field' | 'id' | 'fuzzy') => {
    byRole.set(r.id, f);
    how.set(r.id, h);
    used.add(f.path);
  };

  const byName = new Map(files.map((f) => [f.name, f]));
  for (const r of roles) {
    if (typeof r.file !== 'string') continue;
    const f = byName.get(r.file.split('/').pop() as string);
    if (f && !used.has(f.path)) take(r, f, 'file_field');
  }
  const byKey = new Map<string, V1RoleFile>();
  for (const f of files) if (!used.has(f.path)) byKey.set(normId(`${f.companySlug}-${f.titleSlug}`), f);
  for (const r of roles) {
    if (byRole.has(r.id)) continue;
    const f = byKey.get(normId(r.id));
    if (f && !used.has(f.path)) take(r, f, 'id');
  }

  const leftRoles = roles.filter((r) => !byRole.has(r.id));
  const leftFiles = files.filter((f) => !used.has(f.path));
  type Pair = { r: V1Role; f: V1RoleFile; score: number };
  const pairs: Pair[] = [];
  for (const r of leftRoles) {
    const rt = tokens(`${r.id} ${r.role}`);
    for (const f of leftFiles) {
      if (!companyMatches(r, f.companySlug)) continue;
      const ft = tokens(f.titleSlug);
      let shared = 0;
      for (const t of ft) if (rt.has(t)) shared++;
      pairs.push({ r, f, score: shared / Math.max(1, ft.size) });
    }
  }
  // Companies with exactly one candidate on each side pair regardless of overlap.
  const rolesPerFile = new Map<string, number>();
  const filesPerRole = new Map<string, number>();
  for (const p of pairs) {
    rolesPerFile.set(p.f.path, (rolesPerFile.get(p.f.path) ?? 0) + 1);
    filesPerRole.set(p.r.id, (filesPerRole.get(p.r.id) ?? 0) + 1);
  }
  pairs.sort((a, b) => b.score - a.score || a.r.id.localeCompare(b.r.id) || a.f.path.localeCompare(b.f.path));
  for (const p of pairs) {
    if (byRole.has(p.r.id) || used.has(p.f.path)) continue;
    const unique = rolesPerFile.get(p.f.path) === 1 && filesPerRole.get(p.r.id) === 1;
    if (unique || p.score > 0) take(p.r, p.f, 'fuzzy');
  }
  return { byRole, how, unmatchedFiles: files.filter((f) => !used.has(f.path)) };
}

/** Free-text v1 workplace -> v2 enum. The raw text is kept in flags_json.v1. */
export function mapWorkplace(raw: unknown): Workplace {
  if (typeof raw !== 'string' || !raw.trim()) return 'unspecified';
  const t = raw.toLowerCase();
  if (/unconfirmed|not confirmed|unspecified|unclear|not stated|typically|commonly/.test(t)) return 'unspecified';
  if (/remote-first|fully remote|full-remote/.test(t)) return 'remote';
  const remote = /remote/.test(t);
  if (remote && /hybrid|in-person|onsite|on-site|office/.test(t)) return 'flexible';
  if (/hybrid/.test(t)) return 'hybrid';
  if (/in-person|onsite|on-site/.test(t)) return 'onsite';
  if (remote) return 'remote';
  return 'unspecified';
}

/** v1 remote_ok: true | 'remote' -> true; 'dream-exception' -> false (allowed only by the dream-company exception); else null. */
export function mapRemoteOk(raw: unknown): boolean | null {
  if (raw === true || raw === 'remote') return true;
  if (raw === false || raw === 'dream-exception') return false;
  return null;
}

export function mapFacing(raw: unknown): 'internal' | 'external' | 'mixed' | null {
  return raw === 'internal' || raw === 'external' || raw === 'mixed' ? raw : null;
}

export const intOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);

export function validUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? v.trim() : null;
  } catch {
    return null;
  }
}

export function atsFromUrl(url: string | null): { type: AtsType; board: string | null } {
  if (!url) return { type: 'unknown', board: null };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { type: 'unknown', board: null };
  }
  const seg = u.pathname.split('/').filter(Boolean);
  const h = u.hostname;
  if (h.endsWith('greenhouse.io')) return { type: 'greenhouse', board: (seg[0] === 'embed' ? u.searchParams.get('for') : seg[0]) ?? null };
  if (h.endsWith('lever.co')) return { type: 'lever', board: seg[0] ?? null };
  if (h.endsWith('ashbyhq.com')) return { type: 'ashby', board: seg[0] ?? null };
  if (h.includes('myworkdayjobs.com') || h.includes('workday')) return { type: 'workday', board: h.split('.')[0] ?? null };
  return { type: 'other', board: null };
}

/** v1 flag strings -> flags_json keys. `dream-co` becomes `dream_company`. */
export function flagKey(f: string): string {
  if (f === 'dream-co') return 'dream_company';
  return f.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase();
}

/** Basis of a green score the v1 scorer archived (its remote / dream-company dealbreaker rule). */
export const GREEN_ARCHIVED_BASIS = 'green score archived by the v1 scorer';

export interface ArchiveInference {
  reason: ArchiveReason;
  basis: string;
}

/**
 * Archive reason for a v1 archived role (v1 lumped below-threshold, passed and parked together).
 * Order: explicit closed -> explicit dealbreaker -> score below green -> scorer archived a green score
 * (dealbreaker rule) -> a human reason on a green role (passed) -> legacy.
 */
export function inferArchiveReason(
  role: V1Role,
  latest: { total: number; band: string; decision: string } | undefined,
  greenMin: number,
): ArchiveInference {
  const flags = Array.isArray(role.flags) ? (role.flags as unknown[]).map(String) : [];
  const text = typeof role.reason === 'string' ? role.reason : '';
  if (flags.includes('closed') || role.closed === true || /\b(closed|no longer (open|accepting)|404)\b/i.test(text))
    return { reason: 'closed', basis: 'closed flag or reason' };
  if (/withdr[ae]w/i.test(text)) return { reason: 'withdrawn', basis: 'reason text' };
  if (/\breject/i.test(text)) return { reason: 'rejected', basis: 'reason text' };
  if (/dealbreaker|forced archive/i.test(text)) return { reason: 'dealbreaker', basis: 'reason text' };
  const total = latest?.total ?? (typeof role.fit_score === 'number' ? role.fit_score : undefined);
  const band = latest?.band ?? (typeof role.band === 'string' ? role.band : undefined);
  if ((total !== undefined && total < greenMin) || (band !== undefined && band !== 'green'))
    return { reason: 'below_threshold', basis: `score ${total ?? '?'} ${band ?? ''}`.trim() };
  if (latest?.decision === 'archived') return { reason: 'dealbreaker', basis: GREEN_ARCHIVED_BASIS };
  if (text) return { reason: 'passed', basis: 'green role parked with a reason' };
  return { reason: 'legacy', basis: 'no signal' };
}

/** v1 run log file name -> op name for the run row. */
export function runOp(rest: string): string {
  if (/inbox/.test(rest)) return 'inbox.ingest';
  if (/scor/.test(rest)) return 'roles.score';
  if (/scout|scan/.test(rest)) return 'roles.add';
  return `v1.${rest}`;
}

export const dayIso = (date: string): string => `${date}T00:00:00.000Z`;
export const dayMs = (date: string): number => Date.parse(dayIso(date));
export const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
