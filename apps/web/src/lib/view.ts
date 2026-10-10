import type { Decision, ProfileDiff, ProfileVersion, QueuedDecision, RoleGraph, RoleGraphNode } from '@perfect-placement/contracts';
import { STATUS_LABEL } from '../components/controls';
import type { DecisionView } from '../components/decision';
import type { GraphEdge, GraphNode } from '../components/people';
import type { TileData } from '../components/roles';
import { bandColor } from '../components/theme';
import { altsOf, checkLabels, DOC_NAME, emailOf, factCheckOf, objectOf, pickOf, SHORT_Q, valueLabel } from './decisions';
import { ago, humanize } from './format';
import { initials } from './people';
import { COMPONENT_NAME, chipsOf } from './profile';
import { freshOf, type RoleView } from './role';

/*
 * View models: turn op outputs into the shapes the prototype screens render.
 * Pure display mapping; no decisions or mechanics live here.
 */

type Bands = { green_min: number; yellow_min: number };

export const tile = (v: RoleView, now: Date, bands?: Bands): TileData => {
  const fit = v.latest_score ? Math.round(v.latest_score.total) : null;
  return {
    id: v.role.id,
    letter: v.company.name.slice(0, 1),
    fresh: freshOf(v.role, now),
    title: v.role.title,
    co: v.company.name,
    fit,
    band: bandColor(fit, bands),
    url: v.role.url,
    tag: v.role.status === 'on-deck' ? STATUS_LABEL['on-deck'] : null,
  };
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Thu 08 Oct" */
export const dayEyebrow = (d: Date) => `${DAYS[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]}`;
/** "Oct 8" */
export const shortDate = (iso: string) => {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};
/** "06:14" */
export const hhmm = (iso: string) => iso.slice(11, 16);

// ------------------------------------------------------------ documents

export type DocLine =
  | { t: 'h'; text: string }
  | { t: 's'; text: string }
  | { t: 'k'; text: string }
  | { t: 't'; text: string }
  | { t: 'b'; w: string }
  | { t: 'c'; chips: string[] }
  /** Who saved the answer above (#81): `ask` = Saved from Ask. */
  | { t: 'p'; source: 'ask' };

/** Skeleton bars for a document that does not exist yet (documents themselves render as markdown, #35). */
export const DOC_SKELETON: readonly DocLine[] = [
  { t: 'b', w: '84%' },
  { t: 'b', w: '62%' },
  { t: 'b', w: '70%' },
  { t: 'b', w: '44%' },
];

/**
 * The answers file (#42) as doc lines: groups (Needs you, Written, Standard, Portal fills) as headings,
 * each question as a key, a needs-you reason as a muted line, portal fills as chips, and an answer saved
 * from Ask with its provenance tag (#81).
 */
export function answerLines(md: string | null | undefined): DocLine[] {
  if (!md) return [...DOC_SKELETON];
  const out: DocLine[] = [];
  let fills: string[] | null = null;
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (!line || /^# /.test(line)) continue;
    const g = /^## (.*)$/.exec(line);
    if (g) {
      if (fills?.length) out.push({ t: 'c', chips: fills });
      fills = g[1] === 'Portal fills' ? [] : null;
      out.push({ t: 'h', text: g[1] as string });
      continue;
    }
    const q = /^### (.*)$/.exec(line);
    if (q) out.push({ t: 'k', text: q[1] as string });
    else if (line === '_Saved from Ask_') out.push({ t: 'p', source: 'ask' });
    else if (fills && /^[-*]\s/.test(line)) fills.push(line.replace(/^[-*]\s+/, ''));
    else if (line.startsWith('>')) out.push({ t: 's', text: line.replace(/^>\s*/, '') });
    else out.push({ t: 't', text: line.replace(/^_(.*)_$/, '$1') });
  }
  if (fills?.length) out.push({ t: 'c', chips: fills });
  return out;
}

// ------------------------------------------------------------ decisions

export interface DecisionCtx {
  role?: RoleView & { application?: { package_paths_json: Record<string, string> } | null };
  diff?: ProfileDiff;
  outreach?: { name: string; headline: string | null; tierLabel: string; hook: string; ask: string };
  contact?: { name: string; headline: string | null; source: string; tierLabel?: string };
  now: Date;
}

const diffChips = (o: Record<string, unknown>) => chipsOf(o).map((c) => (c.value ? `${c.label} ${c.value}` : c.label));

/** Evidence shown on the Checked line, kept short (#102). */
export const EVIDENCE_MAX = 80;
const short = (s: string) => (s.length > EVIDENCE_MAX ? `${s.slice(0, EVIDENCE_MAX - 1).trimEnd()}…` : s);

/**
 * A role decision (#102) gets the posting url (Open posting) and, for freshness, when it was last checked
 * and the evidence, from the queue's `subject_role`.
 */
export function decisionView(d: QueuedDecision, ctx: DecisionCtx): DecisionView {
  const v = viewOf(d, ctx);
  const sr = d.subject_type === 'role' ? d.subject_role : undefined;
  if (!sr) return v;
  const out: DecisionView = sr.url ? { ...v, url: sr.url } : v;
  if (d.kind !== 'freshness.closed') return out;
  const when = sr.last_checked_at ? `${ago(sr.last_checked_at, ctx.now)} ago` : 'Never';
  return { ...out, checked: sr.freshness_evidence ? `${when} · ${short(sr.freshness_evidence)}` : when };
}

function viewOf(d: Decision, ctx: DecisionCtx): DecisionView {
  const object = objectOf(d);
  const pick = pickOf(d);
  const base = {
    object,
    question: SHORT_Q[d.kind],
    impact: d.impact,
    pick: valueLabel(d.kind, pick),
    resolver: d.backend.toUpperCase(),
    p: d.p,
    alts: altsOf(d).map((v) => ({ value: v, label: valueLabel(d.kind, v) })),
  };
  const fc = factCheckOf(d);
  if (fc) {
    // #54: the claim, the document line it is on, the closest source line; keep / remove / edit.
    const fact = {
      ...base,
      question: `Keep "${fc.claim}"?`,
      alts: base.alts.filter((a) => a.value !== 'other'),
      edit: fc.line,
      evidence: [
        { k: DOC_NAME[fc.doc], d: fc.line },
        { k: 'Source', d: fc.source ?? 'none found' },
      ],
    };
    if (ctx.role)
      return {
        ...fact,
        letter: ctx.role.company.name.slice(0, 1),
        fresh: freshOf(ctx.role.role, ctx.now),
        objTitle: ctx.role.role.title,
        objSub: `${ctx.role.company.name} · ${DOC_NAME[fc.doc]}`,
      };
    return { ...fact, objTitle: d.subject_id, objSub: DOC_NAME[fc.doc] };
  }
  const em = emailOf(d);
  if (em) {
    // #37: the guessed address, the other candidates, and a field to type the right one.
    const name = ctx.contact?.name ?? em.name;
    return {
      ...base,
      question: `Use ${String(pick)}?`,
      alts: base.alts.filter((a) => a.value !== 'other'),
      edit: String(pick ?? ''),
      ini: initials(name || '?'),
      objTitle: name || d.subject_id,
      objSub: ctx.contact?.headline ?? em.domain,
      evidence: [
        { k: 'Format', d: em.pattern ? `${em.pattern} · ${em.examples} seen` : 'none seen' },
        { k: 'Domain', d: `${em.domain} · ${em.mx === true ? 'MX found' : em.mx === false ? 'no MX' : 'MX unknown'}` },
      ],
      // #99: each candidate still offered, its evidence labels, and the user's own check (Check, Valid, Invalid).
      emailChecks: em.candidates.map((c) => ({ address: c.email, labels: checkLabels(c.check) })),
    };
  }
  if (ctx.role) {
    const r = ctx.role.role;
    const ev =
      d.kind === 'freshness.closed'
        ? [
            { k: humanize(r.freshness), d: r.last_checked_at ? `checked ${ago(r.last_checked_at, ctx.now)}` : 'never checked' },
            { k: `Posted ${ago(r.posted_at, ctx.now)}`, d: humanize(r.source) },
          ]
        : d.kind === 'inbox.classify'
          ? [
              { k: 'Gmail', d: hhmm(d.ts) },
              { k: humanize(r.status), d: r.title },
            ]
          : d.kind === 'apply.submit'
            ? Object.keys(ctx.role.application?.package_paths_json ?? {}).map((k) => ({ k: humanize(k), d: 'ready' }))
            : [{ k: humanize(r.source), d: humanize(r.status) }];
    if (d.kind === 'inbox.classify')
      return { ...base, objTitle: `Re: ${r.title}`, objSub: `${ctx.role.company.name} · ${hhmm(d.ts)}`, evidence: ev };
    return {
      ...base,
      letter: ctx.role.company.name.slice(0, 1),
      fresh: freshOf(r, ctx.now),
      objTitle: r.title,
      objSub: ctx.role.company.name,
      evidence: ev,
    };
  }
  if (ctx.diff) {
    const dj = ctx.diff.diff_json as { before?: Record<string, unknown>; after?: Record<string, unknown> };
    const name = COMPONENT_NAME[ctx.diff.component_key];
    const after = diffChips(dj.after ?? {});
    return {
      ...base,
      ini: name.slice(0, 2),
      objTitle: name,
      objSub: humanize(ctx.diff.impact),
      before: diffChips(dj.before ?? {}),
      pick: pick === true && after.length ? after.join(' · ') : base.pick,
      evidence: ctx.diff.evidence_json.map((e) => ({ k: e, d: 'evidence' })),
    };
  }
  if (ctx.outreach)
    return {
      ...base,
      ini: initials(ctx.outreach.name),
      objTitle: ctx.outreach.name,
      objSub: ctx.outreach.headline ?? '',
      evidence: [
        { k: ctx.outreach.tierLabel, d: 'tier' },
        { k: 'Hook', d: ctx.outreach.hook },
        { k: 'Ask', d: ctx.outreach.ask },
      ],
    };
  if (ctx.contact)
    return {
      ...base,
      ini: initials(ctx.contact.name),
      objTitle: ctx.contact.name,
      objSub: ctx.contact.headline ?? '',
      evidence: [{ k: ctx.contact.tierLabel ?? '—', d: humanize(ctx.contact.source) }],
    };
  return { ...base, objTitle: d.subject_id, objSub: '', evidence: [] };
}

// ------------------------------------------------------------ people graph

/** Lay out You -> 1st -> 2nd -> hiring team in the prototype's 1000 x 580 space. */
export function graphLayout(graph: RoleGraph): { nodes: GraphNode[]; edges: GraphEdge[]; best?: string; co?: string } {
  // #131: nodes and edges come from the engine (roles.get graph); this only places them in columns.
  const co = graph.nodes.find((n) => n.kind === 'company');
  const best = graph.edges.find((e) => e.recommended && e.to === co?.id)?.from;
  const colOf = (n: RoleGraphNode) => (n.team_side || n.degree === 'cold' ? 820 : n.degree === '1' ? 340 : 590);
  const groups = new Map<number, RoleGraphNode[]>();
  for (const n of graph.nodes) if (n.kind === 'person') groups.set(colOf(n), [...(groups.get(colOf(n)) ?? []), n]);
  const nodes: GraphNode[] = [];
  for (const n of graph.nodes) if (n.kind === 'me') nodes.push({ id: n.id, ini: 'You', name: '', x: 90, y: 290, kind: 'you' });
  for (const [x, ns] of [...groups].sort((p, q) => p[0] - q[0])) {
    const step = ns.length > 1 ? 300 / (ns.length - 1) : 0;
    ns.forEach((n, i) => {
      nodes.push({
        id: n.id,
        ini: initials(n.name),
        name: n.name,
        x,
        y: ns.length > 1 ? 150 + i * step : 290,
        kind: 'person',
        tier: n.tier,
        best: n.id === best,
      });
    });
  }
  if (co) nodes.push({ id: co.id, ini: co.name.slice(0, 1), name: co.name, x: 950, y: 300, kind: 'co' });
  const hasBest = graph.edges.some((e) => e.recommended);
  const edges: GraphEdge[] = graph.edges.map((e) => ({
    a: e.from,
    b: e.to,
    k: e.recommended ? 'best' : e.kind === 'knows' ? 'warm' : e.kind === 'via' ? 'bridge' : 'team',
    muted: hasBest && !e.recommended,
  }));
  return { nodes, edges, best, co: co?.id };
}

// ------------------------------------------------------------ profile timeline

export const timeline = (versions: readonly ProfileVersion[]) =>
  versions.map((v, i) => ({ v: `v${i + 1}`, event: humanize(v.reason), date: shortDate(v.created_at) })).reverse();
