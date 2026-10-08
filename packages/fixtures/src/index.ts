import { fileURLToPath } from 'node:url';

export * from './data.js';
export { toSeedSql } from './sql.js';
export { vaultFiles } from './vault.js';

/** Absolute path of the committed synthetic vault (use as PP_HOME in tests after copying to a temp dir). */
export const FIXTURE_VAULT_DIR = fileURLToPath(new URL('../vault', import.meta.url));
/** Absolute path of the committed seed SQL. Apply after engine migrations. */
export const FIXTURE_SEED_SQL = fileURLToPath(new URL('../seed/seed.sql', import.meta.url));
