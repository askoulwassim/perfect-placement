import { z } from 'zod';
import type { OpName } from './ops/registry.js';

/*
 * UI inventory from the Claude Design handoff (Handoff.md §2, §3), confirmed in Wave 0.
 * Lane D implements every component; lane J registers RoleCard, ScoreRadar, ContactCard
 * (= ContactAvatar + name), ProfileDiff (= DiffBlock) with OpenUI.
 * Props here are the contract surface; lanes may add optional props.
 */

export interface ComponentSpec {
  props: readonly string[];
  states?: readonly string[];
}

export const COMPONENTS = {
  RoleTile: { props: ['letter', 'fresh: ok|unsure|closed|none'], states: ['ok', 'unsure', 'closed', 'none'] },
  FreshnessRing: { props: ['fresh', 'size'] },
  BandDot: { props: ['fit'] },
  WhoDecidesGlyph: { props: ['kind: auto|second|undo|you', 'left: 0..1'] },
  PrimaryButton: { props: ['label', 'op', 'disabled'], states: ['default', 'hover', 'focus', 'disabled'] },
  SecondaryButton: { props: ['label', 'op', 'kbd?'] },
  Chip: {
    props: ['variant: fact|filter|impact|status|reason|diff-before|diff-after|evidence', 'label', 'value?'],
  },
  StatusChip: { props: ['status'] },
  ImpactChip: { props: ['impact'] },
  ProbabilityBar: { props: ['p', 'thresholds'] },
  HeroRing: { props: ['count', 'fill'] },
  CountTile: { props: ['icon', 'value', 'color'] },
  AutoRow: { props: ['glyph', 'object', 'action', 'time', 'undoable'], states: ['default', 'hover', 'undone'] },
  RoleCard: { props: ['role'], states: ['default', 'hover'] },
  RiverColumn: { props: ['status', 'roles', 'extraCount', 'zoom: tiles|dots'], states: ['idle', 'drop-allowed', 'source'] },
  RiverTile: { props: ['role', 'stackCount'], states: ['default', 'dimmed', 'dragging', 'bounce', 'stacked'] },
  ScoreRadar: { props: ['criteria[9]', 'size'] },
  AffinityChip: { props: ['value: -5..5'] },
  StageRail: { props: ['stage: 0..5'], states: ['done', 'current', 'future'] },
  ContactAvatar: { props: ['initials', 'tier'] },
  BestPathPill: { props: ['path[]'] },
  PeopleGraph: { props: ['nodes', 'edges'] },
  DraftStatusChip: { props: ['status: none|drafted|in_gmail|replied'] },
  OutreachBlock: { props: ['label: Hook|Proof|Ask', 'text'] },
  ToneChips: { props: ['tones[]', 'recommended', 'selected'] },
  ProfileNode: { props: ['name', 'kind', 'confidence', 'pending', 'selected'] },
  Constellation: { props: ['components[11]', 'selected'] },
  DiffBlock: { props: ['before[]', 'after[]', 'onReject'] },
  VersionTimeline: { props: ['versions[{v,event,date}]'] },
  DecisionCard: {
    props: ['object: role|mail|profile|contact', 'question', 'pick', 'resolver', 'p', 'impact', 'evidence[]', 'alts[]', 'diff?'],
    states: ['default', 'change-open', 'evidence-expanded'],
  },
  ProgressDots: { props: ['count', 'index', 'resolved[]'] },
  CommandBar: { props: ['open', 'query', 'suggestions[]', 'reply'], states: ['collapsed', 'input', 'streaming'] },
  PolicyGrid: { props: ['thresholds[2]', 'cells[3][3]'] },
  Toggle: { props: ['on'] },
  BackendCard: { props: ['name', 'mode', 'status', 'latencyMs'] },
  Toast: { props: ['text'] },
  NavRail: { props: ['active', 'needsBadge'] },
  TabBar: { props: ['active', 'needsBadge'] },
} as const satisfies Record<string, ComponentSpec>;
export type ComponentName = keyof typeof COMPONENTS;

