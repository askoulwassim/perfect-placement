import { tint } from '@perfect-placement/contracts';
import { type CSSProperties, useLayoutEffect, useState } from 'react';
import { C } from './theme';

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PAD = 6;

/** `prefers-reduced-motion: reduce`: the cue appears without fading in. */
export const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** First match of `selector` outside the Ask dialog (unless the selector targets Ask itself). */
function find(selector: string): HTMLElement | null {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector)))
    if (selector.startsWith('.ask') || !el.closest('.ask')) return el;
  return null;
}

/**
 * Step cue (Getting started, #24): a soft scrim with an emerald halo around the target and one short
 * sentence beside it, shown on arrival at a step's screen. Never blocks: clicks and keys pass through, and the
 * first click or key dismisses it (Esc only dismisses). Renders nothing until the target exists.
 */
export function Cue({ id, label, target, onDismiss }: { id: string; label: string; target: string; onDismiss: () => void }) {
  const [box, setBox] = useState<Box | null>(null);

  useLayoutEffect(() => {
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = find(target);
        if (!el) return setBox(null);
        const r = el.getBoundingClientRect();
        setBox((b) =>
          b && b.top === r.top && b.left === r.left && b.width === r.width && b.height === r.height
            ? b
            : { top: r.top, left: r.left, width: r.width, height: r.height },
        );
      });
    };
    measure();
    const mo = new MutationObserver(measure);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      cancelAnimationFrame(raf);
      mo.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [target]);

  const shown = box !== null;
  // A layout effect, not a passive one: the dismiss listeners are attached in the same commit that shows the cue, so a
  // click that lands right as it appears still dismisses it (a passive effect left a gap; the first-launch test caught it).
  useLayoutEffect(() => {
    if (!shown) return;
    const onPointer = () => onDismiss();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Esc only dismisses the cue (it does not also close Ask).
        e.preventDefault();
        e.stopPropagation();
      }
      onDismiss();
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('click', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('click', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [shown, onDismiss]);

  if (!box) return null;
  const still = reducedMotion();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const mid = box.top + box.height / 2;
  // Beside the target when there is room on its left (desktop header), else above (pinned mobile) or below.
  const place: CSSProperties =
    box.left > Math.max(220, vw / 2)
      ? { right: vw - box.left + PAD + 14, top: mid, transform: 'translateY(-50%)' }
      : box.top > vh / 2
        ? { left: box.left, bottom: vh - box.top + PAD + 12 }
        : { left: box.left, top: box.top + box.height + PAD + 12 };

  return (
    <div className="cue" data-cue={id}>
      <div
        className="cue__halo"
        style={{
          position: 'fixed',
          top: box.top - PAD,
          left: box.left - PAD,
          width: box.width + PAD * 2,
          height: box.height + PAD * 2,
          borderRadius: 14,
          boxShadow: `0 0 0 2px ${C.emerald}, 0 0 28px 6px ${tint['emerald-border']}, 0 0 0 200vmax ${tint.scrim}`,
          pointerEvents: 'none',
          zIndex: 80,
          animation: still ? 'none' : 'ppCue .3s ease',
        }}
      />
      <div
        className="cue__label"
        aria-live="polite"
        style={{
          position: 'fixed',
          ...place,
          zIndex: 81,
          pointerEvents: 'none',
          maxWidth: Math.min(320, vw - 32),
          background: C['emerald-deep'],
          color: C.fg,
          border: `1px solid ${C.emerald}`,
          borderRadius: 999,
          padding: '7px 14px',
          fontSize: 13,
          fontWeight: 600,
          animation: still ? 'none' : 'ppCue .3s ease',
        }}
      >
        {label}
      </div>
    </div>
  );
}
