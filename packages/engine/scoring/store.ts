import { randomBytes } from 'node:crypto';
import type { ArchiveReason, EventRow, HeldReason, ProfileComponent, RoleStatus, Score } from '@perfect-placement/contracts';
import type Database from 'better-sqlite3';

/*
 * The narrow data surface roles.score needs. Wave 1 shim: lane A owns repositories and lane B owns runOp
 * (which writes events). Wave 2 replaces `createSqliteScoringStore` with lane A's repos and routes
 * `insertEvent` through runOp's emitter. The interface is the seam; the handler does not change.
 */

export interface RoleLite {
  id: string;
  company_id: string;
  status: RoleStatus;
  archive_reason: ArchiveReason | null;
  found_at: string;
}

export interface CompanyLite {
  id: string;
  slug: string;
  name: string;
  domain: string | null;
  affinity: number;
}

export interface ProfileLite {
  id: string;
  components: ProfileComponent[];
}

export interface PoolEntry {
  role_id: string;
  status: 'active' | 'held';
  total: number;
  found_at: string;
}

export interface ScoringStore {
  transaction<T>(fn: () => T): T;
  getRole(id: string): RoleLite | undefined;
  getCompany(id: string): CompanyLite | undefined;
  /** A profile version, or the latest when id is omitted. */
  getProfile(versionId?: string): ProfileLite | undefined;
  /** Roles of a company in `active` or `held`, with their latest score total. */
  companyPool(companyId: string): PoolEntry[];
  insertScore(score: Score): void;
  setStatus(
    roleId: string,
    status: RoleStatus,
    reasons: { archive_reason: ArchiveReason | null; held_reason: HeldReason | null },
    nowIso: string,
  ): void;
  insertEvent(event: EventRow): void;
}

// ------------------------------------------------------------- id helper

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** `<prefix>_<ulid>` (Crockford base32, 48-bit time + 80-bit random). WAVE 2: use lane A's id helper. */
export function newId(prefix: string, now: Date = new Date()): string {
  let t = now.getTime();
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = B32[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = randomBytes(16);
  let r = '';
  for (let i = 0; i < 16; i++) r += B32[(rnd[i] as number) % 32];
  return `${prefix}_${time}${r}`;
}

// ------------------------------------------------------- SQLite shim (WAVE 2: replace)

const parse = (s: unknown): Record<string, unknown> => (typeof s === 'string' && s ? (JSON.parse(s) as Record<string, unknown>) : {});

/** WAVE 1 SHIM over migration 001. Wave 2 swaps in lane A repositories. */
export function createSqliteScoringStore(db: Database.Database): ScoringStore {
  const qRole = db.prepare('SELECT id, company_id, status, archive_reason, found_at FROM role WHERE id = ?');
  const qCompany = db.prepare('SELECT id, slug, name, domain, affinity FROM company WHERE id = ?');
  const qVersion = db.prepare('SELECT id FROM profile_version WHERE id = ?');
  const qLatestVersion = db.prepare('SELECT id FROM profile_version ORDER BY created_at DESC, id DESC LIMIT 1');
  const qComponents = db.prepare('SELECT * FROM profile_component WHERE version_id = ?');
  const qPool = db.prepare(`
    SELECT r.id AS role_id, r.status, r.found_at,
      COALESCE((SELECT s.total FROM score s WHERE s.role_id = r.id ORDER BY s.created_at DESC, s.id DESC LIMIT 1), 0) AS total
    FROM role r WHERE r.company_id = ? AND r.status IN ('active','held')`);
  const insScore = db.prepare(`INSERT INTO score (id, role_id, profile_version_id, rubric_json, c1, c2, c3, c4, c5, c6, c7, c8, c9,
    affinity_mod, total, band, decision, facts_json, created_at) VALUES (@id, @role_id, @profile_version_id, @rubric_json,
    @c1, @c2, @c3, @c4, @c5, @c6, @c7, @c8, @c9, @affinity_mod, @total, @band, @decision, @facts_json, @created_at)`);
  const updStatus = db.prepare('UPDATE role SET status = ?, archive_reason = ?, held_reason = ?, updated_at = ? WHERE id = ?');
  const insEvent = db.prepare(`INSERT INTO event (id, ts, type, subject_type, subject_id, payload_json, actor, decision_id)
    VALUES (@id, @ts, @type, @subject_type, @subject_id, @payload_json, @actor, @decision_id)`);

  return {
    transaction: (fn) => db.transaction(fn)(),
    getRole: (id) => qRole.get(id) as RoleLite | undefined,
    getCompany: (id) => qCompany.get(id) as CompanyLite | undefined,
    getProfile(versionId) {
      const v = (versionId ? qVersion.get(versionId) : qLatestVersion.get()) as { id: string } | undefined;
      if (!v) return undefined;
      const rows = qComponents.all(v.id) as Array<Record<string, unknown>>;
      return { id: v.id, components: rows.map((r) => ({ ...r, data_json: parse(r.data_json) }) as unknown as ProfileComponent) };
    },
    companyPool: (companyId) => qPool.all(companyId) as PoolEntry[],
    insertScore: (s) => insScore.run({ ...s, rubric_json: JSON.stringify(s.rubric_json), facts_json: JSON.stringify(s.facts_json) }),
    setStatus: (roleId, status, r, nowIso) => updStatus.run(status, r.archive_reason, r.held_reason, nowIso, roleId),
    insertEvent: (e) => insEvent.run({ ...e, payload_json: JSON.stringify(e.payload_json) }),
  };
}
