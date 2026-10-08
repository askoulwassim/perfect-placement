import { CRITERIA, CRITERION_LABELS } from '@perfect-placement/contracts';
import { Btn } from './Btn';
import { CountIcon } from './glyphs';
import { C, display, F, mono, probColor, tab, X } from './theme';

// ------------------------------------------------------------ ProbabilityBar

export function ProbabilityBar({
  p,
  thresholds,
  small,
}: {
  p: number;
  thresholds: { auto: number; second_opinion: number };
  small?: boolean;
}) {
  const col = probColor(p, thresholds);
  return (
    <div className="prob" data-color={col} style={{ display: 'flex', alignItems: 'center', gap: small ? 12 : 14 }}>
      <div style={{ flex: 1, height: 4, borderRadius: 4, background: C.line, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${p * 100}%`, background: col, borderRadius: 4, transition: 'width .3s' }} />
      </div>
      <div style={{ ...mono(small ? 13 : 14, col), ...tab }}>{p.toFixed(2)}</div>
    </div>
  );
}

// ------------------------------------------------------------ HeroRing

/** Needs-you count in a ring whose fill is the share handled automatically. */
export function HeroRing({ count, fill, mobile, onClick }: { count: number; fill: number; mobile?: boolean; onClick?: () => void }) {
  const size = mobile ? 168 : 240;
  const r = mobile ? 76 : 104;
  const sw = mobile ? 10 : 12;
  const Cu = 2 * Math.PI * r;
  const cleared = count === 0;
  const f = cleared ? 1 : Math.max(0, Math.min(1, fill));
  return (
    <Btn
      op={null}
      aria-label="Needs you"
      className="hero-ring"
      onClick={onClick}
      style={{ position: 'relative', width: size, height: size, flex: 'none', background: 'none', border: 0, padding: 0, color: C.fg }}
    >
      <svg aria-hidden="true" viewBox={`0 0 ${size} ${size}`} style={{ width: '100%', height: '100%' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={C.line} strokeWidth={sw} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={C.emerald}
          strokeWidth={sw}
          strokeLinecap="round"
          strokeDasharray={`${f * Cu} ${Cu}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dasharray .6s ease' }}
        />
      </svg>
      <span
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: mobile ? 0 : 6,
        }}
      >
        <span
          className="hero-ring__count"
          style={{ ...display(mobile ? 72 : 104, 800, '-0.05em'), lineHeight: 0.9, ...tab, color: cleared ? C.emerald : C.gold }}
        >
          {count}
        </span>
        <span style={{ ...mono(mobile ? 10 : 11, C.muted), letterSpacing: '.1em', marginTop: mobile ? 4 : 0 }}>
          {Math.round(f * 100)}% AUTO
        </span>
      </span>
    </Btn>
  );
}

// ------------------------------------------------------------ CountTile

