import type { OpName } from '@perfect-placement/contracts';
import { type ButtonHTMLAttributes, type CSSProperties, useState } from 'react';
import type { ShimName } from '../client/types';

/**
 * The one op a button calls. `null` = navigation, `'local'` = view state only
 * (selection, filter, tone, expand). Rendered as data-op; tests assert it.
 */
export type ButtonOp = OpName | ShimName | null | 'local';

/** Hover state, the runtime equivalent of the prototype's `style-hover`. */
export function useHover() {
  const [hover, setHover] = useState(false);
  return [hover, { onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) }] as const;
}

type BtnProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style' | 'type'> & {
  op: ButtonOp;
  style?: CSSProperties;
  hover?: CSSProperties;
};

/** Every clickable element in the app is a Btn: one op, prototype inline style, hover overrides. */
export function Btn({ op, style, hover, children, onMouseEnter, onMouseLeave, ...rest }: BtnProps) {
  const [h, setH] = useState(false);
  return (
    <button
      type="button"
      data-op={op === null ? 'nav' : op}
      style={{ cursor: rest.disabled ? 'default' : 'pointer', ...style, ...(h && !rest.disabled ? hover : null) }}
      onMouseEnter={(e) => {
        setH(true);
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        setH(false);
        onMouseLeave?.(e);
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
