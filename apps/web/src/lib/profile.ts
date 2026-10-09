import { formatMoney, type ProfileComponentKey, parseMoney } from '@perfect-placement/contracts';
import { humanize } from './format';

export const COMPONENT_NAME: Record<ProfileComponentKey, string> = {
  story: 'Story',
  craft: 'Craft',
  domain: 'Domain',
  work_mode: 'Work mode',
  terms: 'Terms',
  company: 'Company',
  team: 'Team',
  growth: 'Growth',
  dealbreakers: 'Dealbreakers',
  voice: 'Voice',
  network: 'Network',
};

/** Provenance and links, not facts to show as chips (#38); Application defaults have their own editor (#42). */
const META_KEYS = new Set(['source_path', 'source_file', 'dictated', 'extracted_by', 'years_basis', 'application_defaults']);

/** Application defaults (#42) as You edits them: field, label (1-3 words), list or text. */
export const DEFAULT_FIELDS = [
  ['sponsorship', 'Sponsorship', 'no / yes'],
  ['authorized_countries', 'Work countries', 'United States, Canada'],
  ['relocation', 'Relocation', 'no / yes / depends on the role'],
  ['notice_period', 'Notice', '2 weeks'],
  ['in_office', 'Office days', '0 / 1-2 / 3 / 4-5'],
  ['comp_expectation', 'Comp', ''],
  ['eeo', 'EEO', 'Prefer not to say'],
] as const;
export type DefaultField = (typeof DEFAULT_FIELDS)[number][0];

/** Defaults kept as lists: edited as chips (#75). */
export const LIST_DEFAULTS: ReadonlySet<DefaultField> = new Set<DefaultField>(['authorized_countries']);

/** The editor's text for each field (lists comma-joined). */
export function defaultsText(d: Record<string, unknown> | undefined): Record<DefaultField, string> {
  const out = {} as Record<DefaultField, string>;
  for (const [f] of DEFAULT_FIELDS) {
    const v = d?.[f];
    out[f] = Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : '';
  }
  return out;
}

/** Editor text -> `profile.set_defaults` input (an empty field clears it). */
export function defaultsInput(t: Record<DefaultField, string>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [f] of DEFAULT_FIELDS)
    out[f] = LIST_DEFAULTS.has(f)
      ? t[f]
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      : f === 'comp_expectation'
        ? compText(t[f])
        : t[f].trim();
  return out;
}

/** A comp expectation typed as a bare amount ("300k", "300,000k") is saved in full ("$300,000", #73); other text is kept. */
const compText = (t: string) => {
  const n = parseMoney(t);
  return n != null && n > 0 ? formatMoney(n, { full: true }) : t.trim();
};

/** Money fields in profile data (#73): shown through the shared formatter. */
const MONEY_KEY = /^comp_|salary|^base/;

/** A list item as a chip: text, or a role as "Company · Title". */
const itemLabel = (x: unknown): string | null => {
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    return typeof o.company === 'string' && typeof o.title === 'string' ? `${o.company} · ${o.title}` : null;
  }
  return String(x);
};

/** Flatten a component's data_json into short chip values. */
export function chipsOf(data: Record<string, unknown>): Array<{ label: string; value?: string }> {
  const out: Array<{ label: string; value?: string }> = [];
  for (const [key, v] of Object.entries(data)) {
    if (META_KEYS.has(key)) continue;
    const label = humanize(key);
    if (Array.isArray(v))
      for (const x of v) {
        const l = itemLabel(x);
        if (l) out.push({ label: l });
      }
    else if (typeof v === 'number') out.push({ label, value: MONEY_KEY.test(key) ? formatMoney(v) : v.toLocaleString('en-US') });
    else if (typeof v === 'boolean') out.push({ label, value: v ? 'Yes' : 'No' });
    else if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) out.push({ label: humanize(kk), value: String(vv) });
    else if (v != null) out.push({ label, value: String(v) });
  }
  return out;
}

/** Numeric fields become sliders in the side panel. */
export const numericFields = (data: Record<string, unknown>) =>
  Object.entries(data).filter((e): e is [string, number] => typeof e[1] === 'number');

/** Diff and component chips as short "Label value" strings (DiffBlock lines). */
export const chipText = (data: Record<string, unknown>) =>
  chipsOf(Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v !== 'number' || v >= 1000))).map((c) =>
    c.value ? `${c.label} ${c.value}` : c.label,
  );
