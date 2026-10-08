import { defineConfig } from 'vite';
import { fixturesAlias } from './fixtures-alias.js';

// Demo only: `pnpm demo` serves demo/index.html with the Ask panel on fixtures.
export default defineConfig({
  root: 'demo',
  resolve: { alias: [fixturesAlias] },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
});
