import { CONFIDENCE_BANDS, IMPACTS, POLICY_GRID } from '@perfect-placement/contracts';
import { type ReactNode, type RefObject, type KeyboardEvent as RKeyboardEvent, useEffect, useRef, useState } from 'react';
import { Btn, useHover } from './Btn';
import { Toggle } from './controls';
import { type IconName, NavIcon, WhoDecidesGlyph, whoOf } from './glyphs';
import { C, display, eyebrow, F, mono, tab, X } from './theme';

// ------------------------------------------------------------ NavRail

export type NavTarget = 'now' | 'needs-you' | 'river' | 'role' | 'people' | 'you' | 'settings' | 'ask';

const RAIL: ReadonlyArray<[NavTarget, IconName, string]> = [
  ['now', 'now', 'Now'],
  ['needs-you', 'queue', 'Needs you'],
  ['river', 'river', 'River'],
  ['role', 'role', 'Role'],
  ['people', 'people', 'People'],
  // Setup lives in You (#25): no separate rail entry.
  ['you', 'you', 'You'],
  ['settings', 'settings', 'Settings'],
];

function RailItem({
  id,
  icon,
  label,
  active,
  badge,
  onGo,
}: {
  id: NavTarget;
  icon: IconName;
  label: string;
  active: boolean;
  badge: boolean;
  onGo: () => void;
}) {
  const [tip, bind] = useHover();
  return (
    <div style={{ position: 'relative' }} {...bind}>
      <Btn
        op={null}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        data-nav={id}
        onClick={onGo}
        style={{
          width: 44,
          height: 44,
          borderRadius: 10,
          border: 0,
          background: active ? C['panel-2'] : 'transparent',
          color: active ? C.emerald : C.muted,
          display: 'grid',
          placeItems: 'center',
          position: 'relative',
          padding: 0,
        }}
      >
        <NavIcon name={icon} />
        {badge && (
          <span
            className="rail__badge"
            style={{ position: 'absolute', top: 7, right: 7, width: 8, height: 8, borderRadius: 2, background: C.gold }}
          />
        )}
      </Btn>
      {tip && (
        <div
          style={{
            position: 'absolute',
            left: 54,
            top: '50%',
            transform: 'translateY(-50%)',
            background: C['panel-2'],
            border: `1px solid ${C['line-2']}`,
            padding: '6px 10px',
            borderRadius: 8,
            fontSize: 12,
            whiteSpace: 'nowrap',
            zIndex: 50,
            pointerEvents: 'none',
          }}
        >
          {label}
        </div>
      )}
    </div>
  );
}

export const PPMark = ({ mb = 0 }: { mb?: number }) => (
  <div
    style={{
      width: 36,
      height: 36,
      borderRadius: 10,
      background: C.emerald,
      color: C['emerald-ink'],
      display: 'grid',
      placeItems: 'center',
      ...display(14, 800, '-0.04em'),
      marginBottom: mb,
      flex: 'none',
    }}
  >
    PP
  </div>
);

// ------------------------------------------------------------ RunIndicator (#21)

export type RunIndicatorState = 'idle' | 'running' | 'error';

/**
 * Global run status: pulses while a run is queued or running (with the count), coral when the latest
 * run failed. Opens Runs. `compact` = the mobile pill ("Scouting").
 */
