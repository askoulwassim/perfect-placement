import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AutoGroupHints,
  Decision,
  DecisionSubjectRole,
  OpOutcome,
  PolicyConfig,
  QueuedDecision,
  RunOp,
} from '@perfect-placement/contracts';
import { backendsFromConfig, createDecisionOps, type DecisionStore } from '@perfect-placement/resolver';
import type { Db } from '../../db/connection.js';
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

/**
 * #103: the run a decision was made in (any event linked to it that carries `run_id`: its decision_made,
 * or the action it ran inside a skill run), and a roles.criterion group's score total from that scoring.
 */
function groupHints(h: HandlerContext): AutoGroupHints {
  const runQ = h.db.prepare(
    `SELECT json_extract(payload_json, '$.run_id') AS run_id FROM event WHERE decision_id = ? AND json_extract(payload_json, '$.run_id') IS NOT NULL ORDER BY ts, id LIMIT 1`,
  );
  const totalQ = h.db.prepare('SELECT total FROM score WHERE role_id = ? AND created_at >= ? ORDER BY created_at, rowid LIMIT 1');
  const runs = new Map<string, string | null>();
  return {
    runOf(d) {
      if (!runs.has(d.id)) {
        const r = runQ.get(d.id) as { run_id: unknown } | undefined;
        runs.set(d.id, typeof r?.run_id === 'string' && r.run_id ? r.run_id : null);
      }
      return runs.get(d.id) ?? null;
    },
    totalOf(g) {
      if (g.kind !== 'roles.criterion' || g.subject_type !== 'role' || !g.subject_id) return null;
      const r = totalQ.get(g.subject_id, g.first_ts) as { total: number } | undefined;
      return r ? r.total : null;
    },
  };
}

const ops = (h: HandlerContext) => createDecisionOps({ store: storeFor(h), runOp: h.runOp as RunOp, groupHints: groupHints(h) });

type RoleRow = { id: string; url: string | null; last_checked_at: string | null };

/** The last freshness check's evidence for a role, if any (#102). */
function lastCheckEvidence(h: HandlerContext, roleId: string): string | null {
  const row = h.db
    .prepare(
      `SELECT payload_json FROM event WHERE type = 'freshness_checked' AND subject_type = 'role' AND subject_id = ? ORDER BY ts DESC, id DESC LIMIT 1`,
    )
    .get(roleId) as { payload_json: string } | undefined;
  if (!row) return null;
  try {
    const ev = (JSON.parse(row.payload_json) as { evidence?: unknown }).evidence;
    return typeof ev === 'string' && ev ? ev : null;
  } catch {
    return null;
  }
}

/** A freshness.closed decision's own evidence (the resolver state it was asked with). */
function questionEvidence(d: Decision): string | null {
  if (d.kind !== 'freshness.closed') return null;
  const ev = (d.question_json as { state?: { evidence?: unknown } } | null)?.state?.evidence;
  return typeof ev === 'string' && ev ? ev : null;
}

/** #102: role decisions carry the role's url, last check and freshness evidence. */
function withSubjectRole(h: HandlerContext, list: Decision[]): QueuedDecision[] {
  const get = h.db.prepare('SELECT id, url, last_checked_at FROM role WHERE id = ?');
  const cache = new Map<string, RoleRow | null>();
  return list.map((d) => {
    if (d.subject_type !== 'role') return d;
    if (!cache.has(d.subject_id)) cache.set(d.subject_id, (get.get(d.subject_id) as RoleRow | undefined) ?? null);
    const r = cache.get(d.subject_id);
    if (!r) return d;
    const subject_role: DecisionSubjectRole = {
      id: r.id,
      url: r.url,
      last_checked_at: r.last_checked_at,
      freshness_evidence: questionEvidence(d) ?? lastCheckEvidence(h, r.id),
    };
    return { ...d, subject_role };
  });
}

export const decisionsQueue = defineHandler('decisions.queue', {
  async run(input, h) {
    const o = await ops(h)['decisions.queue'](input, h.ctx);
    if (o.status !== 'ok') return unwrap(o);
    return {
      pending: withSubjectRole(h, o.output.pending),
      recent_auto: withSubjectRole(h, o.output.recent_auto),
      auto_groups: o.output.auto_groups,
    };
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

export const decisionsUndoGroup = defineHandler('decisions.undo_group', {
  async run(input, h) {
    return unwrap(await ops(h)['decisions.undo_group'](input, h.ctx));
  },
});

const MODE = { rule: 'local', kev: 'local', agent: 'session', jev: 'hosted', llm: 'hosted' } as const;
/** Above this a reachable backend reads as slow on the Settings card. */
const SLOW_MS = 1500;

/** How many recent agent samples the agent card's median covers (#100). */
export const AGENT_LATENCY_SAMPLES = 20;

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2);
};

/**
 * The agent session is not a network service, so its health has no latency (#100). Its card shows the
 * median of the last AGENT_LATENCY_SAMPLES measured agent durations: Ask turns (`ask_thread.turns_json[].ms`)
 * and agent-answered decisions with a measured `latency_ms`. 0 means not measured and is skipped; none: null.
 */
export function agentLatencyMs(db: Db, n = AGENT_LATENCY_SAMPLES): number | null {
  const decisions = db
    .prepare(
      `SELECT ts AS at, latency_ms AS ms FROM decision WHERE backend = 'agent' AND latency_ms > 0 ORDER BY ts DESC, rowid DESC LIMIT ?`,
    )
    .all(n) as Array<{ at: string; ms: number }>;
  const turns: Array<{ at: string; ms: number }> = [];
  const threads = db.prepare('SELECT updated_at, turns_json FROM ask_thread ORDER BY updated_at DESC LIMIT ?').all(n) as Array<{
    updated_at: string;
    turns_json: string;
  }>;
  for (const t of threads) {
    let list: unknown;
    try {
      list = JSON.parse(t.turns_json);
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    for (const x of [...list].reverse()) {
      const ms = (x as { ms?: unknown })?.ms;
      if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) turns.push({ at: t.updated_at, ms });
    }
  }
  const recent = [...decisions, ...turns].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, n);
  return median(recent.map((r) => r.ms));
}

/** Kev's install marker in PP_HOME (written by `pp kev install`). */
export const kevInstalledAt = (home: string) => existsSync(join(home, 'kev', 'installed.json'));

/**
 * Backend cards for Settings: rule, Kev and the agent session always; Jev and the API adapter only when enabled.
 * Kev that does not answer reads `not_installed` when PP_HOME has no Kev install (with `home`), else `down`.
 */
export async function backendStatus(config: PolicyConfig, services: EngineServices, home?: string, db?: Db) {
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
      // The agent session's health latency is meaningless (always 0): use measured agent durations (#100).
      const latencyMs = name === 'agent' ? (db ? agentLatencyMs(db) : null) : (health.latencyMs ?? null);
      const installed = name !== 'kev' || home === undefined || (services.kevInstalled ?? kevInstalledAt)(home);
      // A session turn is model think time, not a round trip: the agent never reads as slow.
      const slow = name !== 'agent' && latencyMs !== null && latencyMs > SLOW_MS;
      const status = !health.ok ? (installed ? 'down' : 'not_installed') : slow ? 'slow' : 'ok';
      return { name, mode: MODE[name], status, latencyMs } as const;
    }),
  );
}

export const systemBackends = defineHandler('system.backends', {
  async run(_input, h) {
    return { items: await backendStatus(h.config, h.services, h.home, h.db) };
  },
});

export const systemDoctor = defineHandler('system.doctor', {
  run(_input, h) {
    return doctor({ home: h.home, db: h.db });
  },
});
