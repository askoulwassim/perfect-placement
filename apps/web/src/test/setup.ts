import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Schedules are local wall-clock times (#29): pin the zone so next-run labels are deterministic.
process.env.TZ = 'UTC';

afterEach(() => {
  cleanup();
  window.location.hash = '';
  try {
    window.localStorage.clear();
  } catch {
    // no storage in this environment
  }
});

if (!window.matchMedia)
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

window.open = vi.fn() as unknown as typeof window.open;
