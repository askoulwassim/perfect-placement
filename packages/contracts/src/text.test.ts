import { describe, expect, it } from 'vitest';
import { trimTrailingSlashes } from './text.js';

describe('trimTrailingSlashes (#152)', () => {
  it('drops every trailing slash and nothing else', () => {
    expect(trimTrailingSlashes('http://127.0.0.1:5177/api///')).toBe('http://127.0.0.1:5177/api');
    expect(trimTrailingSlashes('/api')).toBe('/api');
    expect(trimTrailingSlashes('///')).toBe('');
    expect(trimTrailingSlashes('')).toBe('');
  });

  it('stays linear on a long run of slashes', () => {
    const s = `${'/'.repeat(100_000)}x`;
    const started = performance.now();
    expect(trimTrailingSlashes(s)).toBe(s);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