export function CountTile({
  kind,
  value,
  label,
  compact,
}: {
  kind: 'closed' | 'drafts' | 'replies';
  value: number;
  label: string;
  compact?: boolean;
}) {
  if (compact)
    return (
      <div
        title={label}
        style={{
          background: C.panel,
          borderRadius: 12,
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <CountIcon kind={kind} size={20} stroke={2.4} />
        <span style={display(28, 800, 'normal')}>{value}</span>
      </div>
    );
  return (
    <div
      title={label}
      className="count-tile"
      style={{
        background: C.panel,
        borderRadius: 12,
        padding: '22px 24px',
        height: 156,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
      }}
    >
      <CountIcon kind={kind} />
      <div style={{ ...display(64), lineHeight: 0.9, ...tab }}>{value}</div>
    </div>
  );
}

// ------------------------------------------------------------ ProgressDots

export function ProgressDots({
  count,
  index,
  resolved,
  onPick,
  gap = 10,
  active = C.gold,
  done = C.emerald,
}: {
  count: number;
  index: number;
  resolved: readonly boolean[];
  onPick?: (i: number) => void;
  gap?: number;
  active?: string;
  done?: string;
}) {
  return (
    <div className="dots" style={{ display: 'flex', justifyContent: 'center', gap }}>
      {Array.from({ length: count }, (_, i) => {
        const style = {
          width: i === index ? 28 : 10,
          height: 10,
          borderRadius: 999,
          border: 0,
          padding: 0,
          background: resolved[i] ? done : i === index ? active : C['line-2'],
          transition: 'all .2s',
        };
        return onPick ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional dots
          <Btn key={i} op="local" aria-label={`${i + 1}`} style={style} onClick={() => onPick(i)} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional dots
          <span key={i} style={style} />
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------ ScoreRadar (radarSvg)

export function ScoreRadar({ criteria, size }: { criteria: readonly number[]; size: number }) {
  const cx = size / 2;
  const R = size * 0.33;
  const ang = (i: number) => ((-90 + i * 40) * Math.PI) / 180;
  const P = (i: number, v: number) => [cx + (Math.cos(ang(i)) * R * v) / 5, cx + (Math.sin(ang(i)) * R * v) / 5] as const;
  return (
    <svg
      className="radar"
      role="img"
      aria-label="Score"
      viewBox={`0 0 ${size} ${size}`}
      style={{ width: '100%', height: '100%', overflow: 'visible' }}
    >
      <title>Score</title>
      {[1, 2, 3, 4, 5].map((l) => (
        <polygon key={`g${l}`} points={CRITERIA.map((_, i) => P(i, l).join(',')).join(' ')} fill="none" stroke={C.line} strokeWidth={1} />
      ))}
      {CRITERIA.map((c, i) => {
        const [x, y] = P(i, 5);
        return <line key={`a${c}`} x1={cx} y1={cx} x2={x} y2={y} stroke={C.line} strokeWidth={1} />;
      })}
      <polygon
        points={criteria.map((v, i) => P(i, v).join(',')).join(' ')}
        fill={X.radarFill}
        stroke={C.emerald}
        strokeWidth={2}
        strokeLinejoin="round"
      />
      {criteria.map((v, i) => {
        const [x, y] = P(i, v);
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed nine axes
        return <circle key={`d${i}`} cx={x} cy={y} r={3.5} fill={C.emerald} />;
      })}
      {CRITERIA.map((c, i) => {
        const [x, y] = P(i, 6.3);
        const a = Math.abs(x - cx) < 10 ? 'middle' : x > cx ? 'start' : 'end';
        return (
          <g key={`l${c}`}>
            <text x={x} y={y - 3} textAnchor={a} fontFamily={F.mono} fontSize={10} fill={C.muted} letterSpacing="0.06em">
              {`C${i + 1} · ${criteria[i]}`}
            </text>
            <text x={x} y={y + 11} textAnchor={a} fontFamily={F.ui} fontSize={11} fill={C.dim}>
              {CRITERION_LABELS[c]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ------------------------------------------------------------ StageRail

const STAGE_NAMES = ['Research', 'Tailor', 'Connect', 'Fill', 'Submit'] as const;

function stageStyle(i: number, stg: number) {
  const done = i < stg;
  const cur = i === stg;
  const you = i === 4;
  return {
    done,
    cur,
    rad: you ? 6 : '50%',
    bg: done ? (you ? C.gold : C.emerald) : 'transparent',
    border: done || cur ? (you ? C.gold : C.emerald) : C['line-2'],
    glow: cur ? `0 0 0 5px ${you ? X.gold16 : X.em16}` : 'none',
    fg: done || cur ? C.fg : C.dim,
    fw: cur ? 700 : 500,
    line: done ? C.emerald : C.line,
  };
}

/** stage: 0..4 current, 5 done, -1 none. Submit is always the gold square "You" step. */
export function StageRail({ stage, mobile }: { stage: number; mobile?: boolean }) {
  if (mobile)
    return (
      <div className="stage-rail" style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 4, marginBottom: 22 }}>
        {STAGE_NAMES.map((n, i) => {
          const s = stageStyle(i, stage);
          return (
            <div
              key={n}
              className="stage"
              data-state={s.done ? 'done' : s.cur ? 'current' : 'future'}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}
            >
              <div
                style={{ width: 22, height: 22, borderRadius: s.rad, background: s.bg, border: `2px solid ${s.border}`, boxShadow: s.glow }}
              />
              <span style={{ fontSize: 10, color: s.fg, fontWeight: s.fw }}>{n}</span>
            </div>
          );
        })}
      </div>
    );
  return (
    <div className="stage-rail" style={{ display: 'flex', alignItems: 'center', margin: '28px 0 36px', maxWidth: 920 }}>
      {STAGE_NAMES.map((n, i) => {
        const s = stageStyle(i, stage);
        return (
          <div key={n} style={{ display: 'flex', alignItems: 'center', flex: i < 4 ? '1 1 0' : '0 0 auto' }}>
            <div
              className="stage"
              data-state={s.done ? 'done' : s.cur ? 'current' : 'future'}
              style={{ display: 'flex', alignItems: 'center', gap: 10 }}
            >
              <div
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: s.rad,
                  background: s.bg,
                  border: `2px solid ${s.border}`,
                  display: 'grid',
                  placeItems: 'center',
                  boxShadow: s.glow,
                  flex: 'none',
                }}
              >
                {s.done && (
                  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12">
                    <path
                      d="M2.5 6.2l2.3 2.3 4.7-5"
                      fill="none"
                      stroke={C['emerald-ink']}
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </div>
              <div className="stage__name" style={{ fontSize: 14, fontWeight: s.fw, color: s.fg, whiteSpace: 'nowrap' }}>
                {n}
              </div>
            </div>
            {i < 4 && <div style={{ flex: 1, height: 2, margin: '0 14px', background: s.line, borderRadius: 2 }} />}
          </div>
        );
      })}
    </div>
  );
}
