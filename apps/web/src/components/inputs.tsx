import { formatMoney, parseMoney } from '@perfect-placement/contracts';
import { type ClipboardEvent, type KeyboardEvent, useRef, useState } from 'react';
import { Btn } from './Btn';
import { C, display, mono, tab } from './theme';

// ------------------------------------------------------------ chip input (#75)

/** Split pasted or typed text into entries: commas and new lines separate. */
export const splitEntries = (text: string): string[] =>
  text
    .split(/[,\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** The list with new entries appended; blanks and duplicates (case-insensitive) are ignored. */
export function addEntries(list: readonly string[], incoming: readonly string[], max?: number): string[] {
  const out = [...list];
  const seen = new Set(out.map((s) => s.toLowerCase()));
  for (const raw of incoming) {
    const s = raw.trim();
    if (!s || seen.has(s.toLowerCase())) continue;
    if (max != null && out.length >= max) break;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out;
}

type ChipSize = 'lg' | 'sm';
const SIZE: Record<ChipSize, { font: number; chip: number; pad: string; minH: number; radius: number }> = {
  lg: { font: 18, chip: 15, pad: '10px 14px', minH: 56, radius: 12 },
  sm: { font: 13, chip: 12, pad: '3px 6px', minH: 32, radius: 8 },
};

/**
 * Every multi-value field (#75): Enter or Tab commits the typed entry as a chip, Backspace on an empty
 * entry removes the last chip, each chip's x removes it, a paste splits on commas and new lines,
 * duplicates are ignored. The entry being typed can be held by the caller (`draft`) so a form can
 * count it before it is committed.
 */
export function ChipInput({
  value,
  onChange,
  label,
  name,
  placeholder,
  size = 'lg',
  max,
  draft: draftProp,
  onDraftChange,
}: {
  value: readonly string[];
  onChange: (next: string[]) => void;
  /** Accessible name of the entry field. */
  label: string;
  name?: string;
  placeholder?: string;
  size?: ChipSize;
  max?: number;
  draft?: string;
  onDraftChange?: (text: string) => void;
}) {
  const [own, setOwn] = useState('');
  const draft = draftProp ?? own;
  const setDraft = onDraftChange ?? setOwn;
  const input = useRef<HTMLInputElement>(null);
  const s = SIZE[size];
  const full = max != null && value.length >= max;

  const commit = (text = draft) => {
    const next = addEntries(value, splitEntries(text), max);
    if (next.length !== value.length) onChange(next);
    setDraft('');
  };
  const remove = (i: number) => {
    onChange(value.filter((_, j) => j !== i));
    input.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === 'Tab') && draft.trim()) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Enter') {
      e.preventDefault();
    } else if (e.key === 'Backspace' && !draft && value.length) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (!/[,\n\r]/.test(text)) return;
    e.preventDefault();
    commit(`${draft}${text}`);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking the frame focuses its entry field (the field and chips stay keyboard reachable).
    // biome-ignore lint/a11y/useKeyWithClickEvents: the entry field itself takes the keys.
    <div
      className="chip-input"
      onClick={(e) => {
        if (e.target === e.currentTarget) input.current?.focus();
      }}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
        minHeight: s.minH,
        boxSizing: 'border-box',
        width: '100%',
        minWidth: 0,
        background: size === 'sm' ? C['bg-2'] : 'transparent',
        border: `${size === 'sm' ? 1 : 1.5}px solid ${C['line-2']}`,
        borderRadius: s.radius,
        padding: s.pad,
        cursor: 'text',
      }}
    >
      {value.length > 0 && (
        <ul aria-label={label} style={{ display: 'contents', listStyle: 'none', margin: 0, padding: 0 }}>
          {value.map((v, i) => (
            <li
              key={v}
              className="chip-input__chip"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: C['panel-2'],
                border: `1px solid ${C['emerald-2']}`,
                borderRadius: 999,
                padding: size === 'sm' ? '2px 4px 2px 10px' : '6px 6px 6px 14px',
                fontSize: s.chip,
                color: C.fg,
                maxWidth: '100%',
              }}
            >
              <span style={{ overflowWrap: 'anywhere' }}>{v}</span>
              <Btn
                op="local"
                aria-label={`Remove ${v}`}
                onClick={() => remove(i)}
                style={{
                  background: 'transparent',
                  border: 0,
                  color: C.muted,
                  fontSize: s.chip + 2,
                  lineHeight: 1,
                  padding: '0 4px',
                  borderRadius: 999,
                }}
                hover={{ color: C.fg }}
              >
                ×
              </Btn>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={input}
        name={name}
        aria-label={label}
        value={draft}
        disabled={full}
        placeholder={value.length ? undefined : placeholder}
        onChange={(e) => {
          const t = e.target.value;
          if (/[\n\r]/.test(t)) commit(t);
          else setDraft(t);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => {
          if (draft.trim()) commit();
        }}
        style={{
          flex: '1 1 120px',
          minWidth: 80,
          height: size === 'sm' ? 24 : 34,
          background: 'transparent',
          border: 0,
          outline: 'none',
          color: C.fg,
          fontSize: s.font,
          fontFamily: 'inherit',
          padding: '0 4px',
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------ number + slider (#73)

export type SliderUnit = 'money' | 'percent';

/** A value as the slider shows it: money compact (`$212.5k`), percent (`40%`), else the number. */
export const formatUnit = (n: number, unit?: SliderUnit) =>
  unit === 'money' ? formatMoney(n) : unit === 'percent' ? `${n}%` : n.toLocaleString('en-US');

/** What the entry field shows: money in full (`212,500`), else the plain number. */
const entryText = (n: number, unit?: SliderUnit) => (unit === 'money' ? n.toLocaleString('en-US') : String(n));

/** Typed text -> a number (money accepts `212500`, `$212,500`, `212.5k`), or null. */
export const parseUnit = (text: string, unit?: SliderUnit): number | null => {
  if (unit === 'money') return parseMoney(text);
  const n = Number(text.replace(/[%\s,]/g, ''));
  return text.trim() && Number.isFinite(n) ? n : null;
};

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const STEP_KEYS: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };

/**
 * A number field and a slider kept in sync (#73): type an exact value, then fine-tune with the slider
 * (`step`, default 1k for money; `coarseStep` with Shift held, default 5k). Typed values are clamped to
 * the bounds when the field is left.
 */
export function SliderInput({
  value,
  onChange,
  min,
  max,
  step,
  coarseStep,
  unit,
  label,
}: {
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  step?: number;
  coarseStep?: number;
  unit?: SliderUnit;
  label: string;
}) {
  const fine = step ?? (unit === 'money' ? 1000 : 1);
  const coarse = coarseStep ?? (unit === 'money' ? 5000 : fine * 5);
  const [text, setText] = useState<string | null>(null);
  const [shift, setShift] = useState(false);
  const shown = text ?? entryText(value, unit);

  return (
    <div className="slider-input" style={{ maxWidth: 620 }}>
      <div className="slider-input__value" style={{ ...display(64, 800, '-0.04em'), color: C.emerald, ...tab }}>
        {formatUnit(value, unit)}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 18 }}>
        <input
          type="range"
          aria-label={label}
          min={min}
          max={max}
          step={shift ? coarse : fine}
          value={value}
          onChange={(e) => {
            setText(null);
            onChange(Number(e.target.value));
          }}
          onPointerDown={(e) => setShift(e.shiftKey)}
          onPointerUp={() => setShift(false)}
          onKeyDown={(e) => {
            const dir = STEP_KEYS[e.key];
            if (!dir || !e.shiftKey) return;
            e.preventDefault();
            setText(null);
            onChange(clamp(value + dir * coarse, min, max));
          }}
          style={{ flex: 1, minWidth: 0 }}
        />
        <input
          className="slider-input__entry"
          aria-label={`${label} (exact)`}
          inputMode="decimal"
          value={shown}
          onChange={(e) => {
            setText(e.target.value);
            const n = parseUnit(e.target.value, unit);
            if (n != null && n >= min && n <= max) onChange(n);
          }}
          onBlur={() => {
            const n = text == null ? null : parseUnit(text, unit);
            if (n != null) onChange(clamp(n, min, max));
            setText(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          style={{
            width: 140,
            height: 44,
            boxSizing: 'border-box',
            background: 'transparent',
            border: `1.5px solid ${C['line-2']}`,
            borderRadius: 10,
            color: C.fg,
            fontSize: 18,
            padding: '0 14px',
            fontFamily: 'inherit',
            textAlign: 'right',
            ...tab,
          }}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', ...mono(11, C.dim), marginTop: 6, marginRight: 156 }}>
        <span>{formatUnit(min, unit)}</span>
        <span>{formatUnit(max, unit)}</span>
      </div>
    </div>
  );
}