export function RunIndicator({
  state,
  count,
  label,
  active,
  onOpen,
  compact,
}: {
  state: RunIndicatorState;
  count: number;
  /** "Scouting", "2 runs", "Scout failed", "Runs". */
  label: string;
  active?: boolean;
  onOpen: () => void;
  compact?: boolean;
}) {
  const c = state === 'running' ? C.emerald : state === 'error' ? C.coral : C.muted;
  const dot = (
    <span
      className={state === 'running' ? 'run-pulse' : undefined}
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: state === 'idle' ? 'transparent' : c,
        border: `1.5px solid ${c}`,
        flex: 'none',
      }}
    />
  );
  if (compact)
    return (
      <Btn
        op={null}
        className="run-indicator"
        data-nav="runs"
        data-run-state={state}
        aria-label="Runs"
        onClick={onOpen}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 28,
          padding: '0 12px',
          borderRadius: 999,
          border: `1px solid ${state === 'idle' ? C.line : c}`,
          background: 'transparent',
          color: state === 'idle' ? C.muted : C.fg,
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        {dot}
        {label}
      </Btn>
    );
  return (
    <Btn
      op={null}
      className="run-indicator"
      data-nav="runs"
      data-run-state={state}
      aria-label="Runs"
      aria-current={active ? 'page' : undefined}
      title={label}
      onClick={onOpen}
      style={{
        width: 44,
        height: 44,
        borderRadius: 10,
        border: 0,
        background: active ? C['panel-2'] : 'transparent',
        color: c,
        display: 'grid',
        placeItems: 'center',
        position: 'relative',
        padding: 0,
      }}
    >
      <svg aria-hidden="true" width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="11" cy="11" r="8" className={state === 'running' ? 'run-pulse' : undefined} />
        <path d="M11 6.5V11l3 2" strokeLinecap="round" />
      </svg>
      {state === 'running' && count > 1 && (
        <span style={{ position: 'absolute', top: 4, right: 4, ...mono(10, C.emerald), fontWeight: 700 }}>{count}</span>
      )}
      {state === 'error' && (
        <span style={{ position: 'absolute', top: 7, right: 7, width: 8, height: 8, borderRadius: 2, background: C.coral }} />
      )}
    </Btn>
  );
}

export function NavRail({
  active,
  needsBadge,
  onNavigate,
  runs,
}: {
  active: string;
  needsBadge: boolean;
  onNavigate: (t: NavTarget) => void;
  /** The global run indicator, above Ask. */
  runs?: ReactNode;
}) {
  return (
    <nav
      aria-label="Main"
      className="rail"
      style={{
        position: 'sticky',
        top: 0,
        height: '100vh',
        width: 76,
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        padding: '20px 0',
        borderRight: `1px solid ${C.line}`,
        background: X.railBg,
        zIndex: 20,
      }}
    >
      <PPMark mb={18} />
      {RAIL.map(([id, icon, label]) => (
        <RailItem
          key={id}
          id={id}
          icon={icon}
          label={label}
          active={active === id}
          badge={id === 'needs-you' && needsBadge}
          onGo={() => onNavigate(id)}
        />
      ))}
      <div style={{ flex: 1 }} />
      {runs}
      <Btn
        op={null}
        title="Ask (⌘K)"
        aria-label="Ask"
        onClick={() => onNavigate('ask')}
        style={{
          width: 44,
          height: 44,
          borderRadius: 10,
          border: `1px solid ${C['line-2']}`,
          background: 'transparent',
          color: C.muted,
          ...mono(12),
        }}
        hover={{ borderColor: C['emerald-2'], color: C.emerald }}
      >
        ⌘K
      </Btn>
    </nav>
  );
}

// ------------------------------------------------------------ TabBar (mobile)

const TABS: ReadonlyArray<[NavTarget, string]> = [
  ['now', 'Now'],
  ['river', 'River'],
  ['you', 'You'],
  ['ask', 'Ask'],
];

export function TabBar({ active, onNavigate }: { active: (t: NavTarget) => boolean; onNavigate: (t: NavTarget) => void }) {
  return (
    <nav
      aria-label="Tabs"
      className="tabbar"
      style={{
        flex: 'none',
        height: 70,
        display: 'grid',
        gridTemplateColumns: 'repeat(4,1fr)',
        borderTop: `1px solid ${C.line}`,
        background: C['bg-2'],
        paddingBottom: 8,
      }}
    >
      {TABS.map(([id, l]) => (
        <Btn
          key={id}
          op={null}
          aria-label={l}
          title={l}
          onClick={() => onNavigate(id)}
          style={{ background: 'none', border: 0, color: active(id) ? C.emerald : C.dim, display: 'grid', placeItems: 'center' }}
        >
          {id === 'ask' ? (
            <span style={{ ...mono(14), border: '1.5px solid currentColor', borderRadius: 7, padding: '2px 6px' }}>›_</span>
          ) : (
            <NavIcon name={id === 'now' ? 'now' : id === 'river' ? 'river' : 'you'} size={24} />
          )}
        </Btn>
      ))}
    </nav>
  );
}

