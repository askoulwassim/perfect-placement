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

/** Flatten a component's data_json into short chip values. */
export function chipsOf(data: Record<string, unknown>): Array<{ label: string; value?: string }> {
  const out: Array<{ label: string; value?: string }> = [];
  for (const [key, v] of Object.entries(data)) {
    const label = humanize(key);
    if (Array.isArray(v)) for (const x of v) out.push({ label: String(x) });
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
