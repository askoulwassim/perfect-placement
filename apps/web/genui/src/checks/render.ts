import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  el: HTMLElement;
  root: Root;
  rerender(node: ReactNode): Promise<void>;
  unmount(): void;
}

export async function mount(node: ReactNode): Promise<Mounted> {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => root.render(node));
  return {
    el,
    root,
    rerender: async (n) => act(async () => root.render(n)),
    unmount: () => {
      root.unmount();
      el.remove();
    },
  };
}

export const all = (el: HTMLElement, kind: string) => Array.from(el.querySelectorAll(`[data-genui="${kind}"]`));
