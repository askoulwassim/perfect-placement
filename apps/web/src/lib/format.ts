import type { Role } from '@perfect-placement/contracts';

export function ago(iso: string | null | undefined, now: Date): string {
  if (!iso) return '';
  const ms = now.getTime() - Date.parse(iso);
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export const k = (n: number) => `${Math.round(n / 1000)}k`;

export function compRange(role: Pick<Role, 'comp_min' | 'comp_max'>): string | null {
  if (role.comp_min == null && role.comp_max == null) return null;
  if (role.comp_min != null && role.comp_max != null) return `${k(role.comp_min)} to ${k(role.comp_max)}`;
  return k((role.comp_min ?? role.comp_max) as number);
}

export const humanize = (s: string) => {
  const t = s.replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export const fit = (total: number | null | undefined) => (total == null ? null : Math.round(total));
