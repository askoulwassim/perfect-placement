import { existsSync, readdirSync } from 'node:fs';
import { db, ops } from '@perfect-placement/engine';
import type { Io } from '../io.js';

/** `pp init`: a new vault with the default config.json and a migrated pp.db. Refuses an existing one. */
export function init(home: string, io: Io): number {
  if (existsSync(home) && readdirSync(home).length > 0) {
    io.err(`pp init: ${home} already exists and is not empty; refusing to touch it`);
    return 1;
  }
  const git = db.findGitRoot(home);
  if (git) {
    io.err(`pp init: ${home} is inside the git repo ${git}; personal data must never live in a repo`);
    return 1;
  }
  ops.openEngine({ home, ...(io.services ? { services: io.services } : {}) }).close();
  io.out(`pp init: created ${home}`);
  return 0;
}
