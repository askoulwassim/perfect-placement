import {
  type Actor,
  type ArchiveReason,
  FRESHNESS_SCOPE,
  MANUAL_MOVES,
  PROTECTED_STATUSES,
  type RoleStatus,
} from '@perfect-placement/contracts';

/*
 * Role status machine (lane B). Pure rules, no db.
 * Every status change in the system is checked here first: roles.move, roles.archive,
 * apply.tailor, apply stage starts (the pick), apply.mark_submitted, inbox.ingest (lane B), roles.score (lane F),
 * roles.check_freshness (lane G) and held promotion.
 */

export const OWNER_LANE = 'B' as const;

/** Funnel rank. `held` sits beside `active`; `archived` is off the funnel. */
export const FUNNEL_RANK: Record<RoleStatus, number> = {
  inbox: 0,
  active: 1,
  held: 1,
  'on-deck': 2,
  'draft-ready': 3,
  applied: 4,
  interviews: 5,
  offers: 6,
  archived: -1,
};

/** Statuses that occupy a per-company slot (config.scoring.company_active_cap). */
export const SLOT_STATUSES = ['active'] as const satisfies readonly RoleStatus[];

/** Which path is asking for the change. Each path has its own rules. */
export type MoveVia =
  /** roles.move: drag in River, or an agent proposal. */
  | 'move'
  /** roles.archive (and freshness closing a role). */
  | 'archive'
  /** apply.tailor: package written -> draft-ready. */
  | 'tailor'
  /** apply.mark_submitted: the human says they submitted. */
  | 'submit'
  /** inbox.ingest: confirmation, interview request, offer, rejection. */
  | 'inbox'
  /** roles.score (lane F): active, held or archived from a score row. */
  | 'score'
  /** Automatic held -> active when a company slot frees. */
  | 'promote'
  /**
   * #105: starting an apply stage (Research, Tailor, Connect) picks the role: active or held -> on-deck.
   * Any actor (the human's button, the agent's run); on-deck is outside the company cap.
   */
  | 'pick'
  /** `decisions.undo` of an auto + undo decision: restore the exact prior status (and archive reason). */
  | 'undo';

export interface TransitionRequest {
  from: RoleStatus;
  to: RoleStatus;
  actor: Actor;
  via: MoveVia;
  /** Required when `to` is archived. */
  archiveReason?: ArchiveReason;
  /** The role's current archive reason when `from` is archived. */
  fromArchiveReason?: ArchiveReason | null;
}

export type TransitionCheck = { ok: true } | { ok: false; code: 'forbidden_transition' | 'conflict'; message: string };

const isProtected = (s: RoleStatus) => (PROTECTED_STATUSES as readonly RoleStatus[]).includes(s);
const isAutomated = (a: Actor) => a !== 'human';
const isManualMove = (from: RoleStatus, to: RoleStatus) => MANUAL_MOVES.some(([f, t]) => f === from && t === to);
const ok: TransitionCheck = { ok: true };
const no = (message: string): TransitionCheck => ({ ok: false, code: 'forbidden_transition', message });

/**
 * No-downgrade: moving out of draft-ready or later to an earlier status (or to archived).
 * Automated actors may never do this, except the narrow archive cases in `checkTransition`.
 */
export function isDowngrade(from: RoleStatus, to: RoleStatus): boolean {
  if (!isProtected(from)) return false;
  return to === 'archived' || FUNNEL_RANK[to] < FUNNEL_RANK[from];
}

/**
 * #105: statuses an apply stage start moves to on-deck (the pick). Held is included: on-deck takes no
 * company slot, so picking a held role displaces no active one. Later statuses are already picked (never
 * downgraded); inbox and archived are not picked by a stage start.
 */
export const PICKABLE_STATUSES = ['active', 'held'] as const satisfies readonly RoleStatus[];

/** Statuses a human may restore an archived role to. */
export const RESTORE_TARGETS = ['inbox', 'active', 'on-deck'] as const satisfies readonly RoleStatus[];

/** Archive reasons a rescore may lift a role out of (rubric or profile changed). */
export const RESCORABLE_ARCHIVE_REASONS = ['below_threshold', 'dealbreaker'] as const satisfies readonly ArchiveReason[];

