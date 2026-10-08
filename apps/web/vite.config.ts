/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** `pp up` listens on 127.0.0.1:4317 by default; `PP_API_PORT` points the dev proxy elsewhere. */
const apiTarget = `http://127.0.0.1:${process.env.PP_API_PORT ?? '4317'}`;

export default defineConfig(({ mode }) => {
  const test = mode === 'test' || !!process.env.VITEST;
  return {
    plugins: [react()],
    resolve: {
      alias: [
        // OpenUI react-lang auto-mounts its Inspect devtools (fetched from a CDN) when NODE_ENV=development.
        { find: /^@openuidev\/devtools$/, replacement: here('./genui/src/devtools-stub.ts') },
        // Fixtures' index resolves FIXTURE_VAULT_DIR with node:url; only the browser mock needs the stand-in.
        // Tests run in Node and open a real fixture engine, so they keep the real module.
        ...(test ? [] : [{ find: /^node:url$/, replacement: here('./src/client/node-url-shim.ts') }]),
      ],
    },
    server: {
      port: 5178,
      // Same-origin `/api` in dev: Vite forwards to `pp up`.
      proxy: { '/api': { target: apiTarget } },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}', 'genui/src/**/*.test.{ts,tsx}'],
      testTimeout: 20_000,
      // Load fixtures' built JS in Node as is: Vite would rewrite its `new URL('../vault', import.meta.url)`
      // into an asset URL, and the fixture engine needs the real vault path.
      server: { deps: { external: [/packages\/fixtures\/dist\//] } },
    },
  };
});
