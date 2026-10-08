import { componentColor, PROFILE_COMPONENT_KIND, type ProfileComponentKey } from '@perfect-placement/contracts';
import { COMPONENT_NAME } from '../lib/profile';
import { Chip, SecondaryButton } from './controls';
import { cv } from './glyphs';

// ------------------------------------------------------------ ProfileNode

export function ProfileNode({
  componentKey,
  confidence,
  pending,
  selected,
  lit = true,
  size = 64,
  onClick,
}: {
  componentKey: ProfileComponentKey;
  confidence: number;
  pending?: boolean;
  selected?: boolean;
  lit?: boolean;
  size?: number;
  onClick?: () => void;
}) {
  const color = componentColor(componentKey);
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  return (
    <button
      type="button"
      className={`pnode ${selected ? 'is-selected' : ''} ${lit ? 'is-lit' : 'is-dark'}`}
      data-op="local"
      data-component={componentKey}
      data-kind={PROFILE_COMPONENT_KIND[componentKey]}
      onClick={onClick}
    >
      <span className="pnode__ring" style={{ width: size, height: size }}>
        <svg aria-hidden="true" width={size} height={size}>
          <circle cx={size / 2} cy={size / 2} r={r} fill={cv('panel')} stroke={cv('line')} strokeWidth={4} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={cv(color)}
            strokeWidth={4}
            strokeLinecap="round"
            strokeDasharray={`${c * (lit ? confidence : 0)} ${c}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
          <circle cx={size / 2} cy={size / 2} r={size * 0.14} fill={cv(color)} opacity={lit ? 0.9 : 0.25} />
        </svg>
        {pending && <span className="pnode__badge" role="img" aria-label="Pending diff" />}
      </span>
      <span className="pnode__name">{COMPONENT_NAME[componentKey]}</span>
      {lit && <span className="pnode__conf">{Math.round(confidence * 100)}</span>}
    </button>
  );
}

// ---------------------------------------------------------- Constellation

export function Constellation({
  components,
  selected,
  pending = [],
  lit,
  size = 560,
  onSelect,
}: {
  components: ReadonlyArray<{ key: ProfileComponentKey; confidence: number }>;
  selected?: ProfileComponentKey | null;
  pending?: readonly ProfileComponentKey[];
  /** Onboarding: only these are lit. */
  lit?: readonly ProfileComponentKey[];
  size?: number;
  onSelect?: (k: ProfileComponentKey) => void;
}) {
  const R = 0.4;
  return (
    <div className="constellation" style={{ width: size, height: size }}>
      <svg className="constellation__lines" aria-hidden="true" viewBox="0 0 100 100">
        {components.map((c, i) => {
          const a = (Math.PI * 2 * i) / components.length - Math.PI / 2;
          return (
            <line
              key={c.key}
              x1={50}
              y1={50}
              x2={50 + R * 100 * Math.cos(a)}
              y2={50 + R * 100 * Math.sin(a)}
              stroke={cv(selected === c.key ? 'emerald-2' : 'line')}
              strokeWidth={0.3}
            />
          );
        })}
      </svg>
      <span className="constellation__you">You</span>
      {components.map((c, i) => {
        const a = (Math.PI * 2 * i) / components.length - Math.PI / 2;
        return (
          <span
            key={c.key}
            className="constellation__slot"
            style={{ left: `${50 + R * 100 * Math.cos(a)}%`, top: `${50 + R * 100 * Math.sin(a)}%` }}
          >
            <ProfileNode
              componentKey={c.key}
              confidence={c.confidence}
              pending={pending.includes(c.key)}
              selected={selected === c.key}
              lit={lit ? lit.includes(c.key) : true}
              size={size < 400 ? 44 : 64}
              onClick={onSelect ? () => onSelect(c.key) : undefined}
            />
          </span>
        );
      })}
    </div>
  );
}

// -------------------------------------------------------------- DiffBlock

export interface DiffChip {
  label: string;
  value?: string;
}

export function DiffBlock({ before, after, onReject }: { before: readonly DiffChip[]; after: readonly DiffChip[]; onReject?: () => void }) {
  return (
    <div className="diff">
      <div className="diff__side">
        {before.map((c) => (
          <Chip key={`b-${c.label}-${c.value}`} variant="diff-before" label={c.label} value={c.value} />
        ))}
      </div>
      <span className="diff__arrow" aria-hidden="true">
        →
      </span>
      <div className="diff__side">
        {after.map((c) => (
          <Chip key={`a-${c.label}-${c.value}`} variant="diff-after" label={c.label} value={c.value} />
        ))}
      </div>
      {onReject && <SecondaryButton label="Reject" op="profile.reject_diff" onClick={onReject} />}
    </div>
  );
}

// -------------------------------------------------------- VersionTimeline

export function VersionTimeline({ versions }: { versions: ReadonlyArray<{ v: string; event: string; date: string }> }) {
  return (
    <ol className="timeline">
      {versions.map((x, i) => (
        <li key={x.v} className={`timeline__item ${i === versions.length - 1 ? 'is-current' : ''}`}>
          <span className="timeline__v">{x.v}</span>
          <span className="timeline__event">{x.event}</span>
          <span className="timeline__date">{x.date}</span>
        </li>
      ))}
    </ol>
  );
}
