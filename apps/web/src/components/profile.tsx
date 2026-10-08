import type { ComponentKind } from '@perfect-placement/contracts';
import type { CSSProperties } from 'react';
import { Btn } from './Btn';
import { SecondaryButton } from './controls';
import { C, display, eyebrow, mono, tab, X } from './theme';

export const KIND_HEX: Record<ComponentKind, string> = { filter: C.gold, weighted: C.emerald, asset: C.sky };
export const KIND_LABEL: Record<ComponentKind, string> = { filter: 'Filter', weighted: 'Weighted', asset: 'Asset' };

export interface NodeData {
  key: string;
  name: string;
  kind: ComponentKind;
  /** 0..100 */
  conf: number;
  pending: boolean;
}

// ------------------------------------------------------------ ProfileNode

export function ProfileNode({
  n,
  selected,
  size = 72,
  onClick,
  style,
}: {
  n: NodeData;
  selected?: boolean;
  size?: number;
  onClick?: () => void;
  style?: CSSProperties;
}) {
  const Cu = 2 * Math.PI * 32;
  const mobile = size < 72;
  return (
    <Btn
      op="local"
      className="pnode"
      data-component={n.key}
      data-kind={n.kind}
      aria-pressed={selected}
      onClick={onClick}
      style={{
        background: 'none',
        border: 0,
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: mobile ? 6 : 8,
        color: C.fg,
        ...style,
      }}
    >
      <span
        style={{
          position: 'relative',
          width: size,
          height: size,
          borderRadius: '50%',
          background: selected ? C['panel-2'] : C.panel,
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <svg aria-hidden="true" viewBox="0 0 72 72" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
          <circle cx="36" cy="36" r="32" fill="none" stroke={C.line} strokeWidth="4" />
          <circle
            cx="36"
            cy="36"
            r="32"
            fill="none"
            stroke={KIND_HEX[n.kind]}
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={`${(Cu * n.conf) / 100} ${Cu}`}
            transform="rotate(-90 36 36)"
            style={{ transition: 'stroke-dasharray .5s' }}
          />
        </svg>
        <span style={{ ...mono(mobile ? 12 : 14), ...tab, position: 'relative' }}>{n.conf}</span>
        {n.pending && (
          <span
            role="img"
            aria-label="Pending diff"
            style={{
              position: 'absolute',
              top: mobile ? -2 : -3,
              right: mobile ? -2 : -3,
              width: mobile ? 18 : 22,
              height: mobile ? 18 : 22,
              borderRadius: mobile ? 5 : 6,
              background: C.gold,
              color: C['emerald-ink'],
              ...mono(mobile ? 10 : 11),
              fontWeight: 700,
              display: 'grid',
              placeItems: 'center',
              border: mobile ? undefined : `2px solid ${C.bg}`,
              boxSizing: 'border-box',
            }}
          >
            1
          </span>
        )}
      </span>
      <span style={{ fontSize: mobile ? 12 : 13, fontWeight: mobile ? 400 : 600, whiteSpace: 'nowrap', color: selected ? C.fg : C.muted }}>
        {n.name}
      </span>
    </Btn>
  );
}

// ------------------------------------------------------------ Constellation (You)

export function Constellation({
  nodes,
  selected,
  onSelect,
}: {
  nodes: readonly NodeData[];
  selected: string | null;
  onSelect: (k: string) => void;
}) {
  const pts = nodes.map((n, i) => {
    const a = ((-90 + (i * 360) / nodes.length) * Math.PI) / 180;
    return { n, x: 380 + 290 * Math.cos(a), y: 310 + 232 * Math.sin(a) };
  });
  return (
    <div className="constellation" style={{ position: 'relative', width: 760, height: 620, margin: '0 auto' }}>
      <div style={{ position: 'absolute', inset: 0 }}>
        <svg aria-hidden="true" viewBox="0 0 760 620" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
          {pts.map((p) => (
            <line
              key={p.n.key}
              x1={380}
              y1={310}
              x2={p.x}
              y2={p.y}
              stroke={p.n.pending ? C.gold : C.line}
              strokeWidth={1}
              strokeDasharray={p.n.pending ? '3 4' : undefined}
            />
          ))}
        </svg>
      </div>
      <div
        style={{
          position: 'absolute',
          left: 380,
          top: 310,
          transform: 'translate(-50%,-50%)',
          width: 108,
          height: 108,
          borderRadius: '50%',
          background: C.emerald,
          color: C['emerald-ink'],
          display: 'grid',
          placeItems: 'center',
          ...display(26, 800, '-0.03em'),
          boxShadow: `0 0 0 14px ${X.em08}, 0 0 0 28px ${X.em04}`,
        }}
      >
        You
      </div>
      {pts.map((p) => (
        <ProfileNode
          key={p.n.key}
          n={p.n}
          selected={selected === p.n.key}
          onClick={() => onSelect(p.n.key)}
          style={{ position: 'absolute', left: p.x, top: p.y, transform: 'translate(-50%,-36px)' }}
        />
      ))}
    </div>
  );
}

/** Onboarding / confirm: 400px, 40px nodes, lit as components fill. */
export function MiniConstellation({ nodes, lit }: { nodes: ReadonlyArray<NodeData>; lit: (key: string) => boolean }) {
  const Cu = 2 * Math.PI * 17;
  return (
    <div style={{ position: 'relative', width: 400, height: 400 }}>
      <div
        style={{
          position: 'absolute',
          left: 200,
          top: 200,
          transform: 'translate(-50%,-50%)',
          width: 72,
          height: 72,
          borderRadius: '50%',
          background: C.emerald,
          color: C['emerald-ink'],
          display: 'grid',
          placeItems: 'center',
          ...display(18, 800, 'normal'),
        }}
      >
        You
      </div>
      {nodes.map((n, i) => {
        const a = ((-90 + (i * 360) / nodes.length) * Math.PI) / 180;
        const on = lit(n.key);
        return (
          <div
            key={n.key}
            className={`ob-node ${on ? 'is-lit' : ''}`}
            data-component={n.key}
            style={{
              position: 'absolute',
              left: 200 + 150 * Math.cos(a),
              top: 200 + 150 * Math.sin(a),
              transform: 'translate(-50%,-20px)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <div
              style={{
                position: 'relative',
                width: 40,
                height: 40,
                borderRadius: '50%',
                background: on ? C.panel : C['bg-2'],
                transition: 'background .3s',
              }}
            >
              <svg aria-hidden="true" viewBox="0 0 40 40" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
                <circle cx="20" cy="20" r="17" fill="none" stroke={C.line} strokeWidth="3" />
                <circle
                  cx="20"
                  cy="20"
                  r="17"
                  fill="none"
                  stroke={on ? KIND_HEX[n.kind] : C.line}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={`${on ? (Cu * n.conf) / 100 : 0} ${Cu}`}
                  transform="rotate(-90 20 20)"
                  style={{ transition: 'stroke-dasharray .5s' }}
                />
              </svg>
            </div>
            <div style={{ fontSize: 11, whiteSpace: 'nowrap', color: on ? C.fg : C.dim, transition: 'color .3s' }}>{n.name}</div>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------ DiffBlock

export function DiffBlock({
  before,
  after,
  onReject,
  compact,
}: {
  before: readonly string[];
  after: readonly string[];
  onReject?: () => void;
  compact?: boolean;
}) {
  const b = (t: string) => (
    <span
      key={`b-${t}`}
      style={{
        border: `1px solid ${C['line-2']}`,
        color: C.muted,
        textDecoration: 'line-through',
        borderRadius: 999,
        padding: compact ? '4px 10px' : '5px 11px',
        fontSize: compact ? 12 : 13,
      }}
    >
      {t}
    </span>
  );
  const a = (t: string) => (
    <span
      key={`a-${t}`}
      style={{
        border: `1px solid ${C.emerald}`,
        color: C.emerald,
        borderRadius: 999,
        padding: compact ? '4px 10px' : '5px 11px',
        fontSize: compact ? 12 : 13,
      }}
    >
      {t}
    </span>
  );
  if (compact)
    return (
      <div className="diff" style={{ marginTop: 16, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {before.map(b)}
        <span style={{ color: C.dim }}>→</span>
        {after.map(a)}
      </div>
    );
  return (
    <div className="diff" style={{ marginTop: 26, padding: 16, borderRadius: 12, background: X.gold06, border: `1px solid ${X.gold35}` }}>
      <div style={{ ...eyebrow(C.gold, 10.5), marginBottom: 12 }}>Diff</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>{before.map(b)}</div>
      <div style={{ ...mono(14, C.dim), margin: '6px 0 6px 6px' }}>↓</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{after.map(a)}</div>
      {onReject && (
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <SecondaryButton
            label="Reject"
            op="profile.reject_diff"
            height={36}
            onClick={onReject}
            style={{ fontSize: 13 }}
            hover={{ borderColor: C.coral, color: C.coral }}
          />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ VersionTimeline

export function VersionTimeline({
  versions,
  compact,
}: {
  versions: ReadonlyArray<{ v: string; event: string; date: string }>;
  compact?: boolean;
}) {
  if (compact)
    return (
      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {versions.map((t) => (
          <div key={t.v} className="timeline__item" style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 13 }}>
            <span className="timeline__v" style={mono(13, C.emerald)}>
              {t.v}
            </span>
            <span style={{ flex: 1 }}>{t.event}</span>
            <span style={mono(11, C.dim)}>{t.date}</span>
          </div>
        ))}
      </div>
    );
  return (
    <div className="timeline">
      {versions.map((t, i) => (
        <div
          key={t.v}
          className={`timeline__item ${i === 0 ? 'is-current' : ''}`}
          style={{ display: 'grid', gridTemplateColumns: '18px 1fr', gap: 12, animation: 'ppIn .4s ease' }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: i === 0 ? C.emerald : C.panel,
                border: `2px solid ${i === 0 ? C.emerald : C['line-2']}`,
                marginTop: 4,
                flex: 'none',
                boxSizing: 'border-box',
              }}
            />
            <span style={{ flex: 1, width: 2, background: C.line, marginTop: 4, opacity: i === versions.length - 1 ? 0 : 1 }} />
          </div>
          <div style={{ paddingBottom: 18 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
              <span className="timeline__v" style={mono(13, C.emerald)}>
                {t.v}
              </span>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{t.event}</span>
            </div>
            <div style={{ ...mono(11, C.dim), marginTop: 3 }}>{t.date}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
