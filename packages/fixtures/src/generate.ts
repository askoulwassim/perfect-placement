// Writes seed/seed.sql and vault/** from src/data.ts. Run: pnpm --filter @perfect-placement/fixtures gen
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FIXTURE_SEED_SQL, FIXTURE_VAULT_DIR } from './index.js';
import { toSeedSql } from './sql.js';
import { vaultFiles } from './vault.js';

mkdirSync(dirname(FIXTURE_SEED_SQL), { recursive: true });
writeFileSync(FIXTURE_SEED_SQL, toSeedSql());
rmSync(FIXTURE_VAULT_DIR, { recursive: true, force: true });
for (const [rel, content] of vaultFiles()) {
  const abs = join(FIXTURE_VAULT_DIR, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
console.log(`fixtures: wrote seed + ${vaultFiles().size} vault files`);
