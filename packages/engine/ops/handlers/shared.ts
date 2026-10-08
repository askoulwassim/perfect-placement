import type { Application, ArchiveReason, Company, Role, RoleStatus, Score } from '@perfect-placement/contracts';
import type Database from 'better-sqlite3';
import { checkTransition, freesSlot, type MoveVia, pickPromotions, SLOT_STATUSES } from '../../status/index.js';
import { get, insert, select, update } from '../_shim/repo.js';
import { notFound, OpError } from '../errors.js';
import { newId } from '../ids.js';
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
    ...patch,
  };
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

/**
 * The one place a role's status changes inside lane B ops. Checks the status machine,
 * writes the row, appends the markdown log, emits role_moved / role_archived, and
 * promotes held roles when a company slot frees.
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
    held_reason: null,
    updated_at: h.nowIso(),
  };
  if (to === 'archived' && opts.note) patch.flags_json = { ...role.flags_json, archive_note: opts.note };
  update(h.db, 'role', role.id, patch);
  const moved: Role = { ...role, ...patch };
  const reason = opts.archiveReason ?? opts.note;
  appendRoleLog(h, role, `${from} -> ${to} (${h.name}${reason ? `: ${reason}` : ''})`);
  const payload = { from, to, via: opts.via, ...(opts.note ? { note: opts.note } : {}), ...(opts.payload ?? {}) };
  if (to === 'archived') h.emit('role_archived', 'role', role.id, { ...payload, reason: opts.archiveReason }, opts.decisionId);
  else h.emit('role_moved', 'role', role.id, payload, opts.decisionId);
  if (freesSlot(from, to)) promoteHeld(h, role.company_id);
  return moved;
}

/**
 * Held promotion (blueprint "Per-company cap"): when a company has fewer than
 * config.scoring.company_active_cap active roles, its best held roles become active.
 * Emits role_promoted, or role_moved {promoted:true} for ops whose frozen `emits`
 * lack role_promoted (see CONTRACT_CHANGES.md, Lane B requests).
 */
export function promoteHeld(h: HandlerContext, companyId: string): string[] {
  const slots = SLOT_STATUSES.map(() => '?').join(', ');
  const active = (
    h.db.prepare(`SELECT count(*) n FROM role WHERE company_id = ? AND status IN (${slots})`).get(companyId, ...SLOT_STATUSES) as {
      n: number;
    }
  ).n;
  const held = select(h.db, 'role', `company_id = ? AND status = 'held'`, [companyId]);
  if (held.length === 0) return [];
  const pick = pickPromotions(
    held.map((r) => ({ id: r.id, found_at: r.found_at, total: latestScore(h.db, r.id)?.total ?? null })),
    active,
    h.config.scoring.company_active_cap,
  );
  for (const id of pick) {
    const role = held.find((r) => r.id === id) as Role;
    const check = checkTransition({ from: 'held', to: 'active', actor: h.ctx.actor, via: 'promote' });
    if (!check.ok) continue;
    update(h.db, 'role', id, { status: 'active', held_reason: null, updated_at: h.nowIso() });
    appendRoleLog(h, role, 'held -> active (company slot freed)');
    const payload = { from: 'held', to: 'active', company_id: companyId };
    if (h.canEmit('role_promoted')) h.emit('role_promoted', 'role', id, payload);
    else h.emit('role_moved', 'role', id, { ...payload, promoted: true });
  }
  return pick;
}