// ------------------------------------------------------------ ScreenHeader

export function ScreenHeader({
  eyebrow: eb,
  title,
  onBack,
  primary,
  mobile,
}: {
  eyebrow: string;
  title: string;
  onBack?: () => void;
  primary?: ReactNode;
  mobile?: boolean;
}) {
  if (mobile)
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        {onBack && (
          <Btn
            op={null}
            aria-label="Back"
            onClick={onBack}
            style={{
              width: 40,
              height: 40,
              borderRadius: 10,
              border: `1px solid ${C['line-2']}`,
              background: 'transparent',
              color: C.fg,
              fontSize: 16,
              flex: 'none',
            }}
          >
            ←
          </Btn>
        )}
        <div style={{ minWidth: 0 }}>
          <div style={eyebrow(C.muted, 10)}>{eb}</div>
          <h1 className="screen-title" style={{ ...display(30, 800, '-0.03em'), lineHeight: 1.1, margin: '4px 0 0' }}>
            {title}
          </h1>
        </div>
      </div>
    );
  return (
    <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 24, minHeight: 72 }}>
      <div style={{ minWidth: 0 }}>
        <div style={eyebrow()}>{eb}</div>
        <h1
          className="screen-title"
          style={{
            ...display(44, 800, '-0.035em'),
            lineHeight: 1.05,
            margin: '6px 0 0',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {title}
        </h1>
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flex: 'none' }}>
        {onBack && (
          <Btn
            op={null}
            aria-label="Back"
            onClick={onBack}
            style={{
              background: 'transparent',
              color: C.fg,
              border: `1px solid ${C['line-2']}`,
              borderRadius: 10,
              height: 44,
              width: 44,
              fontSize: 18,
            }}
            hover={{ borderColor: C['emerald-2'] }}
          >
            ←
          </Btn>
        )}
        {primary}
      </div>
    </header>
  );
}

// ------------------------------------------------------------ CommandBar (Ask)

export function AskPill({ onOpen }: { onOpen: () => void }) {
  return (
    <Btn
      op={null}
      className="ask-pill"
      onClick={onOpen}
      style={{
        position: 'fixed',
        bottom: 24,
        left: 'calc(50% + 38px)',
        transform: 'translateX(-50%)',
        zIndex: 30,
        width: 420,
        maxWidth: 'calc(100vw - 140px)',
        height: 48,
        borderRadius: 999,
        background: C.panel,
        border: `1px solid ${C['line-2']}`,
        color: C.muted,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 10px 0 20px',
        cursor: 'text',
        fontSize: 15,
        boxShadow: X.shadowPill,
      }}
      hover={{ borderColor: C['emerald-2'] }}
    >
      <span style={{ fontFamily: F.mono, color: C.emerald }}>›</span>
      <span style={{ flex: 1, textAlign: 'left' }}>Ask</span>
      <span style={{ ...mono(11), padding: '3px 8px', border: `1px solid ${C['line-2']}`, borderRadius: 6 }}>⌘K</span>
    </Btn>
  );
}

