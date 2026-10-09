/*
 * Money as shown everywhere (#73): one formatter for the engine and the web UI. No I/O.
 *
 * - compact (default): `$212.5k`, `$300k`, `$1.2M`, `$950`. The `k` stands for three zeros, so it is
 *   never put after a full number ("300,000k" is never produced).
 * - full: `$300,000`.
 * A currency other than USD / EUR / GBP is written after the number: `300k CAD`, `300,000 CAD`.
 */

const SYMBOL: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' };

export interface MoneyFormat {
  /** `$300,000` instead of `$300k`. */
  full?: boolean;
  /** ISO 4217 code; default USD. */
  currency?: string | null;
}

/** One decimal at most, trailing zero dropped: 212.5, 300, 1.2. */
const short = (n: number) => {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};

export function formatMoney(n: number, opts: MoneyFormat = {}): string {
  const cur = (opts.currency ?? 'USD').toUpperCase();
  const sym = SYMBOL[cur] ?? '';
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  let body: string;
  if (opts.full || a < 1000) body = Math.round(a).toLocaleString('en-US');
  else if (a < 999_950) body = `${short(a / 1000)}k`;
  else body = `${short(a / 1_000_000)}M`;
  return sym ? `${sign}${sym}${body}` : `${sign}${body} ${cur}`;
}

/** A range: `$180k to $240k`, `$180k+`, `up to $240k`; null when neither end is known. */
export function formatMoneyRange(min: number | null | undefined, max: number | null | undefined, opts: MoneyFormat = {}): string | null {
  const lo = typeof min === 'number' && min > 0 ? min : null;
  const hi = typeof max === 'number' && max > 0 ? max : null;
  if (lo != null && hi != null) return lo === hi ? formatMoney(lo, opts) : `${formatMoney(lo, opts)} to ${formatMoney(hi, opts)}`;
  if (lo != null) return `${formatMoney(lo, opts)}+`;
  if (hi != null) return `up to ${formatMoney(hi, opts)}`;
  return null;
}

/**
 * Typed money -> a number, or null. Accepts `212500`, `$212,500`, `212.5k`, `1.2M`. A `k` after a
 * number that is already in the thousands ("300,000k") is the mistake #73 fixed: it is ignored.
 */
export function parseMoney(text: string): number | null {
  const m = /^\s*[$€£]?\s*([0-9][0-9,]*(?:\.[0-9]+)?|\.[0-9]+)\s*([kKmM])?\s*(?:[A-Za-z]{3})?\s*$/.exec(text);
  if (!m) return null;
  const n = Number((m[1] ?? '').replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? '').toLowerCase();
  if (unit === 'm') return Math.round(n * 1_000_000);
  if (unit === 'k') return n >= 1000 ? Math.round(n) : Math.round(n * 1000);
  return Math.round(n);
}
