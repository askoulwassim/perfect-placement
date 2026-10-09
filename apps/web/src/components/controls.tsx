import type { ArchiveReason, Impact, OutreachStatus, RoleStatus } from '@perfect-placement/contracts';
import type { CSSProperties, ReactNode } from 'react';
import { Btn, type ButtonOp } from './Btn';
import { C, eyebrow, F, IMPACT_STYLE, mono, X } from './theme';

// ------------------------------------------------------------ buttons

/** Filled emerald, header top right on every screen. */
export function PrimaryButton({
  label,
  op,
  onClick,
  disabled,
  mobile,
  dim,
}: {
  label: string;
  op: ButtonOp;
  onClick?: () => void;
  disabled?: boolean;
  /** Pinned full-width variant above the tab bar. */
  mobile?: boolean;
  /** Prototype shows a not-yet-ready primary at 0.35 opacity. */
  dim?: boolean;
}) {
  const base: CSSProperties = mobile
    ? {
        width: '100%',
        height: 50,
        background: C.emerald,
        color: C['emerald-ink'],
        border: 0,
        borderRadius: 10,
        fontWeight: 600,
        fontSize: 16,
      }
    : {
        background: C.emerald,
        color: C['emerald-ink'],
        border: 0,
        borderRadius: 10,
        height: 44,
        padding: '0 22px',
        fontWeight: 600,
        fontSize: 15,
        whiteSpace: 'nowrap',
      };
  return (
    <Btn
      className="btn--primary"
      op={op}
      disabled={disabled}
      onClick={onClick}
      style={{ ...base, opacity: disabled || dim ? 0.35 : 1 }}
      hover={{ background: C['emerald-hover'] }}
    >
      {label}
    </Btn>
  );
}

export const Kbd = ({ k }: { k: string }) => (
  <span
    style={{ fontFamily: F.mono, fontSize: 11, padding: '1px 6px', border: `1px solid ${C['line-2']}`, borderRadius: 5, color: C.muted }}
  >
    {k}
  </span>
);

/** Outline button (Change, Skip, Exit, Reject). */
export function SecondaryButton({
  label,
  op,
  kbd,
  onClick,
  disabled,
  height = 40,
  hover,
  style,
}: {
  label: string;
  op: ButtonOp;
  kbd?: string;
  onClick?: () => void;
  disabled?: boolean;
  height?: number;
  hover?: CSSProperties;
  style?: CSSProperties;
}) {
  return (
    <Btn
      op={op}
      onClick={onClick}
      disabled={disabled}
      style={{
        background: 'transparent',
        color: C.fg,
        border: `1px solid ${C['line-2']}`,
        borderRadius: 10,
        height,
        padding: '0 14px',
        fontSize: 14,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        opacity: disabled ? 0.4 : 1,
        ...style,
      }}
      hover={hover ?? { borderColor: C['emerald-2'] }}
    >
      {kbd && <Kbd k={kbd} />}
      {label}
    </Btn>
  );
}

export function Toggle({
  on,
  label,
  onChange,
  op = 'local',
}: {
  on: boolean;
  label: string;
  onChange: (on: boolean) => void;
  /** The op a flip calls; view state by default. */
  op?: ButtonOp;
}) {
  return (
    <Btn
      op={op}
      role="switch"
      aria-checked={on}
      aria-label={label}
      className="toggle"
      onClick={() => onChange(!on)}
      style={{
        width: 42,
        height: 24,
        borderRadius: 999,
        border: 0,
        background: on ? C.emerald : C.line,
        position: 'relative',
        padding: 0,
        transition: 'background .2s',
      }}
    >
      <span
        style={{
          position: 'absolute',
          left: 3,
          top: 3,
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: C.fg,
          transform: on ? 'translateX(18px)' : 'translateX(0)',
          transition: 'transform .2s',
        }}
      />
    </Btn>
  );
}

// ------------------------------------------------------------ chips

export type ChipVariant = 'fact' | 'filter' | 'impact' | 'status' | 'reason' | 'diff-before' | 'diff-after' | 'evidence';

