import type {
  ConnectPaths,
  Contact,
  ContactLink,
  ContactTier,
  RoleGraph,
  RoleGraphEdge,
  RoleGraphNode,
} from '@perfect-placement/contracts';

/*
 * The people graph for a role (#131), pure: me -> the 1st-degree mutual (the bridge) -> the 2nd-degree
 * target -> the company. Every person in the search is a node: each contact linked to the role, and each
 * mutual a link names in `via_contact_id`, even when the mutual has no role link of its own (people.find
 * stores the mutual as a contact only). No duplicate nodes; the path the primary action drafts is flagged
 * `recommended`, everything else is an alternative.
 *
 * Imports contract types only, so the web's read-only fixtures preview can build the same graph.
 */

export const ME_NODE = 'me';
export const companyNodeId = (companyId: string): string => `co:${companyId}`;

/** Warmest route first: a bridge beats a warm non-hiring 1st degree for reaching the team (the People screen's best path). */
export const GRAPH_TIER_RANK: Record<ContactTier, number> = { warm_hiring: 0, bridge: 1, warm_other: 2, cold_hiring: 3, cold_other: 4 };

/** The tier a mutual with no role link of its own is drawn with: 1st degree, not on the hiring team. */
export const MUTUAL_TIER: ContactTier = 'warm_other';

export interface GraphPerson {
  contact: Contact;
  link: ContactLink;
  paths?: ConnectPaths | null;
}

export interface GraphInput {
  company: { id: string; name: string };
  /** The role's linked people (roles.get `contacts`), in their stored order. */
  people: readonly GraphPerson[];
  /** Contacts named by a `via_contact_id`, looked up by id (the mutuals). Missing ones are skipped. */
  contactById: (id: string) => Pick<Contact, 'id' | 'name'> | undefined;
}

/** The person the primary action is for: the warmest tier, first in stored order on a tie. */
export function bestTarget(people: readonly GraphPerson[]): GraphPerson | undefined {
  return [...people].sort((a, b) => GRAPH_TIER_RANK[a.link.tier] - GRAPH_TIER_RANK[b.link.tier])[0];
}

export function buildRoleGraph(input: GraphInput): RoleGraph {
  const coId = companyNodeId(input.company.id);
  const nodes: RoleGraphNode[] = [{ id: ME_NODE, kind: 'me', name: 'You' }];
  const byId = new Map<string, RoleGraphNode>();
  const linked = new Map<string, GraphPerson>();

  for (const p of input.people) {
    if (byId.has(p.contact.id)) continue;
    const node: RoleGraphNode = {
      id: p.contact.id,
      kind: 'person',
      contact_id: p.contact.id,
      name: p.contact.name,
      degree: p.link.degree,
      tier: p.link.tier,
      // #132: the hiring team, or a person the skill judged on the team side (e.g. the product brand's design lead).
      team_side: p.link.is_hiring_team || p.link.team_side === true,
    };
    byId.set(node.id, node);
    linked.set(node.id, p);
    nodes.push(node);
  }

  // Mutuals with no role link: derived from the targets that name them.
  const viaOf = (p: GraphPerson): string | null => (p.link.degree === '2' && p.link.via_contact_id ? p.link.via_contact_id : null);
  const mutualAtCompany = new Set<string>();
  for (const p of linked.values()) {
    const via = viaOf(p);
    if (!via) continue;
    if (p.link.via_tie_json?.same_company) mutualAtCompany.add(via);
    if (byId.has(via)) continue;
    const c = input.contactById(via);
    if (!c) continue;
    const node: RoleGraphNode = {
      id: c.id,
      kind: 'person',
      contact_id: c.id,
      name: c.name,
      degree: '1',
      tier: MUTUAL_TIER,
      team_side: false,
    };
    byId.set(node.id, node);
    nodes.push(node);
  }
  nodes.push({ id: coId, kind: 'company', name: input.company.name });

  const edges: RoleGraphEdge[] = [];
  const seen = new Set<string>();
  const edge = (e: RoleGraphEdge) => {
    const key = `${e.from}|${e.to}|${e.kind}`;
    if (seen.has(key) || e.from === e.to) return;
    seen.add(key);
    edges.push(e);
  };
  for (const n of nodes) {
    if (n.kind === 'person' && n.degree === '1') edge({ from: ME_NODE, to: n.id, kind: 'knows', degree: '1' });
  }
  for (const p of linked.values()) {
    const via = viaOf(p);
    if (via && byId.has(via)) edge({ from: via, to: p.contact.id, kind: 'via', degree: '2' });
  }
  for (const n of nodes) {
    if (n.kind !== 'person') continue;
    const p = linked.get(n.id);
    if (p) edge({ from: n.id, to: coId, kind: p.link.is_hiring_team ? 'hiring' : p.link.team_side ? 'team' : 'works_at' });
    else if (mutualAtCompany.has(n.id)) edge({ from: n.id, to: coId, kind: 'works_at' });
  }

  // The recommended path: me -> (mutual on a bridge) -> target -> company.
  const best = bestTarget([...linked.values()]);
  if (best) {
    const t = best.contact.id;
    const via = viaOf(best);
    const bridge = best.paths ? best.paths.chosen === 'bridge' : !!via;
    const hop = bridge && via && byId.has(via) ? via : null;
    const onPath = new Set([ME_NODE, t, coId, ...(hop ? [hop] : [])]);
    for (const n of nodes) n.recommended = onPath.has(n.id);
    for (const e of edges) {
      e.recommended =
        (hop ? (e.from === ME_NODE && e.to === hop) || (e.from === hop && e.to === t) : e.from === ME_NODE && e.to === t) ||
        (e.from === t && e.to === coId);
    }
    // Draw the recommended path last (on top).
    edges.sort((a, b) => Number(!!a.recommended) - Number(!!b.recommended));
  } else {
    for (const n of nodes) n.recommended = false;
    for (const e of edges) e.recommended = false;
  }
  return { nodes, edges };
}
