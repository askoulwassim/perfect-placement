import { fileURLToPath } from 'node:url';

// The fixtures package entry resolves its vault path with node:url, which breaks in a DOM/browser env.
// Ask replies only need the synthetic rows, so point the import at the built data module.
export const fixturesAlias = {
  find: /^@perfect-placement\/fixtures$/,
  replacement: fileURLToPath(new URL('./node_modules/@perfect-placement/fixtures/dist/data.js', import.meta.url)),
};
