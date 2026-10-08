/*
 * The engine behind the MCP server (and `pp up`). Default: the real engine on PP_HOME.
 * `openFixtureDemo()` copies the synthetic fixture vault into a fresh temp dir (lane A's
 * `loadSeededVault`: migrations + seed) and opens the same real engine on it, offline: no
 * network, LinkedIn in dry-run (set through `config.update`), no runner spawn. Surfaces never
 * write files themselves (engine guard test), so the temp vault is left in the OS temp dir.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, type EngineServices, openEngine } from '@perfect-placement/engine';
import { FIXTURE_SEED_SQL, FIXTURE_VAULT_DIR } from '@perfect-placement/fixtures';

export type OpenedEngine = ReturnType<typeof openEngine>;

export interface FixtureDemo {
  engine: OpenedEngine;
  home: string;
  /** Close the engine. The temp vault stays in the OS temp dir for inspection. */
  close(): void;
}

/** Offline services for the demo: every outside call fails fast and nothing is spawned. */
export function offlineServices(): EngineServices {
  return {
    fetch: (async (url: string) => {
      throw new Error(`network disabled in the fixtures demo: ${url}`);
    }) as unknown as NonNullable<EngineServices['fetch']>,
    launcher: {
      async launch() {
        throw new Error('headless runner disabled in the fixtures demo');
      },
    },
    freshnessDelayMs: 0,
    env: {},
  };
}

/** A temp copy of the synthetic fixture vault with migrations and the seed applied, opened on the real engine. */
export async function openFixtureDemo(opts: { services?: EngineServices; parent?: string } = {}): Promise<FixtureDemo> {
  const home = join(mkdtempSync(join(opts.parent ?? tmpdir(), 'pp-fixtures-')), 'vault');
  db.loadSeededVault(home, { vaultDir: FIXTURE_VAULT_DIR, seedSql: FIXTURE_SEED_SQL }).close();
  const engine = openEngine({ home, services: { ...offlineServices(), ...(opts.services ?? {}) } });
  const set = await engine.runOp('config.update', { patch: { linkedin: { mode: 'dry-run' } } }, { actor: 'human', now: () => new Date() });
  if (set.status !== 'ok') {
    engine.close();
    throw new Error(`fixtures demo: could not set linkedin dry-run (${set.status === 'error' ? set.message : set.status})`);
  }
  return { engine, home, close: () => engine.close() };
}
