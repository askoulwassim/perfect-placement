import type { Application, ArchiveReason, Company, Role, RoleStatus, Score } from '@perfect-placement/contracts';
import type Database from 'better-sqlite3';
import { checkTransition, type MoveVia } from '../../status/index.js';
import { notFound, OpError } from '../errors.js';
import { newId } from '../ids.js';
import { rebalance } from '../lanes/scoring.js';
import { get, insert, select, update } from '../rows.js';
import type { HandlerContext } from '../runtime.js';

export function getRole(db: Database.Database, id: string): Role {
  const role = get(db, 'role', id);
  if (!role) throw notFound('role', id);
  return role;
}

export function getCompany(db: Database.Database, id: string): Company {
  const co = get(db, 'company', id);
  if (!co) throw notFound('company', id);
  return co;
}

export function latestScore(db: Database.Database, roleId: string): Score | null {
  return select(db, 'score', 'role_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', [roleId])[0] ?? null;
}

/** Latest score per role, for list views. */
export function latestScores(db: Database.Database): Map<string, Score> {
  const map = new Map<string, Score>();
  for (const s of select(db, 'score', '1 ORDER BY created_at, rowid')) map.set(s.role_id, s);
  return map;
}

export function applicationFor(db: Database.Database, roleId: string): Application | null {
  return select(db, 'application', 'role_id = ?', [roleId])[0] ?? null;
}

const STAGES: Application['stage'][] = ['research', 'tailor', 'connect', 'fill', 'submit', 'done'];
export const laterStage = (a: Application['stage'], b: Application['stage']) => (STAGES.indexOf(a) >= STAGES.indexOf(b) ? a : b);

/** Get or create the role's application row, then patch it. */
export function upsertApplication(h: HandlerContext, roleId: string, patch: Partial<Omit<Application, 'id' | 'role_id'>>): Application {
  const existing = applicationFor(h.db, roleId);
  if (existing) {
    update(h.db, 'application', existing.id, patch);
    return { ...existing, ...patch };
  }
  const app: Application = {
    id: newId('application', h.ctx.now()),
    role_id: roleId,
    stage: 'research',
    applied_at: null,
    portal_url: null,
    package_paths_json: {},
    fill_assist_json: null,
    ...patch,
  } as Application;
  insert(h.db, 'application', app);
  return app;
}

/** v1 port: every move appends a dated line to the role's markdown. */
export function appendRoleLog(h: HandlerContext, role: Role, line: string): void {
  if (!role.md_path || !h.vault.exists(role.md_path)) return;
  const body = h.vault.read(role.md_path) ?? '';
  const header = /\n## Log\n/.test(body) ? '' : '\n## Log\n';
  h.vault.append(role.md_path, `${header}\n- ${h.nowIso().slice(0, 10)} ${line}\n`);
}

export interface MoveOptions {
  via: MoveVia;
  archiveReason?: ArchiveReason;
  note?: string;
  /** Override the event's decision id (auto decisions made inside the op). */
  decisionId?: string | null;
  /** Extra event payload. */
  payload?: Record<string, unknown>;
}

/** Statuses that take part in the per-company cap (wave1-decisions #13: on-deck does not). */
const CAP_STATUSES: readonly RoleStatus[] = ['active', 'held'];

/**
 * The one place a role's status changes inside lane B ops. Checks the status machine,
 * writes the row, appends the markdown log, emits role_moved / role_archived, and re-applies
 * the per-company cap (lane F `rebalanceCompany`) when the role entered or left the pool.
 */
export function moveRole(h: HandlerContext, role: Role, to: RoleStatus, opts: MoveOptions): Role {
  const check = checkTransition({
    from: role.status,
    to,
    actor: h.ctx.actor,
    via: opts.via,
    ...(opts.archiveReason ? { archiveReason: opts.archiveReason } : {}),
    fromArchiveReason: role.archive_reason,
  });
  if (!check.ok) throw new OpError(check.code, `${role.id}: ${check.message}`);
  const from = role.status;
  const patch: Partial<Role> = {
    status: to,
    archive_reason: to === 'archived' ? (opts.archiveReason ?? null) : null,
    held_reason: to === 'held' ? 'company_cap' : null,
    updated_at: h.nowIso(),
  };
  if (to === 'archived' && opts.note) patch.flags_json = { ...role.flags_json, archive_note: opts.note };
  // Undoing a freshness close: the posting is no longer known closed.
  if (opts.via === 'undo' && from === 'archived' && role.archive_reason === 'closed') {
    const { closed: _closed, ...flags } = role.flags_json;
    patch.flags_json = flags;
    patch.freshness = 'unknown';
  }
  update(h.db, 'role', role.id, patch);
  const moved: Role = { ...role, ...patch };
  const reason = opts.archiveReason ?? opts.note;
  appendRoleLog(h, role, `${from} -> ${to} (${h.name}${reason ? `: ${reason}` : ''})`);
  const payload = { from, to, via: opts.via, ...(opts.note ? { note: opts.note } : {}), ...(opts.payload ?? {}) };
  // roles.move restoring an archive (an undo) cannot emit role_archived: role_moved carries the reason.
  if (to === 'archived' && h.canEmit('role_archived'))
    h.emit('role_archived', 'role', role.id, { ...payload, reason: opts.archiveReason }, opts.decisionId);
  else h.emit('role_moved', 'role', role.id, to === 'archived' ? { ...payload, reason: opts.archiveReason } : payload, opts.decisionId);
  if (CAP_STATUSES.includes(from) || CAP_STATUSES.includes(to)) rebalance(h, role.company_id);
  return moved;
}

/** The inverse of a move for `decisions.undo`: restore `from` (and its archive reason) exactly. */
export function undoMove(role: Pick<Role, 'id' | 'status' | 'archive_reason'>): { op: 'roles.move'; input: Record<string, unknown> } {
  return {
    op: 'roles.move',
    input: {
      role_id: role.id,
      to: role.status,
      ...(role.status === 'archived' && role.archive_reason ? { reason: role.archive_reason } : {}),
    },
  };
}
