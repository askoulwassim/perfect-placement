import type { Impact } from '@perfect-placement/contracts';
import { useState } from 'react';
import { Btn } from './Btn';
import { ImpactChip, SecondaryButton } from './controls';
import { type Fresh, RoleTile, WhoDecidesGlyph } from './glyphs';
import { ProbabilityBar } from './meters';
import { C, display, ellipsis, eyebrow, F, mono, X } from './theme';

export type DecisionObject = 'role' | 'mail' | 'profile' | 'contact';

export interface DecisionView {
  object: DecisionObject;
  letter?: string;
  fresh?: Fresh;
  ini?: string;
  objTitle: string;
  objSub: string;
  question: string;
  impact: Impact;
  before?: readonly string[];
  pick: string;
  resolver: string;
  p: number;
  evidence: ReadonlyArray<{ k: string; d: string }>;
  alts: ReadonlyArray<{ label: string; value: string | boolean | number }>;
}

function ObjectMark({ v, size }: { v: DecisionView; size: number }) {
  const fs = size > 40 ? 13 : 12;
  const circle = (border: string, color: string, text: string, font = fs) => (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: C['panel-2'],
        border,
        display: 'grid',
        placeItems: 'center',
        ...mono(font, color),
        flex: 'none',
        boxSizing: 'border-box',
      }}
    >
      {text}
    </span>
  );
  if (v.object === 'role') return <RoleTile letter={v.letter ?? '?'} fresh={v.fresh ?? 'none'} size={size} />;
  if (v.object === 'mail') return circle(`2px solid ${C.sky}`, C.sky, '@', size > 40 ? 17 : 14);
  if (v.object === 'profile') return circle(`3px solid ${C.gold}`, C.gold, v.ini ?? '');
  return circle(`2.5px solid ${C.emerald}`, C.fg, v.ini ?? '');
}

const label = { ...eyebrow(C.dim) };

