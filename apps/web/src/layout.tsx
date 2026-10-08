import { createContext, type ReactNode, useContext } from 'react';
import { createPortal } from 'react-dom';
import type { ButtonOp } from './components/Btn';
import { PrimaryButton } from './components/controls';
import { ScreenHeader } from './components/shell';

export interface Layout {
  mobile: boolean;
  /** Mobile: the slot above the tab bar where the primary button is pinned. */
  slot: HTMLElement | null;
}
export const LayoutCtx = createContext<Layout>({ mobile: false, slot: null });
export const useLayout = () => useContext(LayoutCtx);

export interface Primary {
  label: string;
  op: ButtonOp;
  onClick: () => void;
  disabled?: boolean;
  dim?: boolean;
}

/** Header (eyebrow, title, back, primary top right) + body. On mobile the primary pins above the tab bar. */
export function Screen({
  label,
  eyebrow,
  title,
  back,
  primary,
  children,
}: {
  label: string;
  eyebrow: string;
  title: string;
  back?: () => void;
  primary?: Primary | null;
  children: ReactNode;
}) {
  const { mobile, slot } = useLayout();
  const btn = (m: boolean) =>
    primary ? (
      <PrimaryButton
        label={primary.label}
        op={primary.op}
        onClick={primary.onClick}
        disabled={primary.disabled}
        dim={primary.dim}
        mobile={m}
      />
    ) : null;
  if (mobile)
    return (
      <div data-screen-label={label}>
        <ScreenHeader mobile eyebrow={eyebrow} title={title} onBack={back} />
        {children}
        {slot && primary ? createPortal(btn(true), slot) : null}
      </div>
    );
  return (
    <div data-screen-label={label}>
      <ScreenHeader eyebrow={eyebrow} title={title} onBack={back} primary={btn(false)} />
      {children}
    </div>
  );
}
