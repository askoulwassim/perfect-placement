import type { Impact } from '@perfect-placement/contracts';
import { type CSSProperties, useState } from 'react';
import { EMAIL_CHECKER_URL } from '../lib/decisions';
import { Btn } from './Btn';
import { ImpactChip, Kbd, SecondaryButton } from './controls';
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
  /** Free-text change (#54 fact check: rewrite the line); the text is the changed value. */
  edit?: string;
  /** #99: email candidates with their evidence labels; the user checks each by hand (Check, Valid, Invalid). */
  emailChecks?: ReadonlyArray<{ address: string; labels: readonly string[] }>;
  /** #102: the role's posting, opened in a new tab (Open posting, key O). */
  url?: string;
  /** #102: freshness cards: when the posting was last checked and the evidence, short. */
  checked?: string;
}

/** Open posting (#102): a plain external link, not an op button. */
function PostingLink({ url, kbd, height, style }: { url: string; kbd?: string; height: number; style?: CSSProperties }) {
  return (
    <a
      className="open-posting"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      data-op="nav"
      style={{
        color: C.fg,
        border: `1px solid ${C['line-2']}`,
        borderRadius: 10,
        height,
        padding: '0 14px',
        fontSize: 14,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        ...style,
      }}
    >
      {kbd && <Kbd k={kbd} />}
      Open posting ↗
    </a>
  );
}

export type EmailCheckResult = 'valid' | 'invalid';

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
  onEmailCheck,
}: {
  v: DecisionView;
  thresholds: { auto: number; second_opinion: number };
  changeOpen: boolean;
  hints?: boolean;
  mobile?: boolean;
  onToggleChange: () => void;
  onPick: (value: string | boolean | number) => void;
  onSkip: () => void;
  onEmailCheck?: (address: string, result: EmailCheckResult) => void;
}) {
  const [ev, setEv] = useState(-1);
  const checks = v.emailChecks?.length ? <EmailChecks rows={v.emailChecks} mobile={mobile} onCheck={onEmailCheck} /> : null;
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
  const editor = v.edit !== undefined && <EditField key={v.edit} initial={v.edit} mobile={mobile} onSave={(t) => onPick(t)} />;
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
          {v.checked && (
            <div className="decision__checked" style={{ ...mono(11, C.muted), margin: '-8px 0 18px' }}>
              Checked {v.checked}
            </div>
          )}
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
          {checks}
          {changeOpen && (
            <div
              className="decision__alts"
              style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.line}` }}
            >
              {alts}
              {editor}
            </div>
          )}
        </article>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
          <SecondaryButton label="Change" op="local" height={44} onClick={onToggleChange} style={{ justifyContent: 'center' }} />
          <SecondaryButton label="Skip" op="decisions.resolve" height={44} onClick={onSkip} style={{ justifyContent: 'center' }} />
          {v.url && <PostingLink url={v.url} height={44} style={{ gridColumn: '1 / -1', justifyContent: 'center' }} />}
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
        {v.checked && (
          <>
            <div style={label}>Checked</div>
            <div className="decision__checked" style={{ ...mono(12, C.muted), ...ellipsis }} title={v.checked}>
              {v.checked}
            </div>
          </>
        )}
      </div>
      {checks}
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
          {editor}
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
          {v.url && <PostingLink url={v.url} kbd={hints ? 'O' : undefined} height={40} />}
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

/** Copy to the clipboard; a refused or missing clipboard is ignored (the link still opens). */
async function copy(text: string) {
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    // No clipboard permission: the user types or pastes the address themselves.
  }
}

const pill = (mobile?: boolean) => ({
  border: `1px solid ${C['line-2']}`,
  background: 'transparent',
  color: C.fg,
  borderRadius: 999,
  padding: mobile ? '0 12px' : '5px 12px',
  height: mobile ? 36 : undefined,
  fontSize: 12,
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
});

/**
 * #99: one row per candidate: the address, its evidence labels, **Check** (opens the address checker in a
 * new tab and copies the address; no op), **Valid** and **Invalid** (`people.email_checked`).
 */
function EmailChecks({
  rows,
  mobile,
  onCheck,
}: {
  rows: NonNullable<DecisionView['emailChecks']>;
  mobile?: boolean;
  onCheck?: (address: string, result: EmailCheckResult) => void;
}) {
  return (
    <div className="decision__checks" style={{ marginTop: mobile ? 16 : 24, paddingTop: 14, borderTop: `1px solid ${C.line}` }}>
      <div style={{ ...label, marginBottom: 10 }}>Check</div>
      {rows.map((r) => (
        <div
          key={r.address}
          className="email-check"
          data-address={r.address}
          style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0' }}
        >
          <span style={{ ...mono(12), flex: mobile ? '1 1 100%' : '1 1 220px', minWidth: 0, ...ellipsis }}>{r.address}</span>
          {r.labels.map((l) => (
            <span key={l} className="email-check__label" style={{ ...mono(11, C.muted), whiteSpace: 'nowrap' }}>
              {l}
            </span>
          ))}
          <a
            href={EMAIL_CHECKER_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-op="local"
            onClick={() => void copy(r.address)}
            style={pill(mobile)}
          >
            Check
          </a>
          <Btn
            op="people.email_checked"
            onClick={() => onCheck?.(r.address, 'valid')}
            style={pill(mobile)}
            hover={{ borderColor: C['emerald-2'] }}
          >
            Valid
          </Btn>
          <Btn
            op="people.email_checked"
            onClick={() => onCheck?.(r.address, 'invalid')}
            style={pill(mobile)}
            hover={{ borderColor: X.gold50 }}
          >
            Invalid
          </Btn>
        </div>
      ))}
    </div>
  );
}

/** Rewrite the text (one line) and save it as the changed value. */
function EditField({ initial, mobile, onSave }: { initial: string; mobile?: boolean; onSave: (text: string) => void }) {
  const [text, setText] = useState(initial);
  const changed = text.trim() !== '' && text.trim() !== initial.trim();
  return (
    <div className="decision__edit" style={{ display: 'flex', gap: 8, alignItems: 'center', flex: '1 1 100%', marginTop: 4 }}>
      <input
        aria-label="Edit"
        value={text}
        onChange={(e) => setText(e.target.value)}
        style={{
          flex: 1,
          minWidth: 0,
          height: mobile ? 44 : 36,
          background: C['bg-2'],
          border: `1px solid ${C['line-2']}`,
          borderRadius: 8,
          color: C.fg,
          padding: '0 12px',
          fontSize: 13,
        }}
      />
      <Btn
        op="decisions.resolve"
        disabled={!changed}
        onClick={() => onSave(text.trim())}
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
        Save
      </Btn>
    </div>
  );
}
