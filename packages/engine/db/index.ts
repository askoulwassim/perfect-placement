import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Lane A owns this folder. Wave 0 stub: migration discovery only; lane A writes the runner and repositories.

/** Absolute path to the numbered SQL migrations (works from src and dist). */
export const MIGRATIONS_DIR = fileURLToPath(
  new URL(import.meta.url.includes('/dist/') ? '../../db/migrations/' : './migrations/', import.meta.url),
);

/** Migration files in apply order. */
export function listMigrations(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort();
}
