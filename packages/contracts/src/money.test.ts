import { describe, expect, it } from 'vitest';
import { formatMoney, formatMoneyRange, parseMoney } from './money.js';

describe('formatMoney (#73)', () => {
  it('compact: one decimal at most, never a k after a full number', () => {
    expect(formatMoney(212500)).toBe('$212.5k');
    expect(formatMoney(300000)).toBe('$300k');
    expect(formatMoney(180000)).toBe('$180k');
    expect(formatMoney(950)).toBe('$950');
    expect(formatMoney(1_200_000)).toBe('$1.2M');
    expect(formatMoney(999_999)).toBe('$1M');
    for (const n of [1000, 12345, 212500, 300000, 999_499, 2_500_000]) expect(formatMoney(n)).not.toMatch(/\d,\d{3}k/i);
  });
  it('full and currencies', () => {
    expect(formatMoney(300000, { full: true })).toBe('$300,000');
    expect(formatMoney(212500, { full: true, currency: 'GBP' })).toBe('£212,500');
    expect(formatMoney(300000, { currency: 'CAD' })).toBe('300k CAD');
    expect(formatMoney(300000, { full: true, currency: 'CAD' })).toBe('300,000 CAD');
  });
  it('ranges', () => {
    expect(formatMoneyRange(180000, 240000)).toBe('$180k to $240k');
    expect(formatMoneyRange(180000, null)).toBe('$180k+');
    expect(formatMoneyRange(null, 240000)).toBe('up to $240k');
    expect(formatMoneyRange(null, null)).toBeNull();
  });
});

describe('parseMoney (#73)', () => {
  it('reads what people type', () => {
    expect(parseMoney('212500')).toBe(212500);
    expect(parseMoney('$212,500')).toBe(212500);
    expect(parseMoney('212.5k')).toBe(212500);
    expect(parseMoney('300K')).toBe(300000);
    expect(parseMoney('1.2M')).toBe(1_200_000);
    expect(parseMoney('300,000k')).toBe(300000);
    expect(parseMoney('$300,000 USD')).toBe(300000);
    expect(parseMoney('open to discuss')).toBeNull();
    expect(parseMoney('')).toBeNull();
  });
});
