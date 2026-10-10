import type { ConnectFallback, ConnectPath, ConnectPaths, ContactTier, OutreachStatus } from '@perfect-placement/contracts';
import { Fragment } from 'react';
import { FALLBACK_LABEL } from '../lib/people';
import { Btn } from './Btn';
import { DraftStatusChip, SecondaryButton } from './controls';
import { C, ellipsis, eyebrow, mono, X } from './theme';

// ------------------------------------------------------------ tiers (prototype TIER table)

export const TIER_VIS: Record<ContactTier, { ring: string; c: string; label: string; tone: number }> = {
  warm_hiring: { ring: `2.5px solid ${C.emerald}`, c: C.emerald, label: 'Warm · hiring', tone: 0 },
  warm_other: { ring: `3px solid ${C['emerald-deep']}`, c: C['emerald-2'], label: 'Warm', tone: 1 },
  bridge: { ring: `2px dashed ${C.emerald}`, c: C.emerald, label: 'Bridge', tone: 2 },
  cold_hiring: { ring: `2px solid ${C.sky}`, c: C.sky, label: 'Cold · hiring', tone: 3 },
  cold_other: { ring: `2px dashed ${C.dim}`, c: C.dim, label: 'Cold', tone: 3 },
};
export const TIER_ORDER: readonly ContactTier[] = ['warm_hiring', 'warm_other', 'bridge', 'cold_hiring', 'cold_other'];
export const TONES = ['Ask for the conversation', 'Coffee or intro', 'Forwardable blurb', 'Positioning note'] as const;

// ------------------------------------------------------------ ContactAvatar

export function ContactAvatar({
  initials,
  tier,
  size = 38,
  font = 11,
}: {
  initials: string;
  tier: ContactTier;
  size?: number;
  font?: number;
}) {
  return (
    <span
      className="avatar"
      data-tier={tier}
      title={TIER_VIS[tier].label}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: C['panel-2'],
        border: TIER_VIS[tier].ring,
        display: 'grid',
        placeItems: 'center',
        ...mono(font),
        flex: 'none',
        color: C.fg,
        boxSizing: 'border-box',
      }}
    >
      {initials}
    </span>
  );
}

// ------------------------------------------------------------ BestPathPill

/** "You → [MR] Maya R." on emerald-deep. */
export function BestPathPill({
  initials,
  name,
  tier,
  via,
  onClick,
  mobile,
}: {
  initials: string;
  name: string;
  tier: ContactTier;
  via?: string[];
  onClick?: () => void;
  mobile?: boolean;
}) {
  const dot = (t: string, you?: boolean) => (
    <span
      style={{
        width: 30,
        height: 30,
        borderRadius: '50%',
        background: you ? C.emerald : C['panel-2'],
        color: you ? C['emerald-ink'] : C.fg,
        border: you ? undefined : TIER_VIS[tier].ring,
        display: 'grid',
        placeItems: 'center',
        ...mono(10),
        fontWeight: you ? 700 : 400,
        boxSizing: 'border-box',
      }}
    >
      {t}
    </span>
  );
  return (
    <Btn
      op={null}
      className="best-path"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 16px 6px 6px',
        borderRadius: 999,
        background: C['emerald-deep'],
        border: 0,
        color: C.fg,
        ...(mobile ? { marginTop: 22, minHeight: 44 } : { marginBottom: 20 }),
      }}
      hover={{ background: X.bestHover }}
    >
      {dot('You', true)}
      <span style={{ color: C.emerald }}>→</span>
      {via?.map((v) => (
        <Fragment key={v}>
          <span style={{ fontSize: 12, color: C.muted }}>{v}</span>
          <span style={{ color: C.emerald }}>→</span>
        </Fragment>
      ))}
      {dot(initials)}
      <span style={{ fontSize: 13, fontWeight: 600 }}>{name}</span>
    </Btn>
  );
}

// ------------------------------------------------------------ PeopleGraph

export interface GraphNode {
  id: string;
  ini: string;
  name: string;
  /** Position in the prototype's 1000 x 580 space. */
  x: number;
  y: number;
  kind: 'you' | 'person' | 'co';
  tier?: ContactTier;
  best?: boolean;
}
export type EdgeKind = 'best' | 'warm' | 'bridge' | 'team';
export interface GraphEdge {
  a: string;
  b: string;
  k: EdgeKind;
}

