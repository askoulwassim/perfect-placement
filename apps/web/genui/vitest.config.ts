import { defineConfig } from 'vitest/config';
import { fixturesAlias } from './fixtures-alias.js';

// Checks are named *.check.ts(x) so the parent apps/web vitest run (lane D) never picks them up.
export default defineConfig({
  resolve: { alias: [fixturesAlias] },
  test: {
    include: ['src/**/*.check.{ts,tsx}'],
    environment: 'happy-dom',
    testTimeout: 20_000,
  },
});
