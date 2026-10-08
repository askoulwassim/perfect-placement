import { color, font } from '@perfect-placement/contracts';
import type { CSSProperties } from 'react';

/*
 * Prototype styling, ported 1:1 from the Claude Design file (Perfect Placement.dc.html).
 * Colors come from the contracts tokens where they match. `X` holds the extra values the
 * prototype uses that tokens do not define yet (filed under "Lane D requests").
 */

export const C = color;

export const X = {
  railBg: 'rgba(9,26,45,0.6)',
  riverColBg: 'rgba(9,26,45,0.55)',
  bestHover: '#0E6B51',
  calShadow1: '#0A1C31',
  em06: 'rgba(47,211,155,0.06)',
  em07: 'rgba(47,211,155,0.07)',
  em08: 'rgba(47,211,155,0.08)',
  em04: 'rgba(47,211,155,0.04)',
  em03: 'rgba(47,211,155,0.03)',
  em12: 'rgba(47,211,155,0.12)',
  em14: 'rgba(47,211,155,0.14)',
  em15: 'rgba(47,211,155,0.15)',
  em16: 'rgba(47,211,155,0.16)',
  em18: 'rgba(47,211,155,0.18)',
  radarFill: 'rgba(47,211,155,0.16)',
  gold06: 'rgba(226,182,90,0.06)',
  gold08: 'rgba(226,182,90,0.08)',
  gold12: 'rgba(226,182,90,0.12)',
  gold16: 'rgba(226,182,90,0.16)',
  gold35: 'rgba(226,182,90,0.35)',
  gold50: 'rgba(226,182,90,0.5)',
  coral12: 'rgba(239,125,125,0.12)',
  coral14: 'rgba(239,125,125,0.14)',
  coral35: 'rgba(239,125,125,0.35)',
  deep18: 'rgba(11,92,69,0.18)',
  deep35: 'rgba(11,92,69,0.35)',
  mobileGlow: 'radial-gradient(500px 360px at 100% 0%, rgba(11,92,69,0.5), rgba(11,92,69,0) 70%)',
  shadowPill: '0 12px 40px rgba(0,0,0,0.35)',
  shadowAsk: '0 20px 60px rgba(0,0,0,0.45)',
} as const;

export const F = {
  display: font.display,
  ui: font.ui,
  mono: font.mono,
} as const;

export const eyebrow = (c: string = C.muted, size = 11): CSSProperties => ({
  fontFamily: F.mono,
  fontSize: size,
  letterSpacing: '.1em',
  textTransform: 'uppercase',
  color: c,
});

export const mono = (size: number, c?: string): CSSProperties => ({ fontFamily: F.mono, fontSize: size, ...(c ? { color: c } : {}) });

export const display = (size: number, weight = 800, ls = '-0.04em'): CSSProperties => ({
  fontFamily: F.display,
  fontWeight: weight,
  fontSize: size,
  letterSpacing: ls,
});

export const tab: CSSProperties = { fontVariantNumeric: 'tabular-nums' };

export const ellipsis: CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

/** Band color from fit (bands come from config.scoring). */
export const bandColor = (fit: number | null | undefined, b = { green_min: 75, yellow_min: 55 }) =>
  fit == null ? C.dim : fit >= b.green_min ? C.emerald : fit >= b.yellow_min ? C.gold : C.coral;

/** Probability color by policy thresholds. */
export const probColor = (p: number, t: { auto: number; second_opinion: number }) =>
  p >= t.auto ? C.emerald : p >= t.second_opinion ? C.gold : C.coral;

export const IMPACT_STYLE = {
  low: { fg: C.emerald, bg: 'rgba(47,211,155,0.1)', border: 'rgba(47,211,155,0.4)' },
  medium: { fg: C.gold, bg: 'rgba(226,182,90,0.1)', border: 'rgba(226,182,90,0.4)' },
  high: { fg: C.coral, bg: 'rgba(239,125,125,0.1)', border: 'rgba(239,125,125,0.45)' },
} as const;
