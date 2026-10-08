import type { ReactNode } from 'react';
import { C, F } from './theme';

// ------------------------------------------------------------ RoleTile (RoleTile.dc.html)

export type Fresh = 'ok' | 'unsure' | 'closed' | 'none';

const RT_C = 2 * Math.PI * 22.5;
const RT_RING: Record<Fresh, [string, number]> = {
  ok: [C.emerald, RT_C],
  unsure: [C.gold, RT_C * 0.55],
  closed: [C.coral, RT_C],
  none: [C['line-2'], 0],
};

/** Round company tile with a freshness ring (full emerald, gold partial, coral + slash, none). */
export function RoleTile({ letter, fresh, size }: { letter: string; fresh: Fresh; size: number }) {
  const [ring, dash] = RT_RING[fresh];
  return (
    <span
      className="role-tile"
      data-fresh={fresh}
      style={{ position: 'relative', width: size, height: size, flex: 'none', display: 'grid', placeItems: 'center' }}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 48 48"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}
      >
        <circle cx="24" cy="24" r="22.5" fill="none" stroke={C.line} strokeWidth="2" />
        <circle
          cx="24"
          cy="24"
          r="22.5"
          fill="none"
          stroke={ring}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${RT_C}`}
          transform="rotate(-90 24 24)"
        />
        <line
          x1="8"
          y1="40"
          x2="40"
          y2="8"
          stroke={C.coral}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeOpacity={fresh === 'closed' ? 1 : 0}
        />
      </svg>
      <span
        style={{
          width: '74%',
          height: '74%',
          borderRadius: '50%',
          background: C['panel-2'],
          display: 'grid',
          placeItems: 'center',
          fontFamily: F.display,
          fontWeight: 800,
          fontSize: size * 0.36,
          lineHeight: 1,
          color: C.fg,
          letterSpacing: '-0.02em',
        }}
      >
        {letter.slice(0, 1).toUpperCase()}
      </span>
    </span>
  );
}

// ------------------------------------------------------------ WhoDecidesGlyph (Glyph.dc.html)

export type WhoKind = 'auto' | 'second' | 'undo' | 'you';

export function WhoDecidesGlyph({ kind, left = 0.7, size = 16 }: { kind: WhoKind; left?: number; size?: number }) {
  const Cu = 2 * Math.PI * 6;
  return (
    <span className="who-glyph" data-kind={kind} style={{ width: size, height: size, flex: 'none', display: 'grid', placeItems: 'center' }}>
      {kind === 'auto' && <span style={{ width: 10, height: 10, borderRadius: '50%', background: C.emerald }} />}
      {kind === 'second' && (
        <span style={{ display: 'flex', gap: 2 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: C.emerald }} />
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: C.emerald, opacity: 0.55 }} />
        </span>
      )}
      {kind === 'undo' && (
        <svg aria-hidden="true" viewBox="0 0 16 16" style={{ width: 14, height: 14 }}>
          <circle cx="8" cy="8" r="6" fill="none" stroke={C['emerald-deep']} strokeWidth="2" />
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="none"
            stroke={C.emerald}
            strokeWidth="2"
            strokeDasharray={`${Cu * Math.max(0, Math.min(1, left))} ${Cu}`}
            strokeLinecap="round"
            transform="rotate(-90 8 8)"
          />
        </svg>
      )}
      {kind === 'you' && <span style={{ width: 10, height: 10, borderRadius: 2, background: C.gold }} />}
    </span>
  );
}

export const whoOf = (outcome: string): WhoKind =>
  outcome === 'auto' ? 'auto' : outcome === 'auto_second' ? 'second' : outcome === 'auto_undo' ? 'undo' : 'you';

// ------------------------------------------------------------ BandDot / FreshnessRing

export function BandDot({ color, size = 10 }: { color: string; size?: number }) {
  return (
    <span
      className="band-dot"
      style={{ width: size, height: size, borderRadius: '50%', background: color, flex: 'none', display: 'inline-block' }}
    />
  );
}

/** Small open ring next to "checked 3h". */
export function FreshnessRing({ color, size = 8 }: { color: string; size?: number }) {
  return <span style={{ width: size, height: size, borderRadius: '50%', border: `2px solid ${color}`, display: 'inline-block' }} />;
}

// ------------------------------------------------------------ icons (rail, tab bar, count tiles)

export type IconName = 'now' | 'queue' | 'river' | 'role' | 'people' | 'you' | 'onboard' | 'settings';

const NAV_PATHS: Record<IconName, ReactNode> = {
  now: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
    </>
  ),
  queue: (
    <>
      <rect x="5" y="5" width="14" height="14" rx="3" />
      <path d="M9 12h6" strokeLinecap="round" />
    </>
  ),
  river: <path d="M3 8h4M10 8h4M17 8h4M3 16h7M13 16h8" strokeLinecap="round" />,
  role: (
    <g strokeLinecap="round">
      <rect x="4" y="5" width="16" height="14" rx="3" />
      <circle cx="9" cy="12" r="2" />
      <path d="M13 11h4M13 14h3" />
    </g>
  ),
  people: (
    <>
      <circle cx="7.5" cy="9" r="3" />
      <circle cx="16.5" cy="15" r="3" />
      <path d="M10 10.6l4 2.8" />
    </>
  ),
  you: (
    <>
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="12" r="8.5" strokeDasharray="2 3" />
    </>
  ),
  onboard: (
    <g fill="currentColor" stroke="none">
      <circle cx="4.5" cy="12" r="1.8" />
      <circle cx="9.5" cy="12" r="1.8" />
      <circle cx="14.5" cy="12" r="1.8" opacity=".5" />
      <circle cx="19.5" cy="12" r="1.8" opacity=".3" />
    </g>
  ),
  settings: (
    <g strokeLinecap="round">
      <path d="M4 8h16M4 16h16" />
      <circle cx="9" cy="8" r="2.3" fill={C['bg-2']} />
      <circle cx="15" cy="16" r="2.3" fill={C['bg-2']} />
    </g>
  ),
};

export function NavIcon({ name, size = 22 }: { name: IconName; size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      {NAV_PATHS[name]}
    </svg>
  );
}

export function CountIcon({ kind, size = 28, stroke = 2.2 }: { kind: 'closed' | 'drafts' | 'replies'; size?: number; stroke?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 28 28', fill: 'none', strokeWidth: stroke } as const;
  if (kind === 'closed')
    return (
      <svg aria-hidden="true" {...common} stroke={C.coral}>
        <circle cx="14" cy="14" r="11" />
        <path d="M6.5 21.5l15-15" strokeLinecap="round" />
      </svg>
    );
  if (kind === 'drafts')
    return (
      <svg aria-hidden="true" {...common} stroke={C.emerald} strokeLinecap="round">
        <rect x="6" y="3.5" width="16" height="21" rx="3" />
        <path d="M10 10h8M10 14.5h8M10 19h5" />
      </svg>
    );
  return (
    <svg aria-hidden="true" {...common} stroke={C.sky} strokeLinejoin="round">
      <path d="M4 6.5h20v13H11l-5 4v-4H4z" />
    </svg>
  );
}