export function CommandBar({
  query,
  onQuery,
  onSubmit,
  onClose,
  suggestions,
  reply,
  inputRef,
}: {
  query: string;
  onQuery: (q: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  suggestions: ReactNode;
  reply?: ReactNode;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const own = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? own;
  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), 40);
    return () => clearTimeout(t);
  }, [ref]);
  return (
    <div role="dialog" aria-label="Ask" className="ask">
      <Btn
        op="local"
        aria-label="Close"
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 60,
          background: 'rgba(6,17,31,0.62)',
          backdropFilter: 'blur(2px)',
          border: 0,
          cursor: 'default',
        }}
      />
      <div
        style={{
          position: 'fixed',
          bottom: 24,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 70,
          width: 'min(720px, calc(100vw - 32px))',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {reply}
        {!reply && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>{suggestions}</div>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            height: 56,
            padding: '0 12px 0 20px',
            background: C.panel,
            border: `1px solid ${C['emerald-2']}`,
            borderRadius: 14,
            boxShadow: X.shadowAsk,
          }}
        >
          <span style={{ fontFamily: F.mono, color: C.emerald, fontSize: 16 }}>›</span>
          <input
            ref={ref}
            aria-label="Ask"
            placeholder="Ask"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && onClose()}
            style={{ flex: 1, minWidth: 0, background: 'none', border: 0, outline: 'none', color: C.fg, fontSize: 16, fontFamily: F.ui }}
          />
          <span style={{ ...mono(11, C.dim), padding: '3px 8px', border: `1px solid ${C['line-2']}`, borderRadius: 6 }}>esc</span>
        </form>
      </div>
    </div>
  );
}

export function AskSuggestion({
  text,
  op,
  onRun,
}: {
  text: string;
  op: 'runs.start' | 'roles.check_freshness' | 'people.find' | 'local';
  onRun: () => void;
}) {
  return (
    <Btn
      op={op}
      onClick={onRun}
      style={{ background: C.panel, border: `1px solid ${C['line-2']}`, color: C.fg, borderRadius: 999, padding: '8px 14px', fontSize: 13 }}
      hover={{ borderColor: C['emerald-2'], color: C.emerald }}
    >
      {text}
    </Btn>
  );
}

// ------------------------------------------------------------ BackendCard

