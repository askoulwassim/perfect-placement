/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Fixtures index uses node:url for FIXTURE_VAULT_DIR; the browser (and jsdom tests) get a tiny shim.
const nodeUrlShim = fileURLToPath(new URL('./src/client/node-url-shim.ts', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { 'node:url': nodeUrlShim } },
  server: { port: 5178 },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
