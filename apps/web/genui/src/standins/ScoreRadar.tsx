// STAND-IN for lane D's ScoreRadar (props: criteria[9], size). Replace with the real component in Wave 2.
import { CRITERIA, CRITERION_LABELS } from '@perfect-placement/contracts';
import { c } from './style.js';

export interface ScoreRadarProps {
  /** Nine 1..5 scores, c1..c9. */
  criteria: readonly number[];
  size?: number;
}

export function ScoreRadar({ criteria, size = 160 }: ScoreRadarProps) {
  const r = size / 2 - 18;
  const mid = size / 2;
  const pt = (i: number, v: number) => {
    const a = (Math.PI * 2 * i) / CRITERIA.length - Math.PI / 2;
    return [mid + Math.cos(a) * r * (v / 5), mid + Math.sin(a) * r * (v / 5)] as const;
  };
  const poly = (vals: readonly number[]) => vals.map((v, i) => pt(i, v).join(',')).join(' ');
  const labels = CRITERIA.map((k) => CRITERION_LABELS[k]).join(', ');
  return (
    <svg
      data-genui="ScoreRadar"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`Score radar: ${labels}`}
    >
      <polygon points={poly(CRITERIA.map(() => 5))} fill="none" stroke={c('line')} />
      <polygon points={poly(CRITERIA.map(() => 3))} fill="none" stroke={c('line')} strokeDasharray="2 3" />
      <polygon points={poly(criteria)} fill={c('emerald-deep')} fillOpacity={0.6} stroke={c('emerald')} strokeWidth={2} />
    </svg>
  );
}