export function checkTransition(req: TransitionRequest): TransitionCheck {
  const { from, to, actor, via } = req;
  if (from === to) return { ok: false, code: 'conflict', message: `role is already ${to}` };
  if (to === 'archived' && !req.archiveReason) return no('archiving requires a reason');
  if (to === 'held' && via !== 'score' && via !== 'undo') return no('held is set by the company cap only');

  switch (via) {
    case 'move': {
      if (to === 'archived') return no('use roles.archive to archive');
      if (from === 'archived') {
        if (isAutomated(actor)) return no('only a human restores an archived role');
        return (RESTORE_TARGETS as readonly RoleStatus[]).includes(to) ? ok : no(`cannot restore an archived role to ${to}`);
      }
      if (!isManualMove(from, to)) return no(`${from} -> ${to} is not a manual move`);
      if (isAutomated(actor) && isDowngrade(from, to)) return no(`no-downgrade: an automated actor cannot move a role out of ${from}`);
      return ok;
    }
    case 'archive': {
      if (to !== 'archived') return no('archive moves only to archived');
      if (!isAutomated(actor) || !isProtected(from)) return ok;
      // Automated archiving out of a protected status: the inbox monitor's rejection,
      // or freshness closing a draft-ready posting (FRESHNESS_SCOPE).
      if (req.archiveReason === 'rejected') return ok;
      if (req.archiveReason === 'closed' && (FRESHNESS_SCOPE as readonly RoleStatus[]).includes(from)) return ok;
      return no(`no-downgrade: an automated actor cannot archive a role in ${from} (${req.archiveReason})`);
    }
    case 'tailor':
      if (to !== 'draft-ready') return no('tailor moves only to draft-ready');
      return from === 'active' || from === 'on-deck' ? ok : no(`cannot tailor a role in ${from}`);
    case 'submit':
      if (to !== 'applied') return no('submit moves only to applied');
      if (isAutomated(actor)) return no('only a human marks an application submitted');
      return from === 'active' || from === 'on-deck' || from === 'draft-ready' ? ok : no(`cannot submit a role in ${from}`);
    case 'inbox': {
      if (to === 'archived') return req.archiveReason === 'rejected' ? ok : no('the inbox archives only on rejection');
      if (to !== 'applied' && to !== 'interviews' && to !== 'offers') return no(`the inbox cannot move a role to ${to}`);
      if (from === 'archived') return ok; // email evidence revives a role (v1 behaviour)
      return FUNNEL_RANK[to] > FUNNEL_RANK[from] ? ok : no(`no-downgrade: role is already at or past ${to} (${from})`);
    }
    case 'score': {
      if (to !== 'active' && to !== 'held' && to !== 'archived') return no(`a score cannot set ${to}`);
      if (isProtected(from)) return no(`no-downgrade: a rescore never moves a role out of ${from}`);
      if (from === 'on-deck') return no('a rescore never moves a picked role');
      if (from === 'archived') {
        const r = req.fromArchiveReason;
        if (!r || !(RESCORABLE_ARCHIVE_REASONS as readonly ArchiveReason[]).includes(r))
          return no(`a rescore never revives a role archived as ${r ?? 'unknown'}`);
      }
      return ok;
    }
    case 'promote':
      return from === 'held' && to === 'active' ? ok : no('promotion is held -> active only');
    case 'pick':
      if (to !== 'on-deck') return no('a pick moves only to on-deck');
      return (PICKABLE_STATUSES as readonly RoleStatus[]).includes(from) ? ok : no(`cannot pick a role in ${from}`);
    case 'undo':
      // Authorized by the decision being undone (inside its window); restores what was there before.
      return ok;
  }
}

/** Does leaving `from` for `to` free a company slot? */
export function freesSlot(from: RoleStatus, to: RoleStatus): boolean {
  const slot = SLOT_STATUSES as readonly RoleStatus[];
  return slot.includes(from) && !slot.includes(to);
}

export interface PromotionCandidate {
  id: string;
  /** Latest score total; null when unscored. */
  total: number | null;
  found_at: string;
}

/**
 * Which held roles to promote when a company has free slots.
 * Highest latest score first; ties go to the earlier find.
 */
export function pickPromotions(held: readonly PromotionCandidate[], activeCount: number, cap: number): string[] {
  const free = Math.max(0, cap - activeCount);
  if (free === 0) return [];
  return [...held]
    .sort((a, b) => (b.total ?? -1) - (a.total ?? -1) || a.found_at.localeCompare(b.found_at) || a.id.localeCompare(b.id))
    .slice(0, free)
    .map((r) => r.id);
}
