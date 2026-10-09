import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { OpOutcome, PolicyConfig, RunOp } from '@perfect-placement/contracts';
import { backendsFromConfig, createDecisionOps, type DecisionStore } from '@perfect-placement/resolver';
import { doctor } from '../../db/doctor.js';
import { createDecisionStore } from '../decision-store.js';
import { OpError } from '../errors.js';
import { defineHandler, type HandlerContext, requiresHuman } from '../runtime.js';
import type { EngineServices } from '../services.js';

/*
 * Lane I wiring: decisions.queue / resolve / undo over lane A's DecisionStore, with lane I's events
 * written through runOp's emitter and every action executed through `runOp` (nested in this op).
 * Plus system.backends (lane I) and system.doctor (lane A).
 */

/** The decision store for an op: lane A repos, decision events through `h.emit`. */
function storeFor(h: HandlerContext): DecisionStore {
  const base = createDecisionStore(h.db);
  return { ...base, appendEvent: (e) => void h.emit(e.type, e.subject_type, e.subject_id, e.payload_json, e.decision_id) };
}

function unwrap<O>(o: OpOutcome<O>) {
  if (o.status === 'ok') return o.output;
  if (o.status === 'requires_human') return requiresHuman(o.decisionId);
  throw new OpError(o.code, o.message, o.issues);
}

const ops = (h: HandlerContext) => createDecisionOps({ store: storeFor(h), runOp: h.runOp as RunOp });

export const decisionsQueue = defineHandler('decisions.queue', {
  async run(input, h) {
    return unwrap(await ops(h)['decisions.queue'](input, h.ctx));
  },
});

export const decisionsResolve = defineHandler('decisions.resolve', {
  async run(input, h) {
    return unwrap(await ops(h)['decisions.resolve'](input, h.ctx));
  },
});

export const decisionsUndo = defineHandler('decisions.undo', {
  async run(input, h) {
    return unwrap(await ops(h)['decisions.undo'](input, h.ctx));
  },
});

const MODE = { rule: 'local', kev: 'local', agent: 'session', jev: 'hosted', llm: 'hosted' } as const;
/** Above this a reachable backend reads as slow on the Settings card. */
const SLOW_MS = 1500;

/** Kev's install marker in PP_HOME (written by `pp kev install`). */
export const kevInstalledAt = (home: string) => existsSync(join(home, 'kev', 'installed.json'));

/**
 * Backend cards for Settings: rule, Kev and the agent session always; Jev and the API adapter only when enabled.
 * Kev that does not answer reads `not_installed` when PP_HOME has no Kev install (with `home`), else `down`.
 */
export async function backendStatus(config: PolicyConfig, services: EngineServices, home?: string) {
  const map = {
    ...backendsFromConfig(config, { ...(services.env ? { env: services.env } : {}), agent: {} }),
    ...(services.backends ?? {}),
  };
  const names = (['rule', 'kev', 'agent', 'jev', 'llm'] as const).filter((n) => map[n]);
  return Promise.all(
    names.map(async (name) => {
      const b = map[name];
      let health: { ok: boolean; latencyMs?: number } = { ok: false };
      try {
        health = b ? await b.health() : { ok: false };
      } catch {
        health = { ok: false };
      }
      const latencyMs = health.latencyMs ?? null;
      const installed = name !== 'kev' || home === undefined || (services.kevInstalled ?? kevInstalledAt)(home);
      const status = !health.ok ? (installed ? 'down' : 'not_installed') : latencyMs !== null && latencyMs > SLOW_MS ? 'slow' : 'ok';
      return { name, mode: MODE[name], status, latencyMs } as const;
    }),
  );
}

export const systemBackends = defineHandler('system.backends', {
  async run(_input, h) {
    return { items: await backendStatus(h.config, h.services, h.home) };
  },
});

export const systemDoctor = defineHandler('system.doctor', {
  run(_input, h) {
    return doctor({ home: h.home, db: h.db });
  },
});
