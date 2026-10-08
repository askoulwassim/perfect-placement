import type { ArchiveReason, EventRow, HeldReason, ProfileComponent, RoleStatus, Score } from '@perfect-placement/contracts';
import { ulid } from '../db/ids.js';

/*
 * The narrow data surface roles.score needs. The engine implements it over lane A's repositories
 * and runOp's event writer (packages/engine/ops/lanes/scoring.ts); the handler does not change.
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

/** `<prefix>_<ulid>` with lane A's ULID. */
export function newId(prefix: string, now: Date = new Date()): string {
  return `${prefix}_${ulid(now.getTime())}`;
}
