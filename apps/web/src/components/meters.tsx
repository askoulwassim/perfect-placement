import { type ColorName, CRITERIA, CRITERION_LABELS, type Thresholds } from '@perfect-placement/contracts';
import { STAGES } from '../lib/stage';
import { cv, Icon, type IconName } from './glyphs';

// -------------------------------------------------------- ProbabilityBar

/** Color by the policy thresholds (handoff §4): confident emerald, middle gold, low coral. */
export const probColor = (p: number, t: Pick<Thresholds, 'auto' | 'second_opinion'>): ColorName =>
  p >= t.auto ? 'emerald' : p >= t.second_opinion ? 'gold' : 'coral';

export function ProbabilityBar({
  p,
  thresholds,
  wide,
}: {
  p: number;
  thresholds: Pick<Thresholds, 'auto' | 'second_opinion'>;
  wide?: boolean;
}) {
  const color = probColor(p, thresholds);
  return (
    <div className={`prob ${wide ? 'prob--wide' : ''}`} data-color={color}>
      <div className="prob__track">
        <div className="prob__fill" style={{ width: `${p * 100}%`, background: cv(color) }} />
        <span className="prob__tick" style={{ left: `${thresholds.second_opinion * 100}%` }} />
        <span className="prob__tick" style={{ left: `${thresholds.auto * 100}%` }} />
      </div>
      <span className="prob__num">{p.toFixed(2)}</span>
    </div>
  );
}

// -------------------------------------------------------------- HeroRing

export function HeroRing({ count, fill, size = 240 }: { count: number; fill: number; size?: number }) {
  const r = size / 2 - 10;
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, fill));
  return (
    <div className="hero-ring" style={{ width: size, height: size }} data-count={count}>
      <svg aria-hidden="true" width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={cv('line')} strokeWidth={10} />
        <circle
          className="hero-ring__arc"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={cv('emerald')}
          strokeWidth={10}
          strokeLinecap="round"
          strokeDasharray={`${c * f} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className={`hero-ring__count ${count ? 'is-gold' : ''}`}>{count}</span>
    </div>
  );
}

// ------------------------------------------------------------- CountTile

export function CountTile({ icon, value, color, label }: { icon: IconName; value: number; color: ColorName; label: string }) {
  return (
    <div className="count-tile" style={{ color: cv(color) }} title={label}>
      <Icon name={icon} size={20} />
      <span className="count-tile__num">{value}</span>
    </div>
  );
}

// ----------------------------------------------------------- ProgressDots

export function ProgressDots({ count, index, resolved = [] }: { count: number; index: number; resolved?: readonly boolean[] }) {
  return (
    <div className="dots" role="progressbar" aria-valuemin={1} aria-valuemax={count} aria-valuenow={index + 1}>
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional dots
        <span key={i} className={`dots__dot ${i === index ? 'is-current' : ''} ${resolved[i] ? 'is-done' : ''}`} />
      ))}
    </div>
  );
}

// ------------------------------------------------------------- ScoreRadar

export function ScoreRadar({ criteria, size = 260, compare }: { criteria: readonly number[]; size?: number; compare?: readonly number[] }) {
  const cx = size / 2;
  const R = size / 2 - 46;
  const pt = (i: number, v: number) => {
    const a = (Math.PI * 2 * i) / 9 - Math.PI / 2;
    const rr = (R * v) / 5;
    return [cx + rr * Math.cos(a), cx + rr * Math.sin(a)] as const;
  };
  const poly = (vals: readonly number[]) => vals.map((v, i) => pt(i, v).join(',')).join(' ');
  return (
    <svg className="radar" role="img" aria-label="Score" width={size} height={size}>
      <title>Score</title>
      {[1, 2, 3, 4, 5].map((ring) => (
        <polygon key={ring} points={poly(Array(9).fill(ring))} fill="none" stroke={cv('line')} strokeWidth={1} />
      ))}
      {CRITERIA.map((c, i) => {
        const [x, y] = pt(i, 5);
        const [lx, ly] = pt(i, 6.1);
        return (
          <g key={c}>
            <line x1={cx} y1={cx} x2={x} y2={y} stroke={cv('line')} />
            <text x={lx} y={ly} className="radar__label" textAnchor="middle" dominantBaseline="middle">
              {CRITERION_LABELS[c]}
            </text>
          </g>
        );
      })}
      {compare && <polygon points={poly(compare)} fill="none" stroke={cv('dim')} strokeDasharray="3 3" />}
      <polygon points={poly(criteria)} fill="rgba(47,211,155,0.18)" stroke={cv('emerald')} strokeWidth={2} />
      {criteria.map((v, i) => {
        const [x, y] = pt(i, v);
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed nine axes
        return <circle key={i} cx={x} cy={y} r={3} fill={cv('emerald')} />;
      })}
    </svg>
  );
}

// -------------------------------------------------------------- StageRail

/** stage: 0..4 current step, 5 done, -1 none. Submit is always a gold "You" step. */
export function StageRail({ stage }: { stage: number }) {
  return (
    <ol className="stage-rail">
      {STAGES.map((name, i) => {
        const state = stage < 0 ? 'future' : i < stage ? 'done' : i === stage ? 'current' : 'future';
        const you = name === 'Submit';
        return (
          <li key={name} className={`stage stage--${state} ${you ? 'stage--you' : ''}`} data-state={state}>
            <span className="stage__mark">{state === 'done' ? <Icon name="check" size={14} /> : null}</span>
            <span className="stage__name">{name}</span>
          </li>
        );
      })}
    </ol>
  );
}
