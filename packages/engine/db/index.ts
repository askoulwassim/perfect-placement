// Lane A: data layer. Migrations runner, typed repositories, vault helpers, system.doctor, v1 importer.
import { cpSync, readFileSync } from 'node:fs';
import { type Db, openDb } from './connection.js';
import { dbPath } from './vault.js';

export { appliedVersions, applyMigrations, type Db, listMigrations, MIGRATIONS_DIR, type OpenDbOptions, openDb } from './connection.js';
export { countsByStatus, type DoctorOptions, type DoctorResult, doctor, referencedPaths } from './doctor.js';
export { type IdTable, newId, nowIso, roleId, slugify, ulid } from './ids.js';
export { dehydrate, hydrate, Repo, type Repos, type Row, repos, type Where } from './repo.js';
export {
  type ApplyResult,
  applyPlan,
  type MigrateV1Options,
  type MigrateV1Report,
  migrateV1,
  type PlannedFile,
  planV1Import,
  type V1Plan,
} from './v1/import.js';
export {
  configPath,
  dbPath,
  findClaudeMdInParents,
  findGitRoot,
  initVault,
  type MdDoc,
  parseMd,
  readConfig,
  readMd,
  renderMd,
  resolvePpHome,
  toVaultRel,
  vaultAbs,
  writeMd,
} from './vault.js';

/** Copy a vault dir to `home`, open + migrate its db, then apply seed SQL (used with @perfect-placement/fixtures). */
export function loadSeededVault(home: string, opts: { vaultDir: string; seedSql: string }): Db {
  cpSync(opts.vaultDir, home, { recursive: true });
  const db = openDb(dbPath(home));
  db.exec(readFileSync(opts.seedSql, 'utf8'));
  return db;
}
