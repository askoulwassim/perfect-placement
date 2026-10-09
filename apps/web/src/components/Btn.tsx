import type { OpName } from '@perfect-placement/contracts';
import type { ButtonHTMLAttributes, CSSProperties } from 'react';

/**
 * The one op a button calls. `null` = navigation, `'local'` = view state only
 * (selection, filter, tone, expand). Rendered as data-op; tests assert it.
 */
export type ButtonOp = OpName | null | 'local';

type BtnProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style' | 'type'> & {
  op: ButtonOp;
  style?: CSSProperties;
  hover?: CSSProperties;
};

/*
 * Hover is pure CSS (#101). The prototype's `style-hover` used to be JS state
 * (mouseenter on, mouseleave off), and mouseleave is not delivered when a
 * button is disabled under the cursor, hidden, re-laid out after a click, or
 * left during a drag, so the hover style (often fg, near white) stuck. Now
 * each hover object becomes one class whose rule lives in a single injected
 * stylesheet, only under `(hover: hover)` and never on a disabled button.
 * `!important` lets the rule beat the inline prototype style, as before.
 */
const UNITLESS = new Set(['opacity', 'zIndex', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink', 'order']);
const registered = new Set<string>();

function declarations(hover: CSSProperties): string {
  return Object.entries(hover)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      const prop = k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
      const val = typeof v === 'number' && !UNITLESS.has(k) ? `${v}px` : String(v);
      return `${prop}: ${val} !important;`;
    })
    .join(' ');
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** The class carrying a hover object's styles; its rule is injected once. Exported for tests. */
export function hoverClass(hover: CSSProperties | undefined): string | undefined {
  if (!hover) return undefined;
  const body = declarations(hover);
  if (!body) return undefined;
  const cls = `pp-h-${hash(body)}`;
  if (!registered.has(cls) && typeof document !== 'undefined') {
    let sheet = document.getElementById('pp-hover') as HTMLStyleElement | null;
    if (!sheet) {
      sheet = document.createElement('style');
      sheet.id = 'pp-hover';
      document.head.appendChild(sheet);
    }
    sheet.appendChild(document.createTextNode(`@media (hover: hover) { .${cls}:hover:not(:disabled) { ${body} } }\n`));
    registered.add(cls);
  }
  return cls;
}

/** Every clickable element in the app is a Btn: one op, prototype inline style, hover overrides. */
export function Btn({ op, style, hover, children, className, ...rest }: BtnProps) {
  const cls = [className, hoverClass(hover)].filter(Boolean).join(' ') || undefined;
  return (
    <button
      type="button"
      data-op={op === null ? 'nav' : op}
      className={cls}
      style={{ cursor: rest.disabled ? 'default' : 'pointer', ...style }}
      {...rest}
    >
      {children}
    </button>
  );
}
