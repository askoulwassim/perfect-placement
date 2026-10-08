#!/usr/bin/env node
// Lane B owns this package (except commands/migrate.ts and commands/doctor.ts: lane A). Wave 0 stub.
const [cmd] = process.argv.slice(2);
const COMMANDS = ['up', 'migrate', 'doctor', 'scout', 'score', 'fresh', 'inbox'] as const;

if (!cmd || !COMMANDS.includes(cmd as (typeof COMMANDS)[number])) {
  console.log(`pp <${COMMANDS.join('|')}>`);
  process.exitCode = cmd ? 1 : 0;
} else {
  console.error(`pp ${cmd}: not implemented yet`);
  process.exitCode = 1;
}
