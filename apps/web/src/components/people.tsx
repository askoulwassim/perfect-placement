import { type ContactTier, TIER_RING } from '@perfect-placement/contracts';
import { Fragment } from 'react';
import { type Person, TIER_LABEL, initials as toInitials } from '../lib/people';
import { cv } from './glyphs';

// ---------------------------------------------------------- ContactAvatar

export function ContactAvatar({ initials, tier, size = 40, you }: { initials: string; tier?: ContactTier; size?: number; you?: boolean }) {
  const ring = tier ? TIER_RING[tier] : { color: 'emerald' as const, dashed: false };
  const r = size / 2 - 2;
  return (
    <span
      className={`avatar ${you ? 'avatar--you' : ''}`}
      data-tier={tier ?? 'you'}
      style={{ width: size, height: size }}
      title={tier ? TIER_LABEL[tier] : 'You'}
    >
      <svg aria-hidden="true" width={size} height={size}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill={you ? cv('emerald') : cv('panel-2')}
          stroke={cv(ring.color)}
          strokeWidth={2.5}
          strokeDasharray={ring.dashed ? '4 3' : undefined}
        />
      </svg>
      <span className="avatar__initials" style={{ fontSize: size * 0.34 }}>
        {initials}
      </span>
    </span>
  );
}

// ----------------------------------------------------------- BestPathPill

export function BestPathPill({ path }: { path: readonly string[] }) {
  return (
    <span className="best-path">
      {path.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: hops are positional
        <Fragment key={i}>
          {i > 0 && <span className="best-path__arrow">→</span>}
          <span className="best-path__hop">{p}</span>
        </Fragment>
      ))}
    </span>
  );
}

// ------------------------------------------------------------ PeopleGraph

export interface GraphNode {
  id: string;
  label: string;
  initials: string;
  tier?: ContactTier;
  col: 0 | 1 | 2 | 3;
}
export interface GraphEdge {
  from: string;
  to: string;
  tier: ContactTier;
}

/** You -> 1st -> 2nd -> hiring team, left to right. */
export function graphOf(people: readonly Person[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [{ id: 'you', label: 'You', initials: 'You', col: 0 }];
  const edges: GraphEdge[] = [];
  for (const { contact, link } of people) {
    const col = link.is_hiring_team ? 3 : link.degree === '1' ? 1 : 2;
    nodes.push({ id: contact.id, label: contact.name, initials: toInitials(contact.name), tier: link.tier, col });
    edges.push({ from: link.via_contact_id ?? 'you', to: contact.id, tier: link.tier });
  }
  return { nodes, edges };
}

const COL_X = [0.08, 0.36, 0.64, 0.9];
const COL_LABEL = ['You', '1st', '2nd', 'Hiring'];

export function PeopleGraph({
  nodes,
  edges,
  selected,
  best,
  onSelect,
  height = 420,
}: {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  selected?: string | null;
  best?: readonly string[];
  onSelect?: (id: string) => void;
  height?: number;
}) {
  const pos = new Map<string, { x: number; y: number }>();
  for (const col of [0, 1, 2, 3] as const) {
    const inCol = nodes.filter((n) => n.col === col);
    inCol.forEach((n, i) => {
      pos.set(n.id, { x: COL_X[col] as number, y: (i + 1) / (inCol.length + 1) });
    });
  }
  const onBest = (e: GraphEdge) => !!best && best.includes(e.to) && (e.from === 'you' || best.includes(e.from));
  return (
    <div className="graph" style={{ height }}>
      <div className="graph__cols" aria-hidden="true">
        {COL_LABEL.map((l, i) => (
          <span key={l} className="eyebrow" style={{ left: `${(COL_X[i] as number) * 100}%` }}>
            {l}
          </span>
        ))}
      </div>
      <svg className="graph__edges" aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none">
        {edges.map((e) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (!a || !b) return null;
          const ring = TIER_RING[e.tier];
          return (
            <line
              key={`${e.from}-${e.to}`}
              x1={a.x * 100}
              y1={a.y * 100}
              x2={b.x * 100}
              y2={b.y * 100}
              stroke={cv(ring.color)}
              strokeWidth={onBest(e) ? 3 : 1.5}
              strokeDasharray={ring.dashed ? '5 4' : undefined}
              vectorEffect="non-scaling-stroke"
              opacity={onBest(e) ? 1 : 0.7}
            />
          );
        })}
      </svg>
      {nodes.map((n) => {
        const p = pos.get(n.id);
        if (!p) return null;
        const style = { left: `${p.x * 100}%`, top: `${p.y * 100}%` };
        if (n.id === 'you')
          return (
            <span key={n.id} className="graph__node" style={style}>
              <ContactAvatar initials="You" you size={52} />
            </span>
          );
        return (
          <button
            key={n.id}
            type="button"
            className={`graph__node ${selected === n.id ? 'is-selected' : ''} ${best?.includes(n.id) ? 'is-best' : ''}`}
            style={style}
            data-op="local"
            onClick={() => onSelect?.(n.id)}
          >
            <ContactAvatar initials={n.initials} tier={n.tier} size={44} />
            <span className="graph__label">{n.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------- OutreachBlock

export function OutreachBlock({ label, text }: { label: 'Hook' | 'Proof' | 'Ask'; text: string }) {
  return (
    <section className="outreach-block">
      <span className="eyebrow">{label}</span>
      <p className="outreach-block__text">{text}</p>
    </section>
  );
}