const pill = (extra: CSSProperties): CSSProperties => ({ borderRadius: 999, display: 'inline-flex', alignItems: 'center', ...extra });

/** Static chip. Variants follow the prototype's pill styles. */
export function Chip({ variant, label, value, color }: { variant: ChipVariant; label: ReactNode; value?: ReactNode; color?: string }) {
  switch (variant) {
    case 'fact':
      return (
        <span style={pill({ gap: 8, background: C.panel, border: `1px solid ${C.line}`, padding: '8px 14px', fontSize: 14 })}>
          {value !== undefined && <span style={eyebrow(C.dim, 10)}>{label}</span>}
          {value ?? label}
        </span>
      );
    case 'diff-before':
      return (
        <span
          style={pill({
            border: `1px solid ${C['line-2']}`,
            color: C.muted,
            textDecoration: 'line-through',
            padding: '6px 12px',
            fontSize: 13,
          })}
        >
          {label}
        </span>
      );
    case 'diff-after':
      return <span style={pill({ border: `1px solid ${C.emerald}`, color: C.emerald, padding: '5px 11px', fontSize: 13 })}>{label}</span>;
    case 'reason':
      return (
        <span
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            border: `1px solid ${X.coral35}`,
            borderRadius: 999,
            padding: '3px 8px',
            ...mono(10, C.muted),
          }}
        >
          <span>{label}</span>
          <span>{value}</span>
        </span>
      );
    default: {
      const c = color ?? C.muted;
      return (
        <span style={pill({ border: `1px solid ${c}`, color: c, padding: '4px 12px', ...eyebrow(c) })}>
          {label}
          {value !== undefined && <span style={{ marginLeft: 6 }}>{value}</span>}
        </span>
      );
    }
  }
}

export const STATUS_LABEL: Record<RoleStatus, string> = {
  inbox: 'Inbox',
  active: 'Active',
  held: 'Held',
  'on-deck': 'On deck',
  'draft-ready': 'Draft ready',
  applied: 'Applied',
  interviews: 'Interviews',
  offers: 'Offers',
  archived: 'Archived',
};

/** Prototype STATUS colors (match contracts STATUS_COLOR). */
export const STATUS_HEX: Record<RoleStatus, string> = {
  inbox: C.dim,
  active: C.emerald,
  held: C.gold,
  'on-deck': C.sky,
  'draft-ready': C.emerald,
  applied: C.emerald,
  interviews: C.gold,
  offers: C.emerald,
  archived: C.coral,
};