const EDGE_STYLE: Record<EdgeKind, [string, number, string | undefined, number]> = {
  best: [C.emerald, 3, undefined, 1],
  warm: [C['emerald-2'], 2, undefined, 0.9],
  bridge: [C.emerald, 1.6, '6 6', 0.75],
  team: [C['line-2'], 1.4, undefined, 1],
};

export function PeopleGraph({
  nodes,
  edges,
  bestTarget,
  onOpen,
}: {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  bestTarget?: string;
  onOpen?: (id: string) => void;
}) {
  const pos = new Map(nodes.map((n) => [n.id, n]));
  const you = pos.get('you');
  const target = bestTarget ? pos.get(bestTarget) : undefined;
  return (
    <div
      className="people-graph"
      style={{
        position: 'relative',
        background: C['bg-2'],
        borderRadius: 12,
        height: 580,
        overflow: 'hidden',
        flex: '1 1 760px',
        minWidth: 760,
      }}
    >
      {[
        ['YOU', '9%'],
        ['1ST', '34%'],
        ['2ND', '59%'],
        ['HIRING TEAM', '86%'],
      ].map(([l, x]) => (
        <div
          key={l}
          style={{ position: 'absolute', top: 18, left: x, transform: 'translateX(-50%)', ...mono(10, C.dim), letterSpacing: '.1em' }}
        >
          {l}
        </div>
      ))}
      <div style={{ position: 'absolute', inset: 0 }}>
        <svg
          aria-hidden="true"
          viewBox="0 0 1000 580"
          preserveAspectRatio="none"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
        >
          {you && target && (
            <line
              x1={you.x}
              y1={you.y}
              x2={target.x}
              y2={target.y}
              stroke={C.emerald}
              strokeOpacity={0.14}
              strokeWidth={12}
              vectorEffect="non-scaling-stroke"
              strokeLinecap="round"
            />
          )}
          {edges.map((e) => {
            const a = pos.get(e.a);
            const b = pos.get(e.b);
            if (!a || !b) return null;
            const [stroke, w, dash, op] = EDGE_STYLE[e.k];
            return (
              <line
                key={`${e.a}-${e.b}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={stroke}
                strokeWidth={w}
                strokeDasharray={dash}
                strokeOpacity={op}
                vectorEffect="non-scaling-stroke"
                strokeLinecap="round"
              />
            );
          })}
        </svg>
      </div>
      {nodes.map((n) => {
        const isYou = n.kind === 'you';
        const isCo = n.kind === 'co';
        return (
          <Btn
            key={n.id}
            op={isYou ? 'local' : null}
            className="graph__node"
            data-node={n.id}
            onClick={() => onOpen?.(n.id)}
            style={{
              position: 'absolute',
              left: `${n.x / 10}%`,
              top: `${n.y / 5.8}%`,
              transform: 'translate(-50%,-26px)',
              background: 'none',
              border: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 8,
              color: C.fg,
              cursor: isYou ? 'default' : 'pointer',
            }}
          >
            <span
              style={{
                width: 52,
                height: 52,
                borderRadius: isCo ? 14 : '50%',
                background: isYou ? C.emerald : C['panel-2'],
                border: isYou ? `2px solid ${C.emerald}` : isCo ? `1px solid ${C['line-2']}` : n.tier ? TIER_VIS[n.tier].ring : undefined,
                display: 'grid',
                placeItems: 'center',
                ...mono(13),
                fontWeight: 500,
                color: isYou ? C['emerald-ink'] : C.fg,
                boxShadow: isYou || n.best ? `0 0 0 6px ${X.em15}` : 'none',
                boxSizing: 'border-box',
              }}
            >
              {n.ini}
            </span>
            <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>{n.name}</span>
          </Btn>
        );
      })}
      <div style={{ position: 'absolute', left: 20, bottom: 18, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {TIER_ORDER.map((t) => (
          <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 7, ...mono(10, C.muted), letterSpacing: '.06em' }}>
            <span style={{ width: 14, height: 14, borderRadius: '50%', border: TIER_VIS[t].ring, boxSizing: 'border-box' }} />
            {TIER_VIS[t].label}
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ PersonRow

export function PersonRow({
  id,
  ini,
  name,
  role,
  tier,
  status,
  best,
  onOpen,
  mobile,
  email,
}: {
  id: string;
  ini: string;
  name: string;
  role: string;
  tier: ContactTier;
  status: OutreachStatus | 'none';
  best?: boolean;
  /** #37: the address with its source and confidence ("Guess 45%"). */
  email?: { address: string; tag: string; sure: boolean } | null;
  onOpen?: () => void;
  mobile?: boolean;
}) {
  return (
    <Btn
      op={null}
      className="person"
      data-contact={id}
      onClick={onOpen}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        padding: mobile ? '10px 4px' : '10px 12px',
        borderRadius: 10,
        border: 0,
        background: best ? X.deep35 : 'transparent',
        color: C.fg,
        textAlign: 'left',
        minHeight: mobile ? 56 : undefined,
      }}
      hover={{ background: C.panel }}
    >
      <ContactAvatar initials={ini} tier={tier} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>{name}</span>
        <span style={{ display: 'block', fontSize: 12, color: C.muted, ...ellipsis }}>{role}</span>
        {email && <EmailLine {...email} />}
      </span>
      <DraftStatusChip status={status} size={mobile ? 10 : 10.5} pad={mobile ? '0' : '3px 9px'} />
    </Btn>
  );
}

// ------------------------------------------------------------ EmailLine

/** Address + source and confidence (#37). Gold while it is an unconfirmed guess. */
export function EmailLine({ address, tag, sure, size = 11 }: { address: string; tag: string; sure: boolean; size?: number }) {
  return (
    <span className="person__email" data-sure={sure} style={{ display: 'flex', gap: 8, marginTop: 3, minWidth: 0, ...mono(size, C.dim) }}>
      <span style={{ ...ellipsis, minWidth: 0 }}>{address}</span>
      <span style={{ flex: 'none', color: sure ? C.emerald : C.gold }}>{tag}</span>
    </span>
  );
}

// ------------------------------------------------------------ OutreachBlock

export function OutreachBlock({ label, text, mobile }: { label: 'Hook' | 'Proof' | 'Ask'; text: string; mobile?: boolean }) {
  if (mobile)
    return (
      <div className="outreach-block" style={{ padding: '16px 0', borderBottom: `1px solid ${C.line}` }}>
        <div style={{ ...eyebrow(C.emerald, 9.5), letterSpacing: '.12em', marginBottom: 6 }}>{label}</div>
        <div style={{ fontSize: 15, lineHeight: 1.5 }}>{text}</div>
      </div>
    );
  return (
    <div
      className="outreach-block"
      style={{
        display: 'grid',
        gridTemplateColumns: '64px minmax(0,1fr)',
        gap: 16,
        padding: '22px 0',
        borderBottom: `1px solid ${C.line}`,
      }}
    >
      <div style={{ ...eyebrow(C.emerald, 10), letterSpacing: '.12em', paddingTop: 5 }}>{label}</div>
      <div style={{ fontSize: 18, lineHeight: 1.55, textWrap: 'pretty' }}>{text}</div>
    </div>
  );
}

// ------------------------------------------------------------ Connect fallback (#78)

/**
 * Which no-contact fallback Connect used ("Hiring team", "Cold leader", "Skipped") and, on the Connect
 * stage, the Skip action (`apply.skip_connect`). Renders nothing when neither applies.
 */
export function ConnectFallbackBar({
  fallback,
  onSkip,
  mobile,
}: {
  fallback: ConnectFallback | null;
  /** Set only while the role is on the Connect stage. */
  onSkip?: (() => void) | null;
  mobile?: boolean;
}) {
  if (!fallback && !onSkip) return null;
  return (
    <div className="connect-fallback" style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 12px', flexWrap: 'wrap' }}>
      {fallback && (
        <span
          data-fallback={fallback}
          style={{
            ...eyebrow(fallback === 'skipped' ? C.muted : C.sky, mobile ? 9.5 : 10),
            border: `1px solid ${C['line-2']}`,
            borderRadius: 999,
            padding: '4px 10px',
          }}
        >
          {FALLBACK_LABEL[fallback]}
        </span>
      )}
      {onSkip && (
        <SecondaryButton
          op="apply.skip_connect"
          label="Skip"
          height={mobile ? 26 : 30}
          onClick={onSkip}
          style={{ fontSize: mobile ? 12 : 13, borderRadius: 999 }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------ Path choice (#98)

const firstName = (name: string) => name.split(' ')[0] ?? name;

/**
 * Direct vs bridge for a 2nd-degree hiring-team target: the recommended path first, each with its one-line
 * reason; **Use** (`people.set_path`) switches before drafting. A blocked bridge has no button.
 */
export function PathChoice({
  paths,
  onPick,
  status,
  mobile,
}: {
  paths: ConnectPaths;
  onPick?: ((path: ConnectPath) => void) | null;
  /** #98: the draft on each path (both may exist, each under its recipient). */
  status?: (path: ConnectPath) => OutreachStatus | 'none';
  mobile?: boolean;
}) {
  return (
    <div className="connect-paths" style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '4px 0 14px' }}>
      <div style={{ ...eyebrow(), margin: '0 0 4px 12px' }}>Path</div>
      {paths.options.map((o) => {
        const chosen = o.path === paths.chosen;
        return (
          <div
            key={o.path}
            className="connect-path"
            data-path={o.path}
            data-chosen={chosen}
            data-recommended={o.path === paths.recommended}
            data-blocked={o.blocked}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: mobile ? '8px 4px' : '8px 12px',
              borderRadius: 10,
              background: chosen ? X.deep35 : 'transparent',
              border: `1px solid ${chosen ? C.emerald : C.line}`,
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 14, fontWeight: 600 }}>
                {o.path === 'direct' ? `To ${firstName(o.name)}` : `Via ${firstName(o.name)}`}
                {o.path === paths.recommended && <span style={{ ...eyebrow(C.emerald, 9.5) }}>Recommended</span>}
              </span>
              <span className="connect-path__reason" style={{ display: 'block', fontSize: 12, color: C.muted, ...ellipsis }}>
                {o.reason}
              </span>
            </span>
            {status && status(o.path) !== 'none' && (
              <DraftStatusChip status={status(o.path)} size={mobile ? 10 : 10.5} pad={mobile ? '0' : '3px 9px'} />
            )}
            {!chosen && !o.blocked && onPick && (
              <SecondaryButton
                op="people.set_path"
                label="Use"
                height={mobile ? 26 : 30}
                onClick={() => onPick(o.path)}
                style={{ fontSize: mobile ? 12 : 13, borderRadius: 999 }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------ Draft list (#98)

/** Every outreach draft for a role, one per recipient; a bridge intro shows the target it is about. */
export function DraftList({
  items,
  onOpen,
  mobile,
}: {
  items: ReadonlyArray<{ id: string; recipient: string; about: string | null; status: OutreachStatus }>;
  onOpen?: (id: string) => void;
  mobile?: boolean;
}) {
  return (
    <div className="outreach-list" style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 18 }}>
      <div style={{ ...eyebrow(), margin: '0 0 8px 12px' }}>Drafts</div>
      {items.map((o) => (
        <Btn
          key={o.id}
          op={null}
          className="outreach-item"
          data-outreach={o.id}
          onClick={() => onOpen?.(o.id)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            width: '100%',
            padding: mobile ? '8px 4px' : '8px 12px',
            borderRadius: 10,
            border: 0,
            background: 'transparent',
            color: C.fg,
            textAlign: 'left',
          }}
          hover={{ background: C.panel }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="outreach-item__to" style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>
              {o.recipient}
            </span>
            {o.about && (
              <span className="outreach-item__about" style={{ display: 'block', fontSize: 12, color: C.muted, ...ellipsis }}>
                {`About ${o.about}`}
              </span>
            )}
          </span>
          <DraftStatusChip status={o.status} size={10.5} pad={mobile ? '0' : '3px 9px'} />
        </Btn>
      ))}
    </div>
  );
}
