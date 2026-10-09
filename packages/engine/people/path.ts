import {
  type BridgeTie,
  type ConnectPath,
  type ConnectPathOption,
  type ConnectPaths,
  type Contact,
  type ContactLink,
  type ContactTier,
  peopleSetPath,
} from '@perfect-placement/contracts';
import { draftRecipient } from './email.js';
import { getLinkForRole, getOutreachFor, updateLink } from './queries.js';
import { err, type Handler, type PeopleDeps } from './types.js';

/*
 * Direct vs bridge for a 2nd-degree hiring-team target (#98). The connect skill supplies judgment (the
 * mutual's tie: same company, same industry, history); everything here is mechanics.
 *
 *   direct  = a note to the target. Reachable when their email is confirmed or likely.
 *   bridge  = an intro ask to the 1st-degree mutual. Strong only when the mutual is close to the target.
 *
 * Default to direct when the target is reachable and the mutual is a weak tie; bridge only for a strong
 * mutual with an email. Never draft to a mutual with no email while a direct path exists (blocked).
 */

/** How reachable an address is: confirmed (To is set), likely (a guess at or above LIKELY_EMAIL_P), none. */
export type Reach = 'confirmed' | 'likely' | 'none';

/** A guess at or above this counts as likely (the default `first.last` prior, 0.45, does). */
export const LIKELY_EMAIL_P = 0.4;

/** Points for reaching the target directly. */
export const REACH_POINTS: Record<Reach, number> = { confirmed: 3, likely: 2, none: 0 };

/** Points for the mutual's tie to the target. A tie at or above STRONG_TIE is strong. */
export const TIE_POINTS = { same_company: 3, history: 2, same_industry: 1 } as const;
export const STRONG_TIE = 3;

/** The draft tier per path for a hiring-team target. */
export const PATH_TIER: Record<ConnectPath, ContactTier> = { direct: 'cold_hiring', bridge: 'bridge' };

const REACH_LABEL: Record<Reach, string> = { confirmed: 'Email confirmed', likely: 'Email likely', none: 'No email' };
const VIA_REACH_LABEL: Record<Reach, string> = { confirmed: 'Email known', likely: 'Email likely', none: 'No email' };

export interface PathFacts {
  /** The target's email. */
  target: Reach;
  /** The mutual's email and tie to the target. */
  via: { reach: Reach; tie: BridgeTie };
  /** The user's pick (contact_link.path), or null. */
  chosen: ConnectPath | null;
}

export interface RankedPath {
  path: ConnectPath;
  score: number;
  reason: string;
  blocked: boolean;
}

export const tiePoints = (t: BridgeTie): number =>
  (t.same_company ? TIE_POINTS.same_company : 0) + (t.history ? TIE_POINTS.history : 0) + (t.same_industry ? TIE_POINTS.same_industry : 0);

/** The mutual's tie in a word or two: "Same company", "In touch", "Same industry", else "Other company". */
function tieLabel(t: BridgeTie): string {
  const parts = [t.same_company ? 'Same company' : t.same_industry ? 'Same industry' : 'Other company'];
  if (t.history) parts.push('In touch');
  return parts.join(' · ');
}

/** Ranks direct vs bridge (pure). `options` lists the recommended path first. */
export function rankPaths(f: PathFacts): { recommended: ConnectPath; chosen: ConnectPath; options: RankedPath[] } {
  const reachable = f.target !== 'none';
  const tie = tiePoints(f.via.tie);
  const strong = tie >= STRONG_TIE;
  const direct: RankedPath = {
    path: 'direct',
    score: REACH_POINTS[f.target],
    reason: `Hiring team · ${REACH_LABEL[f.target]}`,
    blocked: false,
  };
  const bridge: RankedPath = {
    path: 'bridge',
    score: tie + (f.via.reach === 'confirmed' ? 1 : 0),
    reason: `${tieLabel(f.via.tie)} · ${VIA_REACH_LABEL[f.via.reach]}`,
    blocked: reachable && f.via.reach === 'none',
  };
  const recommended: ConnectPath = !reachable ? 'bridge' : strong && !bridge.blocked ? 'bridge' : 'direct';
  const chosen: ConnectPath = f.chosen && !(f.chosen === 'bridge' && bridge.blocked) ? f.chosen : recommended;
  return { recommended, chosen, options: recommended === 'direct' ? [direct, bridge] : [bridge, direct] };
}