export function StatusChip({ status, small }: { status: RoleStatus; small?: boolean }) {
  const c = STATUS_HEX[status];
  return (
    <span
      className="status-chip"
      style={{
        border: `1px solid ${c}`,
        color: c,
        borderRadius: 999,
        padding: small ? '2px 8px' : '4px 12px',
        ...eyebrow(c, small ? 9.5 : 11),
      }}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export function ImpactChip({ impact, small }: { impact: Impact; small?: boolean }) {
  const s = IMPACT_STYLE[impact];
  return (
    <span
      style={{
        background: s.bg,
        color: s.fg,
        border: `1px solid ${s.border}`,
        borderRadius: 999,
        padding: small ? '3px 9px' : '5px 12px',
        ...eyebrow(s.fg, small ? 10 : 11),
      }}
    >
      {impact}
    </span>
  );
}

export const ReasonChip = ({ reason, count }: { reason: ArchiveReason; count: number }) => (
  <Chip variant="reason" label={reason === 'below_threshold' ? 'below' : reason.replace(/_/g, ' ')} value={count} />
);

export function AffinityChip({ value, compact }: { value: number; compact?: boolean }) {
  const v = Math.max(-5, Math.min(5, Math.round(value)));
  const txt = `${v >= 0 ? '+' : '−'}${Math.abs(v)}`;
  const bg = v >= 0 ? C['emerald-deep'] : X.coral14;
  const fg = v >= 0 ? C.emerald : C.coral;
  if (compact)
    return <span style={{ background: bg, color: fg, borderRadius: 999, padding: '3px 10px', ...mono(11) }}>{txt} AFFINITY</span>;
  return (
    <span
      title="Company affinity"
      style={{
        background: bg,
        color: fg,
        borderRadius: 999,
        padding: '4px 10px',
        ...mono(12),
        display: 'flex',
        gap: 6,
        alignItems: 'center',
      }}
    >
      <span style={{ fontWeight: 700 }}>{txt}</span>
      <span style={{ opacity: 0.75, fontSize: 10, letterSpacing: '.1em' }}>AFFINITY</span>
    </span>
  );
}

export const DRAFT_CHIP: Record<OutreachStatus | 'none', [string, string, string]> = {
  none: ['—', C.dim, 'transparent'],
  drafted: ['Drafted', C.gold, 'rgba(226,182,90,0.1)'],
  in_gmail: ['In Gmail', C.emerald, 'rgba(47,211,155,0.1)'],
  replied: ['Replied', C.sky, 'rgba(127,182,255,0.1)'],
  ignored: ['Ignored', C.dim, 'transparent'],
};

export function DraftStatusChip({
  status,
  size = 10.5,
  pad = '3px 9px',
}: {
  status: OutreachStatus | 'none';
  size?: number;
  pad?: string;
}) {
  const [label, fg, bg] = DRAFT_CHIP[status];
  return (
    <span style={{ ...mono(size, fg), letterSpacing: '.06em', background: bg, borderRadius: 999, padding: pad, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  );
}

export function ToneChips({
  tones,
  recommended,
  selected,
  onSelect,
  mobile,
}: {
  tones: readonly string[];
  recommended: number;
  selected: number;
  onSelect: (i: number) => void;
  mobile?: boolean;
}) {
  return (
    <div
      style={
        mobile
          ? { display: 'flex', gap: 6, overflowX: 'auto', margin: '18px 0' }
          : { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }
      }
    >
      {tones.map((n, i) => {
        const on = i === selected;
        return (
          <Btn
            key={n}
            op="local"
            aria-pressed={on}
            className="tone-chip"
            onClick={() => onSelect(i)}
            style={{
              height: mobile ? 40 : 36,
              padding: mobile ? '0 12px' : '0 14px',
              borderRadius: 999,
              border: `1px solid ${on ? C.emerald : C['line-2']}`,
              background: on ? C['emerald-deep'] : 'transparent',
              color: on ? C.fg : C.muted,
              fontSize: mobile ? 12 : 13,
              fontWeight: 500,
              whiteSpace: 'nowrap',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            {!mobile && i === recommended && <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.emerald }} />}
            {n}
          </Btn>
        );
      })}
    </div>
  );
}

/** Toast: the outcome of a write or a run. `tone` error = coral (a failed run), with an optional action (Log). */
export function Toast({
  text,
  tone = 'ok',
  action,
}: {
  text: string | null;
  tone?: 'ok' | 'error';
  action?: { label: string; onClick: () => void };
}) {
  if (!text) return null;
  const err = tone === 'error';
  return (
    <div
      role="status"
      className="toast"
      data-tone={tone}
      style={{
        position: 'fixed',
        top: 20,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 90,
        background: err ? C.panel : C['emerald-deep'],
        color: C.fg,
        border: `1px solid ${err ? C.coral : C['emerald-2']}`,
        borderRadius: 999,
        padding: '9px 18px',
        fontSize: 14,
        fontWeight: 500,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        maxWidth: 'calc(100vw - 32px)',
        animation: 'ppIn .25s ease',
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: err ? C.coral : C.emerald, flex: 'none' }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>
      {action && (
        <Btn
          op={null}
          onClick={action.onClick}
          style={{ background: 'none', border: 0, padding: 0, color: err ? C.coral : C.emerald, fontSize: 14, fontWeight: 600 }}
        >
          {action.label}
        </Btn>
      )}
    </div>
  );
}