/**
 * Brief names that map to handoff components. `NeedsYouRing` = HeroRing.
 * `ContactCard` and `ProfileDiff` are the OpenUI names (lane J).
 */
export const COMPONENT_ALIASES = {
  NeedsYouRing: 'HeroRing',
  ContactCard: 'ContactAvatar',
  ProfileDiff: 'DiffBlock',
} as const satisfies Record<string, ComponentName>;

export const SCREENS = ['now', 'needs-you', 'river', 'role', 'people', 'outreach-draft', 'you', 'onboarding', 'ask', 'settings'] as const;
export type Screen = (typeof SCREENS)[number];

/**
 * The one primary action per screen and the op it calls. `null` = navigation only
 * (Review N, Open portal opens the external URL; the app never submits).
 * Labels with `<...>` are templates the UI fills (e.g. `Draft for <first name>`).
 * Order within a screen = the state progression (only one shows at a time).
 */
export const PRIMARY_ACTIONS: Record<Screen, ReadonlyArray<{ label: string; op: OpName | null }>> = {
  now: [
    { label: 'Review N', op: null },
    { label: 'Open River', op: null },
  ],
  'needs-you': [
    { label: 'Accept', op: 'decisions.resolve' },
    { label: 'Open portal', op: null },
    /** Queue clear. */
    { label: 'Back to Now', op: null },
  ],
  river: [{ label: 'Scout now', op: 'runs.start' }],
  role: [
    { label: 'Research', op: 'runs.start' },
    { label: 'Tailor', op: 'runs.start' },
    { label: 'Connect', op: 'runs.start' },
    { label: 'Fill', op: 'runs.start' },
    { label: 'Open portal', op: null },
    /** Once applied. */
    { label: 'Open River', op: null },
  ],
  people: [{ label: 'Draft for <first name>', op: 'runs.start' }],
  /** Starts a `connect` run scoped to the outreach; the agent creates the draft with its Gmail tool. */
  'outreach-draft': [{ label: 'Create Gmail draft', op: 'runs.start' }],
  you: [
    { label: 'Review diff', op: null },
    { label: 'Accept diff', op: 'profile.apply_diff' },
    /** Starts a recalibration session (#25); the calibrate step then runs in You. */
    { label: 'Recalibrate', op: 'onboard.start' },
  ],
  /**
   * `Next` calls `onboard.answer` on the Interview step only; on Resume and Calibrate it navigates
   * (those steps call `onboard.ingest_resume` and `onboard.calibrate` from the drop zone and N/M/Y).
   * Since #25 these steps run inside You (setup with no profile, re-interview, recalibrate); `Save`
   * confirms a re-interview or recalibration.
   */
  onboarding: [
    { label: 'Next', op: null },
    { label: 'Next', op: 'onboard.answer' },
    { label: 'Start', op: 'onboard.confirm' },
    { label: 'Save', op: 'onboard.confirm' },
  ],
  ask: [{ label: 'Check all', op: 'roles.check_freshness' }],
  settings: [{ label: 'Save', op: 'config.update' }],
};

/** Mobile (390px) screens with the bottom tab bar. */
export const MOBILE_SCREENS = ['now', 'needs-you', 'role', 'river', 'you', 'outreach-draft'] as const satisfies readonly Screen[];
export const MOBILE_TABS = ['now', 'river', 'you', 'ask'] as const satisfies readonly Screen[];

/** Labels that must never appear on a button (design.md non-negotiables). */
export const FORBIDDEN_BUTTON_LABELS = ['Send', 'Submit', 'Apply now'] as const;

/**
 * Generated-UI card props (lane J, OpenUI). Id-only: cards fetch their data through ops.
 * Key order is part of the contract (OpenUI maps positional args by key order).
 */
export const GENUI_PROPS = {
  RoleCard: z.object({ roleId: z.string() }),
  ScoreRadar: z.object({ roleId: z.string() }),
  ContactCard: z.object({ contactId: z.string(), roleId: z.string().optional() }),
  ProfileDiff: z.object({ diffId: z.string() }),
} as const;
export type GenuiCard = keyof typeof GENUI_PROPS;
