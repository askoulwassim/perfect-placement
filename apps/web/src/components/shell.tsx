import { CONFIDENCE_BANDS, IMPACTS, POLICY_GRID, type Thresholds } from '@perfect-placement/contracts';
import { type ReactNode, useEffect, useRef } from 'react';
import { humanize } from '../lib/format';
import { IconButton } from './controls';
import { Icon, type IconName, WhoDecidesGlyph, whoOf } from './glyphs';

// ----------------------------------------------------------- NavRail/TabBar

export type NavTarget = 'now' | 'needs-you' | 'river' | 'you' | 'ask' | 'onboarding' | 'settings';
const NAV: ReadonlyArray<{ id: NavTarget; icon: IconName; label: string }> = [
  { id: 'now', icon: 'now', label: 'Now' },
  { id: 'needs-you', icon: 'needs', label: 'Needs you' },
  { id: 'river', icon: 'river', label: 'River' },
  { id: 'you', icon: 'you', label: 'You' },
  { id: 'ask', icon: 'ask', label: 'Ask' },
];
const NAV_BOTTOM: typeof NAV = [
  { id: 'onboarding', icon: 'setup', label: 'Setup' },
  { id: 'settings', icon: 'settings', label: 'Settings' },
];

export function NavRail({ active, needsBadge, onNavigate }: { active: string; needsBadge: number; onNavigate: (t: NavTarget) => void }) {
  const item = (n: (typeof NAV)[number]) => (
    <IconButton key={n.id} label={n.label} op={null} active={active === n.id} onClick={() => onNavigate(n.id)}>
      <Icon name={n.icon} />
      {n.id === 'needs-you' && needsBadge > 0 && <span className="badge">{needsBadge}</span>}
    </IconButton>
  );
  return (
    <nav className="rail" aria-label="Main">
      <span className="rail__mark" aria-hidden="true">
        P
      </span>
      <div className="rail__group">{NAV.map(item)}</div>
      <div className="rail__group rail__group--bottom">{NAV_BOTTOM.map(item)}</div>
    </nav>
  );
}

const TABS: typeof NAV = [
  { id: 'now', icon: 'now', label: 'Now' },
  { id: 'river', icon: 'river', label: 'River' },
  { id: 'you', icon: 'you', label: 'You' },
  { id: 'ask', icon: 'ask', label: 'Ask' },
];

export function TabBar({ active, needsBadge, onNavigate }: { active: string; needsBadge: number; onNavigate: (t: NavTarget) => void }) {
  return (
    <nav className="tabbar" aria-label="Tabs">
      {TABS.map((t) => (
        <IconButton
          key={t.id}
          label={t.label}
          op={null}
          active={active === t.id || (t.id === 'now' && active === 'needs-you')}
          onClick={() => onNavigate(t.id)}
        >
          <Icon name={t.icon} />
          {t.id === 'now' && needsBadge > 0 && <span className="badge">{needsBadge}</span>}
        </IconButton>
      ))}
    </nav>
  );
}

// ----------------------------------------------------------- ScreenHeader

export function ScreenHeader({
  title,
  eyebrow,
  onBack,
  primary,
  children,
}: {
  title: ReactNode;
  eyebrow?: string;
  onBack?: () => void;
  primary?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="screen-head">
      <div className="screen-head__left">
        {onBack && (
          <IconButton label="Back" op={null} onClick={onBack} className="back-btn">
            <Icon name="back" />
          </IconButton>
        )}
        <div className="screen-head__titles">
          {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          <h1 className="screen-title">{title}</h1>
        </div>
        {children}
      </div>
      <div className="screen-head__primary">{primary}</div>
    </header>
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
  status: 'ok' | 'slow' | 'down';
  latencyMs: number | null;
}) {
  return (
    <div className="backend" data-status={status}>
      <span className={`backend__dot is-${status}`} aria-hidden="true" />
      <span className="backend__name">{humanize(name)}</span>
      <span className="eyebrow">{humanize(mode)}</span>
      <span className="backend__lat">{latencyMs == null ? '--' : `${latencyMs} ms`}</span>
    </div>
  );
}

// ------------------------------------------------------------- PolicyGrid

export function PolicyGrid({
  thresholds,
  onChange,
}: {
  thresholds: Pick<Thresholds, 'auto' | 'second_opinion'>;
  onChange?: (t: { auto: number; second_opinion: number }) => void;
}) {
  const a = thresholds.auto.toFixed(2);
  const s = thresholds.second_opinion.toFixed(2);
  const cols = [`p ≥ ${a}`, `${s} to ${a}`, `< ${s}`];
  return (
    <div className="policy">
      <div className="policy__scale">
        <span className="eyebrow">0.50</span>
        <div className="policy__track">
          <span
            className="policy__seg"
            style={{ left: 0, width: `${((thresholds.second_opinion - 0.5) / 0.5) * 100}%` }}
            data-color="coral"
          />
          <span
            className="policy__seg"
            style={{
              left: `${((thresholds.second_opinion - 0.5) / 0.5) * 100}%`,
              width: `${((thresholds.auto - thresholds.second_opinion) / 0.5) * 100}%`,
            }}
            data-color="gold"
          />
          <span className="policy__seg" style={{ left: `${((thresholds.auto - 0.5) / 0.5) * 100}%`, right: 0 }} data-color="emerald" />
          <input
            type="range"
            aria-label="Second opinion"
            min={0.5}
            max={1}
            step={0.01}
            value={thresholds.second_opinion}
            onChange={(e) =>
              onChange?.({ auto: thresholds.auto, second_opinion: Math.min(Number(e.target.value), thresholds.auto - 0.01) })
            }
          />
          <input
            type="range"
            aria-label="Auto"
            min={0.5}
            max={1}
            step={0.01}
            value={thresholds.auto}
            onChange={(e) =>
              onChange?.({
                second_opinion: thresholds.second_opinion,
                auto: Math.max(Number(e.target.value), thresholds.second_opinion + 0.01),
              })
            }
          />
        </div>
        <span className="eyebrow">1.00</span>
      </div>
      <table className="policy__grid">
        <thead>
          <tr>
            <th />
            {cols.map((c) => (
              <th key={c} className="eyebrow">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {IMPACTS.map((impact) => (
            <tr key={impact}>
              <th className={`eyebrow policy__impact is-${impact}`}>{humanize(impact)}</th>
              {CONFIDENCE_BANDS.map((band) => (
                <td key={band} data-outcome={POLICY_GRID[impact][band]}>
                  <WhoDecidesGlyph kind={whoOf(POLICY_GRID[impact][band])} size={18} left={0.66} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------- CommandBar

export function CommandBar({
  open,
  query,
  suggestions,
  streaming,
  reply,
  onQuery,
  onSubmit,
  onClose,
}: {
  open: boolean;
  query: string;
  suggestions: ReactNode;
  streaming?: boolean;
  reply?: ReactNode;
  onQuery: (q: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  if (!open) return null;
  return (
    <div className="ask" role="dialog" aria-label="Ask">
      <button type="button" className="ask__scrim" aria-label="Close" data-op="local" onClick={onClose} />
      <div className="ask__panel">
        {reply && <div className={`ask__reply ${streaming ? 'is-streaming' : ''}`}>{reply}</div>}
        <div className="ask__chips">{suggestions}</div>
        <form
          className="ask__bar"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <Icon name="search" />
          <input
            ref={input}
            aria-label="Ask"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && onClose()}
          />
          <kbd className="kbd">⌘K</kbd>
        </form>
      </div>
    </div>
  );
}