export function BackendCard({
  name,
  mode,
  status,
  latencyMs,
}: {
  name: string;
  mode: string;
  status: 'ok' | 'slow' | 'down' | 'not_installed';
  latencyMs: number | null;
}) {
  const missing = status === 'not_installed';
  const dot = status === 'ok' ? C.emerald : status === 'slow' ? C.gold : missing ? C.muted : C.coral;
  const ring = status === 'ok' ? X.em15 : status === 'slow' ? X.gold16 : missing ? 'transparent' : X.coral14;
  return (
    <div
      className="backend"
      data-status={status}
      style={{
        background: C.panel,
        border: `1px solid ${C.line}`,
        borderRadius: 12,
        padding: '22px 24px',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
      }}
    >
      <span style={{ width: 12, height: 12, borderRadius: '50%', background: dot, boxShadow: `0 0 0 4px ${ring}` }} />
      <div style={{ flex: 1 }}>
        <div style={display(24, 700, 'normal')}>{name}</div>
        <div style={{ ...mono(11, C.muted), letterSpacing: '.08em' }}>{missing ? 'pp kev install' : mode.toUpperCase()}</div>
      </div>
      {missing ? (
        <div style={{ ...mono(12, C.muted), letterSpacing: '.06em' }}>Not installed</div>
      ) : (
        <div style={{ ...display(30, 800, 'normal'), ...tab }}>
          {latencyMs ?? '—'}
          <span style={{ ...mono(12, C.muted), fontWeight: 400, marginLeft: 4 }}>ms</span>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ PolicyGrid

const CELL_BG = { auto: X.em06, second: X.em04, undo: X.em03, you: X.gold08 } as const;
const IMPACT_HEX = { low: C.emerald, medium: C.gold, high: C.coral } as const;

/** Confidence x impact grid (locked policy from contracts). Column widths follow the thresholds; handles drag them. */
export function PolicyGrid({
  thresholds,
  onChange,
}: {
  thresholds: { auto: number; second_opinion: number };
  onChange: (t: { auto: number; second_opinion: number }) => void;
}) {
  const t0 = thresholds.second_opinion;
  const t1 = thresholds.auto;
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<0 | 1 | null>(null);
  const set = (which: 0 | 1, v: number) => {
    const r = Math.round(v * 100) / 100;
    if (which === 1) onChange({ second_opinion: t0, auto: Math.min(0.99, Math.max(t0 + 0.05, r)) });
    else onChange({ auto: t1, second_opinion: Math.max(0.55, Math.min(t1 - 0.05, r)) });
  };
  useEffect(() => {
    if (drag == null) return;
    const move = (e: MouseEvent) => {
      const el = track.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      set(drag, 1 - f * 0.5);
    };
    const up = () => setDrag(null);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  });
  const cols = `150px ${((1 - t1) * 10).toFixed(3)}fr ${((t1 - t0) * 10).toFixed(3)}fr ${((t0 - 0.5) * 10).toFixed(3)}fr`;
  const head = [`≥ ${t1.toFixed(2)}`, `${t0.toFixed(2)}–${t1.toFixed(2)}`, `< ${t0.toFixed(2)}`];
  const handle = (which: 0 | 1, v: number, label: string) => (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0.5}
      aria-valuemax={1}
      aria-valuenow={v}
      title="Drag"
      onMouseDown={(e) => {
        e.preventDefault();
        setDrag(which);
      }}
      onKeyDown={(e: RKeyboardEvent) => {
        if (e.key === 'ArrowLeft') set(which, v + 0.01);
        if (e.key === 'ArrowRight') set(which, v - 0.01);
      }}
      style={{
        position: 'absolute',
        left: `${((1 - v) / 0.5) * 100}%`,
        top: 4,
        width: 22,
        height: 22,
        transform: 'translateX(-50%)',
        borderRadius: '50%',
        background: C.bg,
        border: `2px solid ${C.emerald}`,
        cursor: 'ew-resize',
        boxSizing: 'border-box',
      }}
    />
  );
  return (
    <div className="policy">
      <div
        className="policy__grid"
        style={{
          display: 'grid',
          gridTemplateColumns: cols,
          background: C.panel,
          border: `1px solid ${C.line}`,
          borderRadius: 12,
          overflow: 'hidden',
        }}
      >
        <div style={{ background: C['bg-2'], height: 44 }} />
        {head.map((h) => (
          <div
            key={h}
            className="policy__head"
            style={{
              background: C['bg-2'],
              height: 44,
              display: 'grid',
              placeItems: 'center',
              ...mono(12, C.muted),
              borderLeft: `1px solid ${C.line}`,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
            }}
          >
            p {h}
          </div>
        ))}
        {IMPACTS.map((imp) => (
          <PolicyRow key={imp} imp={imp} />
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '150px minmax(0,1fr)', marginTop: 6 }}>
        <div />
        <div ref={track} style={{ position: 'relative', height: 30 }}>
          <div style={{ position: 'absolute', left: 0, right: 0, top: 14, height: 2, background: C.line, borderRadius: 2 }} />
          {handle(1, t1, 'Auto')}
          {handle(0, t0, 'Second opinion')}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 22, marginTop: 12, ...mono(11, C.muted), flexWrap: 'wrap' }}>
        {(
          [
            ['auto', 'Auto'],
            ['second', '2nd opinion'],
            ['undo', 'Auto + undo'],
            ['you', 'You'],
          ] as const
        ).map(([k, l]) => (
          <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <WhoDecidesGlyph kind={k} size={k === 'second' ? 18 : 16} />
            {l}
          </span>
        ))}
      </div>
    </div>
  );
}

function PolicyRow({ imp }: { imp: (typeof IMPACTS)[number] }) {
  const c = IMPACT_HEX[imp];
  return (
    <>
      <div style={{ height: 68, display: 'flex', alignItems: 'center', padding: '0 20px', borderTop: `1px solid ${C.line}` }}>
        <span style={{ border: `1px solid ${c}`, color: c, borderRadius: 999, padding: '4px 12px', ...eyebrow(c) }}>{imp}</span>
      </div>
      {CONFIDENCE_BANDS.map((band) => {
        const k = whoOf(POLICY_GRID[imp][band]);
        return (
          <div
            key={band}
            data-outcome={POLICY_GRID[imp][band]}
            style={{
              height: 68,
              display: 'grid',
              placeItems: 'center',
              borderTop: `1px solid ${C.line}`,
              borderLeft: `1px solid ${C.line}`,
              background: CELL_BG[k],
            }}
          >
            <WhoDecidesGlyph kind={k} size={22} />
          </div>
        );
      })}
    </>
  );
}

/**
 * Hard exclusions (wave1-decisions #24): always "you", whatever the grid says. Locked: not tunable.
 * Rendered under the PolicyGrid in the grid's own row style.
 */
export function HardExclusions({ items }: { items: readonly string[] }) {
  const c = C.coral;
  return (
    <div
      className="policy__locked"
      style={{
        display: 'grid',
        gridTemplateColumns: '150px minmax(0,1fr)',
        background: C.panel,
        border: `1px solid ${C.line}`,
        borderRadius: 12,
        overflow: 'hidden',
        marginTop: 16,
      }}
    >
      <div style={{ minHeight: 68, display: 'flex', alignItems: 'center', padding: '0 20px' }}>
        <span style={{ border: `1px solid ${c}`, color: c, borderRadius: 999, padding: '4px 12px', ...eyebrow(c) }}>always</span>
      </div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 8,
          padding: '14px 20px',
          borderLeft: `1px solid ${C.line}`,
          background: CELL_BG.you,
        }}
      >
        {items.map((label) => (
          <span
            key={label}
            className="policy__lock"
            data-locked="you"
            aria-disabled="true"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              border: `1px solid ${C['line-2']}`,
              borderRadius: 999,
              padding: '6px 12px 6px 10px',
              fontSize: 13,
            }}
          >
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke={C.muted} strokeWidth="1.4">
              <rect x="2" y="5.5" width="8" height="5.5" rx="1.2" />
              <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" />
            </svg>
            {label}
            <WhoDecidesGlyph kind="you" size={14} />
          </span>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ ScheduleRow

export function ScheduleRow({
  name,
  cadence,
  next,
  last,
  lastStatus,
  job,
  on,
  onToggle,
}: {
  name: string;
  cadence: string;
  next: string;
  /** The last scheduled run's result ("Done", "Failed", "Never"). */
  last: string;
  lastStatus: string;
  /** The OS job's state (#29). */
  job: string;
  on: boolean;
  onToggle: (on: boolean) => void;
}) {
  return (
    <div
      className="schedule"
      data-last={lastStatus}
      data-job={job}
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr) 180px 110px 80px 44px',
        gap: 16,
        alignItems: 'center',
        height: 60,
        borderBottom: `1px solid ${C.line}`,
      }}
    >
      <span style={{ fontSize: 15, fontWeight: 600 }}>{name}</span>
      <span style={mono(12, C.muted)}>{cadence}</span>
      <span className="schedule__next" style={mono(12, C.dim)}>
        {on ? next : 'off'}
      </span>
      <span className="schedule__last" style={mono(12, lastStatus === 'error' ? C.coral : C.dim)}>
        {last}
      </span>
      <Toggle on={on} label={name} onChange={onToggle} />
    </div>
  );
}

// ------------------------------------------------------------ MobileFrame

export function MobileFrame({
  children,
  primary,
  tabbar,
  top,
}: {
  children: ReactNode;
  primary?: ReactNode;
  tabbar: ReactNode;
  /** Status bar area (the run pill). */
  top?: ReactNode;
}) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
      <div
        className="mobile-frame"
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 390,
          height: 'min(844px, 100vh)',
          background: `${X.mobileGlow}, ${C.bg}`,
          border: `1px solid ${C.line}`,
          borderRadius: 36,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ height: 44, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '0 20px' }}>
          {top}
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 20px 24px' }}>{children}</div>
        {primary && <div style={{ flex: 'none', padding: '10px 20px', borderTop: `1px solid ${C.line}`, background: C.bg }}>{primary}</div>}
        {tabbar}
      </div>
    </div>
  );
}
