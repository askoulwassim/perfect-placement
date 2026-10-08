import {
  type ArchiveReason,
  type ColorName,
  DRAFT_STATUS_COLOR,
  IMPACT_COLOR,
  type Impact,
  type OpName,
  type OutreachStatus,
  type RoleStatus,
  STATUS_COLOR,
} from '@perfect-placement/contracts';
import type { CSSProperties, ReactNode } from 'react';
import type { ShimName } from '../client/types';
import { humanize } from '../lib/format';
import { cv } from './glyphs';

/**
 * `op` documents the one op a button calls. `null` = navigation, `'local'` = view state only
 * (selection, filter, expand). Rendered as data-op so tests can assert it.
 */
export type ButtonOp = OpName | ShimName | null | 'local';
const opAttr = (op: ButtonOp) => (op === null ? 'nav' : op);

// --------------------------------------------------------------- buttons

export function PrimaryButton({ label, op, onClick, disabled }: { label: string; op: ButtonOp; onClick?: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="btn btn--primary" data-op={opAttr(op)} disabled={disabled} onClick={onClick}>
      {label}
    </button>
  );
}

export function SecondaryButton({
  label,
  op,
  kbd,
  onClick,
  disabled,
  children,
}: {
  label: string;
  op: ButtonOp;
  kbd?: string;
  onClick?: () => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <button type="button" className="btn btn--secondary" data-op={opAttr(op)} disabled={disabled} onClick={onClick}>
      {children}
      {label}
      {kbd && <kbd className="kbd">{kbd}</kbd>}
    </button>
  );
}

export function IconButton({
  label,
  op,
  onClick,
  children,
  active,
  className,
}: {
  label: string;
  op: ButtonOp;
  onClick?: () => void;
  children: ReactNode;
  active?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-btn ${active ? 'is-active' : ''} ${className ?? ''}`}
      data-op={opAttr(op)}
      aria-label={label}
      title={label}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`toggle ${on ? 'is-on' : ''}`}
      data-op="local"
      onClick={() => onChange(!on)}
    >
      <span className="toggle__knob" />
    </button>
  );
}

// ----------------------------------------------------------------- chips

export type ChipVariant = 'fact' | 'filter' | 'impact' | 'status' | 'reason' | 'diff-before' | 'diff-after' | 'evidence';

export function Chip({
  variant,
  label,
  value,
  color,
  on,
  onClick,
}: {
  variant: ChipVariant;
  label: string;
  value?: string | number;
  color?: ColorName;
  on?: boolean;
  onClick?: () => void;
}) {
  const style = color ? ({ '--chip-c': cv(color) } as CSSProperties) : undefined;
  const body = (
    <>
      <span className="chip__label">{label}</span>
      {value !== undefined && <span className="chip__value">{value}</span>}
    </>
  );
  if (onClick)
    return (
      <button
        type="button"
        className={`chip chip--${variant} ${on ? 'is-on' : ''}`}
        style={style}
        data-op="local"
        aria-pressed={on}
        onClick={onClick}
      >
        {body}
      </button>
    );
  return (
    <span className={`chip chip--${variant}`} style={style}>
      {body}
    </span>
  );
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

export const StatusChip = ({ status }: { status: RoleStatus }) => (
  <Chip variant="status" label={STATUS_LABEL[status]} color={STATUS_COLOR[status]} />
);

export const ImpactChip = ({ impact }: { impact: Impact }) => (
  <Chip variant="impact" label={humanize(impact)} color={IMPACT_COLOR[impact]} />
);

export const ReasonChip = ({ reason, count }: { reason: ArchiveReason; count?: number }) => (
  <Chip variant="reason" label={humanize(reason)} value={count} color="coral" />
);

export function AffinityChip({ value }: { value: number }) {
  const v = Math.max(-5, Math.min(5, Math.round(value)));
  const color: ColorName = v > 0 ? 'emerald' : v < 0 ? 'coral' : 'dim';
  return <Chip variant="fact" label="Affinity" value={v > 0 ? `+${v}` : String(v)} color={color} />;
}

const DRAFT_LABEL: Record<OutreachStatus | 'none', string> = {
  none: 'None',
  drafted: 'Drafted',
  in_gmail: 'In Gmail',
  replied: 'Replied',
  ignored: 'Ignored',
};
export const DraftStatusChip = ({ status }: { status: OutreachStatus | 'none' }) => (
  <Chip variant="status" label={DRAFT_LABEL[status]} color={DRAFT_STATUS_COLOR[status]} />
);

export function ToneChips({
  tones,
  recommended,
  selected,
  onSelect,
}: {
  tones: ReadonlyArray<{ id: string; label: string }>;
  recommended: string;
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    <fieldset className="chip-row" aria-label="Tone">
      {tones.map((t) => (
        <Chip
          key={t.id}
          variant="filter"
          label={t.label}
          color={t.id === recommended ? 'emerald' : 'muted'}
          on={t.id === selected}
          onClick={() => onSelect(t.id)}
        />
      ))}
    </fieldset>
  );
}

export function Toast({ text }: { text: string | null }) {
  return (
    <div className={`toast ${text ? 'is-on' : ''}`} role="status" aria-live="polite">
      {text}
    </div>
  );
}
