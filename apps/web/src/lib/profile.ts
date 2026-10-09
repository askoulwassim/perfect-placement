import type { ProfileComponentKey } from '@perfect-placement/contracts';
import { humanize, k } from './format';

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

/** Provenance and links, not facts to show as chips (#38). */
const META_KEYS = new Set(['source_path', 'source_file', 'dictated', 'extracted_by', 'years_basis']);

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
    else if (typeof v === 'number') out.push({ label, value: v >= 1000 ? k(v) : String(v) });
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
