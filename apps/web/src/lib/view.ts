import type { Decision, ProfileDiff, ProfileVersion } from '@perfect-placement/contracts';
import type { DecisionView } from '../components/decision';
import type { GraphEdge, GraphNode } from '../components/people';
import type { TileData } from '../components/roles';
import { bandColor } from '../components/theme';
import { altsOf, DOC_NAME, emailOf, factCheckOf, objectOf, pickOf, SHORT_Q, valueLabel } from './decisions';
import { ago, humanize } from './format';
import { bestPath, initials, type Person } from './people';
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
  | { t: 'c'; chips: string[] };

/** Skeleton bars for a document that does not exist yet (documents themselves render as markdown, #35). */
export const DOC_SKELETON: readonly DocLine[] = [
  { t: 'b', w: '84%' },
  { t: 'b', w: '62%' },
  { t: 'b', w: '70%' },
  { t: 'b', w: '44%' },
];

/**
 * The answers file (#42) as doc lines: groups (Needs you, Written, Standard, Portal fills) as headings,
 * each question as a key, a needs-you reason as a muted line, portal fills as chips.
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

export function decisionView(d: Decision, ctx: DecisionCtx): DecisionView {
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
export function graphLayout(
  people: readonly Person[],
  co: { letter: string; name: string },
): { nodes: GraphNode[]; edges: GraphEdge[]; best?: string } {
  const bp = bestPath(people);
  const best = bp?.target.contact.id;
  const colOf = (p: Person) => (p.link.is_hiring_team || p.link.degree === 'cold' ? 820 : p.link.degree === '1' ? 340 : 590);
  const groups = new Map<number, Person[]>();
  for (const p of people) groups.set(colOf(p), [...(groups.get(colOf(p)) ?? []), p]);
  const nodes: GraphNode[] = [{ id: 'you', ini: 'You', name: '', x: 90, y: 290, kind: 'you' }];
  for (const [x, ps] of groups) {
    const step = ps.length > 1 ? 300 / (ps.length - 1) : 0;
    ps.forEach((p, i) => {
      nodes.push({
        id: p.contact.id,
        ini: initials(p.contact.name),
        name: p.contact.name,
        x,
        y: ps.length > 1 ? 150 + i * step : 290,
        kind: 'person',
        tier: p.link.tier,
        best: p.contact.id === best,
      });
    });
  }
  nodes.push({ id: 'co', ini: co.letter, name: co.name, x: 950, y: 300, kind: 'co' });
  const edges: GraphEdge[] = [];
  for (const p of people) {
    const via = p.link.via_contact_id;
    if (via) edges.push({ a: via, b: p.contact.id, k: 'bridge' });
    else if (p.link.degree !== 'cold') edges.push({ a: 'you', b: p.contact.id, k: p.contact.id === best ? 'best' : 'warm' });
    if (colOf(p) === 820) edges.push({ a: p.contact.id, b: 'co', k: 'team' });
  }
  return { nodes, edges, best };
}

// ------------------------------------------------------------ profile timeline

export const timeline = (versions: readonly ProfileVersion[]) =>
  versions.map((v, i) => ({ v: `v${i + 1}`, event: humanize(v.reason), date: shortDate(v.created_at) })).reverse();
