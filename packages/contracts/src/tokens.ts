import type { ContactTier, Impact, OutreachStatus, ProfileComponentKey, RoleStatus } from './enums.js';
import { PROFILE_COMPONENT_KIND } from './enums.js';

/*
 * Design tokens. Source: Claude Design handoff (project fcd74e19, Handoff.md §1),
 * imported in Wave 0 on 2026-10-08. The prototype wins over the written brief.
 * `dist/tokens.css` is generated from this file at build time; apps/web imports
 * `@perfect-placement/contracts/tokens.css`. Never hand-edit the CSS.
 */

export const color = {
  bg: '#06111F',
  'bg-2': '#091A2D',
  panel: '#0C1F36',
  'panel-2': '#11284A',
  line: '#1A3557',
  'line-2': '#26486F',
  fg: '#E6EEF6',
  muted: '#8EA3BB',
  dim: '#5C7491',
  emerald: '#2FD39B',
  'emerald-hover': '#5BE3B3',
  'emerald-2': '#17A77A',
  'emerald-deep': '#0B5C45',
  'emerald-ink': '#04291F',
  gold: '#E2B65A',
  coral: '#EF7D7D',
  sky: '#7FB6FF',
} as const;

export const tint = {
  emerald: 'rgba(47,211,155,0.10)',
  'emerald-border': 'rgba(47,211,155,0.40)',
  gold: 'rgba(226,182,90,0.10)',
  'gold-border': 'rgba(226,182,90,0.40)',
  coral: 'rgba(239,125,125,0.10)',
  'coral-border': 'rgba(239,125,125,0.45)',
  sky: 'rgba(127,182,255,0.10)',
  scrim: 'rgba(6,17,31,0.62)',
} as const;

export const groundGlow = 'radial-gradient(900px 620px at 100% 0%, rgba(11,92,69,0.55), rgba(11,92,69,0) 70%)';

export const font = {
  display: "'Bricolage Grotesque', sans-serif",
  ui: 'Figtree, sans-serif',
  mono: "'JetBrains Mono', monospace",
} as const;

export interface TypeStyle {
  font: keyof typeof font;
  size: number;
  weight: number;
  tracking?: string;
  lineHeight?: number;
  numeric?: 'tabular-nums';
  case?: 'upper';
}

export const typeScale = {
  'hero-number': { font: 'display', size: 104, weight: 800, tracking: '-0.05em', lineHeight: 0.9, numeric: 'tabular-nums' },
  'fit-number': { font: 'display', size: 84, weight: 800, tracking: '-0.05em', lineHeight: 0.9 },
  'onboard-q': { font: 'display', size: 72, weight: 800, tracking: '-0.04em' },
  'count-tile': { font: 'display', size: 64, weight: 800, tracking: '-0.04em' },
  'decision-q': { font: 'display', size: 46, weight: 700, tracking: '-0.035em', lineHeight: 1.05 },
  'screen-title': { font: 'display', size: 44, weight: 800, tracking: '-0.035em', lineHeight: 1.05 },
  'card-number': { font: 'display', size: 38, weight: 800, tracking: '-0.04em' },
  'panel-title': { font: 'display', size: 32, weight: 800, tracking: '-0.03em' },
  'body-lg': { font: 'ui', size: 18, weight: 400, lineHeight: 1.55 },
  title: { font: 'ui', size: 16, weight: 600 },
  body: { font: 'ui', size: 14, weight: 500 },
  caption: { font: 'ui', size: 13, weight: 400 },
  small: { font: 'ui', size: 12, weight: 400 },
  eyebrow: { font: 'mono', size: 11, weight: 400, tracking: '0.1em', case: 'upper' },
  mono: { font: 'mono', size: 12, weight: 400 },
  prob: { font: 'mono', size: 14, weight: 400, numeric: 'tabular-nums' },
} as const satisfies Record<string, TypeStyle>;

/** Spacing scale in px. */
export const space = [4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56] as const;

export const layout = {
  rail: 76,
  pagePadX: 48,
  pagePadTop: 32,
  maxWidth: 1440,
  decisionCardMax: 720,
  sidePanel: 380,
  mobile: 390,
  mobileTabBar: 70,
} as const;

export const radius = { card: 12, button: 10, small: 8, chip: 999, phone: 36 } as const;

export const control = { buttonH: 44, chipH: 34, mobileHit: 44, mobilePrimaryH: 50 } as const;

export const focus = { width: 2, color: color.emerald, offset: 2 } as const;

export const motion = { fast: '150ms', base: '250ms', ring: '600ms ease', bounce: '450ms' } as const;

export const tokens = { color, tint, groundGlow, font, type: typeScale, space, layout, radius, control, focus, motion } as const;
export type Tokens = typeof tokens;

// ------------------------------------------------------------ semantic maps
// Shared by the UI (lane D) and generated replies (lane J) so state reads the same everywhere.

export type ColorName = keyof typeof color;

/** StatusChip outline color per status (handoff §2). */
export const STATUS_COLOR: Record<RoleStatus, ColorName> = {
  inbox: 'dim',
  active: 'emerald',
  held: 'gold',
  'on-deck': 'sky',
  'draft-ready': 'emerald',
  applied: 'emerald',
  interviews: 'gold',
  offers: 'emerald',
  archived: 'coral',
};

export const IMPACT_COLOR: Record<Impact, ColorName> = { low: 'emerald', medium: 'gold', high: 'coral' };

export const KIND_COLOR = { filter: 'gold', weighted: 'emerald', asset: 'sky' } as const satisfies Record<string, ColorName>;

export const componentColor = (key: ProfileComponentKey): ColorName => KIND_COLOR[PROFILE_COMPONENT_KIND[key]];

/** ContactAvatar ring per tier. */
export const TIER_RING: Record<ContactTier, { color: ColorName; dashed: boolean }> = {
  warm_hiring: { color: 'emerald', dashed: false },
  warm_other: { color: 'emerald-deep', dashed: false },
  bridge: { color: 'emerald', dashed: true },
  cold_hiring: { color: 'sky', dashed: false },
  cold_other: { color: 'dim', dashed: true },
};

/** DraftStatusChip ('none' = no outreach row yet). */
export const DRAFT_STATUS_COLOR: Record<OutreachStatus | 'none', ColorName> = {
  none: 'dim',
  drafted: 'gold',
  in_gmail: 'emerald',
  replied: 'sky',
  ignored: 'dim',
};

/** BandDot. Band thresholds come from config.scoring, not from here. */
export const BAND_COLOR = { green: 'emerald', yellow: 'gold', red: 'coral' } as const satisfies Record<string, ColorName>;