type PathDeps = Pick<PeopleDeps, 'repos' | 'config'>;

/** Reach of a contact's address: confirmed when a Gmail draft would get a To (#37), likely for a fair guess. */
export function reachOf(deps: PathDeps, c: Contact): Reach {
  if (!c.email) return 'none';
  if (draftRecipient(deps, c).confirmed) return 'confirmed';
  return (c.email_confidence ?? 0) >= LIKELY_EMAIL_P ? 'likely' : 'none';
}

const NO_TIE: BridgeTie = { same_company: false, same_industry: false, history: false };

/**
 * The ranked paths for a contact link, or null when there is no choice: only a 2nd-degree hiring-team
 * target with a mutual has one (anyone else is reached the one way their tier says).
 */
export function connectPathsFor(deps: PathDeps, link: ContactLink): ConnectPaths | null {
  if (link.degree !== '2' || !link.is_hiring_team || !link.via_contact_id) return null;
  const target = deps.repos.contact.get(link.contact_id);
  const via = deps.repos.contact.get(link.via_contact_id);
  if (!target || !via) return null;
  const given = link.via_tie_json ?? NO_TIE;
  // The tie is the skill's judgment; the user's own mail with the mutual says nothing about the mutual and the target.
  const ranked = rankPaths({ target: reachOf(deps, target), via: { reach: reachOf(deps, via), tie: given }, chosen: link.path });
  const who: Record<ConnectPath, Contact> = { direct: target, bridge: via };
  const options: ConnectPathOption[] = ranked.options.map((o) => ({
    path: o.path,
    contact_id: who[o.path].id,
    name: who[o.path].name,
    tier: PATH_TIER[o.path],
    score: o.score,
    reason: o.reason,
    blocked: o.blocked,
  }));
  return { recommended: ranked.recommended, chosen: ranked.chosen, options };
}

/** The tier a draft for this link uses: the chosen path's when there is a choice, else the link's tier. */
export function draftTierFor(deps: PathDeps, link: ContactLink): ContactTier {
  const paths = connectPathsFor(deps, link);
  return paths ? PATH_TIER[paths.chosen] : link.tier;
}

/**
 * people.set_path: the user's pick of direct or bridge for a 2nd-degree hiring-team target (null: back to
 * the ranked default). A blocked bridge (mutual has no email, target reachable) is refused; so is a switch
 * once the target's draft is in Gmail.
 */
export const setPath: Handler<'people.set_path'> = async (raw, ctx, deps) => {
  const parsed = peopleSetPath.input.safeParse(raw);
  if (!parsed.success) return err('invalid_input', 'people.set_path input', parsed.error.issues);
  const { contact_id, role_id, path } = parsed.data;
  const link = getLinkForRole(deps.repos, contact_id, role_id);
  if (!link) return err('not_found', `no contact_link for ${contact_id} on ${role_id}`);
  const paths = connectPathsFor(deps, link);
  if (!paths) return err('invalid_input', `contact ${contact_id} has one path only (2nd-degree hiring team with a mutual has two)`);
  if (path && paths.options.find((o) => o.path === path)?.blocked)
    return err('conflict', `the ${path} path is blocked: the mutual has no email and the target is reachable`);
  const prev = getOutreachFor(deps.repos, contact_id, role_id);
  const nextTier = PATH_TIER[path ?? paths.recommended];
  if (prev && prev.status !== 'drafted' && prev.tier !== nextTier)
    return err('conflict', `outreach ${prev.id} is ${prev.status}; the path cannot change now`);
  const next: ContactLink = { ...link, path };
  if (!ctx.dryRun) updateLink(deps.repos, next);
  const out = connectPathsFor(deps, next) ?? paths;
  return { status: 'ok', output: { link: next, paths: out }, eventIds: [] };
};
