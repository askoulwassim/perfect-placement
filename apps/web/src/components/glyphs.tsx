import { BAND_COLOR, type ColorName, DEFAULT_CONFIG } from '@perfect-placement/contracts';
import type { ReactNode } from 'react';

export const cv = (c: ColorName) => `var(--pp-color-${c})`;

export type IconName =
  | 'now'
  | 'needs'
  | 'river'
  | 'you'
  | 'ask'
  | 'setup'
  | 'settings'
  | 'back'
  | 'check'
  | 'closed'
  | 'draft'
  | 'reply'
  | 'drop'
  | 'search';

const PATHS: Record<IconName, ReactNode> = {
  now: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="2.5" fill="currentColor" />
    </>
  ),
  needs: <path d="M12 3l9 9-9 9-9-9z" />,
  river: <path d="M3 8c3-3 6 3 9 0s6 3 9 0M3 16c3-3 6 3 9 0s6 3 9 0" />,
  you: (
    <>
      <circle cx="12" cy="12" r="3" />
      <circle cx="4.5" cy="6" r="1.5" />
      <circle cx="19.5" cy="6" r="1.5" />
      <circle cx="4.5" cy="18" r="1.5" />
      <circle cx="19.5" cy="18" r="1.5" />
      <path d="M6 7l3.5 3M18 7l-3.5 3M6 17l3.5-3M18 17l-3.5-3" />
    </>
  ),
  ask: (
    <>
      <path d="M7 4a3 3 0 1 0 0 6h10a3 3 0 1 0 0-6 3 3 0 0 0-3 3v10a3 3 0 1 0 3-3H7a3 3 0 1 0 3 3V7a3 3 0 0 0-3-3z" />
    </>
  ),
  setup: (
    <>
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
      <path d="M7 12h3M14 12h3" />
    </>
  ),
  settings: <path d="M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4" />,
  back: <path d="M15 5l-7 7 7 7" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  closed: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M6.5 17.5l11-11" />
    </>
  ),
  draft: <path d="M4 6h16v12H4zM4 7l8 6 8-6" />,
  reply: <path d="M10 8L5 12l5 4M5 12h9a5 5 0 0 1 5 5" />,
  drop: <path d="M12 4v11M7 10l5 5 5-5M5 19h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M16 16l4 4" />
    </>
  ),
};

export function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[name]}
    </svg>
  );
}

// ------------------------------------------------------------- BandDot

export interface Bands {
  green_min: number;
  yellow_min: number;
}
export const bandOf = (fit: number, bands: Bands = DEFAULT_CONFIG.scoring) =>
  fit >= bands.green_min ? 'green' : fit >= bands.yellow_min ? 'yellow' : 'red';

export function BandDot({ fit, bands, size = 10 }: { fit: number | null; bands?: Bands; size?: number }) {
  const color = fit == null ? 'dim' : BAND_COLOR[bandOf(fit, bands)];
  return (
    <span
      className="band-dot"
      data-band={fit == null ? 'none' : bandOf(fit, bands)}
      style={{ width: size, height: size, background: cv(color) }}
      aria-hidden="true"
    />
  );
}

// ------------------------------------------------------- FreshnessRing

export type Fresh = 'ok' | 'unsure' | 'closed' | 'none';
const FRESH_COLOR: Record<Fresh, ColorName> = { ok: 'emerald', unsure: 'gold', closed: 'coral', none: 'line-2' };

export function FreshnessRing({ fresh, size = 28, children }: { fresh: Fresh; size?: number; children?: ReactNode }) {
  const r = size / 2 - 2;
  return (
    <span className="fresh-ring" data-fresh={fresh} style={{ width: size, height: size }}>
      <svg aria-hidden="true" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={cv(FRESH_COLOR[fresh])}
          strokeWidth={2}
          strokeDasharray={fresh === 'unsure' ? `${r * 0.9} ${r * 0.35}` : undefined}
        />
        {fresh === 'closed' && (
          <line x1={size * 0.22} y1={size * 0.78} x2={size * 0.78} y2={size * 0.22} stroke={cv('coral')} strokeWidth={2} />
        )}
      </svg>
      {children && <span className="fresh-ring__inner">{children}</span>}
    </span>
  );
}

// ------------------------------------------------------------ RoleTile

export function RoleTile({ letter, fresh, size = 44 }: { letter: string; fresh: Fresh; size?: number }) {
  return (
    <span className="role-tile" data-fresh={fresh} style={{ width: size, height: size, fontSize: size * 0.45 }}>
      <span className="role-tile__letter">{letter.slice(0, 1).toUpperCase()}</span>
      {fresh === 'closed' && <span className="role-tile__slash" />}
    </span>
  );
}

// ----------------------------------------------------- WhoDecidesGlyph

export type WhoKind = 'auto' | 'second' | 'undo' | 'you';

export function WhoDecidesGlyph({ kind, left = 1, size = 14 }: { kind: WhoKind; left?: number; size?: number }) {
  const s = size;
  const label = { auto: 'Auto', second: 'Auto, second', undo: 'Auto + undo', you: 'You' }[kind];
  return (
    <svg className="who-glyph" data-kind={kind} role="img" aria-label={label} width={kind === 'second' ? s * 1.7 : s} height={s}>
      <title>{label}</title>
      {kind === 'auto' && <circle cx={s / 2} cy={s / 2} r={s / 2 - 1} fill={cv('emerald')} />}
      {kind === 'second' && (
        <>
          <circle cx={s / 2} cy={s / 2} r={s / 2 - 1} fill={cv('emerald')} />
          <circle cx={s * 1.2} cy={s / 2} r={s / 2 - 1} fill={cv('emerald')} opacity={0.5} />
        </>
      )}
      {kind === 'undo' && <UndoArc s={s} left={left} />}
      {kind === 'you' && <rect x={1} y={1} width={s - 2} height={s - 2} rx={2} fill={cv('gold')} />}
    </svg>
  );
}

function UndoArc({ s, left }: { s: number; left: number }) {
  const r = s / 2 - 1.5;
  const c = 2 * Math.PI * r;
  return (
    <>
      <circle cx={s / 2} cy={s / 2} r={r} fill="none" stroke={cv('emerald-deep')} strokeWidth={2} />
      <circle
        cx={s / 2}
        cy={s / 2}
        r={r}
        fill="none"
        stroke={cv('emerald')}
        strokeWidth={2}
        strokeDasharray={`${c * Math.max(0, Math.min(1, left))} ${c}`}
        transform={`rotate(-90 ${s / 2} ${s / 2})`}
      />
    </>
  );
}

/** Policy outcome -> glyph. */
export const whoOf = (outcome: string): WhoKind =>
  outcome === 'auto' ? 'auto' : outcome === 'auto_second' ? 'second' : outcome === 'auto_undo' ? 'undo' : 'you';