export function DecisionCard({
  v,
  thresholds,
  changeOpen,
  hints = true,
  mobile,
  onToggleChange,
  onPick,
  onSkip,
}: {
  v: DecisionView;
  thresholds: { auto: number; second_opinion: number };
  changeOpen: boolean;
  hints?: boolean;
  mobile?: boolean;
  onToggleChange: () => void;
  onPick: (value: string | boolean | number) => void;
  onSkip: () => void;
}) {
  const [ev, setEv] = useState(-1);
  const evChips = v.evidence.map((e, i) => {
    const open = ev === i;
    return (
      <Btn
        key={e.k}
        op="local"
        className="evidence-chip"
        onClick={() => setEv(open ? -1 : i)}
        style={{
          border: `1px solid ${open ? C['emerald-2'] : C['line-2']}`,
          background: open ? C['panel-2'] : 'transparent',
          color: C.fg,
          borderRadius: 999,
          padding: mobile ? '8px 12px' : '7px 14px',
          ...mono(mobile ? 11 : 12),
          display: 'flex',
          gap: 8,
          alignItems: 'center',
        }}
        hover={{ borderColor: C['emerald-2'] }}
      >
        {e.k}
        {open && <span style={{ color: C.muted }}>· {e.d}</span>}
      </Btn>
    );
  });
  const alts = v.alts.map((o) => (
    <Btn
      key={String(o.value)}
      op="decisions.resolve"
      onClick={() => onPick(o.value)}
      style={{
        border: `1px solid ${X.gold50}`,
        background: 'transparent',
        color: C.fg,
        borderRadius: 999,
        padding: mobile ? '0 14px' : '8px 14px',
        height: mobile ? 44 : undefined,
        fontSize: 13,
      }}
      hover={{ background: X.gold12 }}
    >
      {o.label}
    </Btn>
  ));
  const before = (v.before ?? []).map((b) => (
    <span
      key={b}
      style={{
        border: `1px solid ${C['line-2']}`,
        color: C.muted,
        textDecoration: 'line-through',
        borderRadius: 999,
        padding: mobile ? '5px 10px' : '6px 12px',
        fontSize: mobile ? 12 : 13,
      }}
    >
      {b}
    </span>
  ));
  const pickChip = (
    <span
      style={{
        background: C['emerald-deep'],
        color: C.emerald,
        borderRadius: 999,
        padding: mobile ? '6px 12px' : '7px 14px',
        fontSize: mobile ? 13 : 14,
        fontWeight: 600,
      }}
    >
      {v.pick}
    </span>
  );

  if (mobile)
    return (
      <>
        <article
          className="decision"
          data-object={v.object}
          style={{ background: C.panel, border: `1px solid ${C['line-2']}`, borderRadius: 12, padding: 20 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <ObjectMark v={v} size={40} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, ...ellipsis }}>{v.objTitle}</div>
              <div style={{ fontSize: 12, color: C.muted }}>{v.objSub}</div>
            </div>
            <ImpactChip impact={v.impact} small />
          </div>
          <div className="decision__q" style={{ ...display(32, 700, '-0.03em'), lineHeight: 1.05, margin: '22px 0' }}>
            {v.question}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {before.length > 0 && (
              <>
                {before}
                <span style={{ color: C.dim }}>→</span>
              </>
            )}
            {pickChip}
            <span style={mono(10, C.dim)}>{v.resolver}</span>
          </div>
          <div style={{ marginTop: 18 }}>
            <ProbabilityBar p={v.p} thresholds={thresholds} small />
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 16 }}>{evChips}</div>
          {changeOpen && (
            <div
              className="decision__alts"
              style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.line}` }}
            >
              {alts}
            </div>
          )}
        </article>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
          <SecondaryButton label="Change" op="local" height={44} onClick={onToggleChange} style={{ justifyContent: 'center' }} />
          <SecondaryButton label="Skip" op="decisions.resolve" height={44} onClick={onSkip} style={{ justifyContent: 'center' }} />
        </div>
      </>
    );

  return (
    <article
      className="decision"
      data-object={v.object}
      style={{
        maxWidth: 720,
        margin: '0 auto',
        background: C.panel,
        border: `1px solid ${C['line-2']}`,
        borderRadius: 12,
        padding: '32px 36px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <ObjectMark v={v} size={46} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 600, ...ellipsis }}>{v.objTitle}</div>
          <div style={{ fontSize: 13, color: C.muted, marginTop: 3 }}>{v.objSub}</div>
        </div>
        <WhoDecidesGlyph kind="you" />
        <ImpactChip impact={v.impact} />
      </div>
      <div
        className="decision__q"
        style={{ ...display(46, 700, '-0.035em'), lineHeight: 1.05, margin: '34px 0 32px', textWrap: 'balance' }}
      >
        {v.question}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '64px minmax(0,1fr)', rowGap: 20, columnGap: 16, alignItems: 'center' }}>
        <div style={label}>Pick</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {before.length > 0 && (
            <>
              {before}
              <span style={{ fontFamily: F.mono, color: C.dim }}>→</span>
            </>
          )}
          {pickChip}
          <span style={{ ...mono(11, C.dim), letterSpacing: '.1em' }}>{v.resolver}</span>
        </div>
        <div style={label}>P</div>
        <ProbabilityBar p={v.p} thresholds={thresholds} />
        <div style={label}>Why</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{evChips}</div>
      </div>
      {changeOpen && (
        <div
          className="decision__alts"
          style={{
            marginTop: 24,
            paddingTop: 20,
            borderTop: `1px solid ${C.line}`,
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <div style={{ ...eyebrow(C.gold), width: 72 }}>Change</div>
          {alts}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 30, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 10 }}>
          <SecondaryButton
            label="Change"
            op="local"
            kbd={hints ? 'C' : undefined}
            onClick={onToggleChange}
            disabled={v.alts.length === 0}
          />
          <SecondaryButton label="Skip" op="decisions.resolve" kbd={hints ? 'S' : undefined} onClick={onSkip} />
        </div>
        {hints && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', ...mono(11, C.dim) }}>
            <span style={{ padding: '1px 6px', border: `1px solid ${C['line-2']}`, borderRadius: 5 }}>A</span>accept
            <span style={{ padding: '1px 6px', border: `1px solid ${C['line-2']}`, borderRadius: 5, marginLeft: 8 }}>←</span>
            <span style={{ padding: '1px 6px', border: `1px solid ${C['line-2']}`, borderRadius: 5 }}>→</span>
          </div>
        )}
      </div>
    </article>
  );
}
