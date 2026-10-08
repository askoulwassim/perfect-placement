// STAND-IN styling helpers. Wave 2 drops this file with the stand-ins (lane D owns real styles via tokens.css).
import { type ColorName, tokens } from '@perfect-placement/contracts';
import type { CSSProperties } from 'react';

export const c = (name: ColorName): string => tokens.color[name];

export const card: CSSProperties = {
  background: c('panel'),
  border: `1px solid ${c('line')}`,
  borderRadius: tokens.radius.card,
  padding: tokens.space[6],
  color: c('fg'),
  fontFamily: tokens.font.ui,
};

export const eyebrow: CSSProperties = {
  fontFamily: tokens.font.mono,
  fontSize: tokens.type.eyebrow.size,
  letterSpacing: tokens.type.eyebrow.tracking,
  textTransform: 'uppercase',
  color: c('muted'),
};

export const chip = (color: ColorName): CSSProperties => ({
  display: 'inline-block',
  border: `1px solid ${c(color)}`,
  color: c(color),
  borderRadius: tokens.radius.chip,
  padding: '2px 10px',
  fontSize: tokens.type.small.size,
});
