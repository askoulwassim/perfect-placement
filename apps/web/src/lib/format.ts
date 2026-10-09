import { formatMoneyRange, type Role } from '@perfect-placement/contracts';

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

/** A role's comp range through the shared money formatter (#73): `$180k to $240k`. */
export const compRange = (role: Pick<Role, 'comp_min' | 'comp_max'> & { comp_currency?: string | null }): string | null =>
  formatMoneyRange(role.comp_min, role.comp_max, { currency: role.comp_currency });

export const humanize = (s: string) => {
  const t = s.replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export const fit = (total: number | null | undefined) => (total == null ? null : Math.round(total));
