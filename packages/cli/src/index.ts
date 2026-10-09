#!/usr/bin/env node
// `pp` CLI (lane B; commands/doctor.ts: lane A). Thin: every command calls ops.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCli } from './cli.js';

export { COMMANDS, runCli } from './cli.js';
export { checkKev, DEFAULT_PORT, httpStatusOf, type Running, type UpOptions, up } from './commands/up.js';

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(e);
      process.exitCode = 1;
    },
  );
}
