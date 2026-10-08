import { randomBytes } from 'node:crypto';
import type { Actor, AskFn, EventType, ID_PREFIX, PolicyConfig, ProfileComponentKey, SubjectType } from '@perfect-placement/contracts';
import type Database from 'better-sqlite3';
import type { ResumeDraft } from './resume.js';

/*
 * Injected dependencies for lane E handlers.
 *
 * WAVE 2 SHIMS: lanes A (db repositories), B (runOp + event writer) and I (resolver)
 * are not merged. Everything here is an interface so Wave 2 can swap in the real
 * pieces without touching handler logic:
 *  - `db`      : raw better-sqlite3 handle. Wave 2: lane A repositories.
 *  - `emit`    : event writer. Wave 2: lane B's event writer inside runOp.
 *  - `ask`     : resolver.ask (lane I).
 *  - `attachAction`: sets decision.action_json (needs AskRequest.action, see CONTRACT_CHANGES).
 *  - `llm`     : writing/extraction model (never a System One model).
 *  - `onboardStore`: onboarding session storage (no table in migration 001).
 */

export type Db = Database.Database;

export interface EventDraft {
  type: EventType;
  subject_type: SubjectType;
  subject_id: string;
  payload: Record<string, unknown>;
  actor: Actor;
  decision_id?: string | null;
}

/** Writes one event row, returns its id. */
export type EmitFn = (ev: EventDraft, now: Date) => string;

/** LLM interface (writing + extraction). Implementations: Anthropic in Wave 2, fakes in tests. */
export interface ProfileLlm {
  /** Parse resume text into Story + Craft drafts. Optional: a heuristic parser is the fallback. */
  parseResume?(text: string): Promise<ResumeDraft>;
  /**
   * Draft a diff to one component from a learning event. Returns null when, on reflection,
   * nothing should change. `after` holds only changed keys; `before` the same keys' current values.
   */
  draftDiff(req: {
    component: ProfileComponentKey;
    data: Record<string, unknown>;
    event: { id: string; type: string; subject_type: string; subject_id: string; payload: Record<string, unknown> };
    context: string;
  }): Promise<{ before: Record<string, unknown>; after: Record<string, unknown>; evidence: string[] } | null>;
}

export interface ProfileDeps {
  db: Db;
  emit: EmitFn;
  /** Resolver (lane I). Required by the learn loop and by policy routing of apply_diff. */
  ask?: AskFn;
  /** Wave 2: replaced by AskRequest.action (CONTRACT_CHANGES, lane E). */
  attachAction?: (decisionId: string, action: { op: string; input: Record<string, unknown> }) => void;
  llm?: ProfileLlm;
  config?: PolicyConfig;
  /** Absolute vault root (PP_HOME). When set, Story/Voice markdown is written and file_path inputs resolve. */
  vaultDir?: string;
  onboardStore?: import('./onboard-store.js').OnboardStore;
  /** Rescore hook (lane F). Default: return the affected role ids without rescoring. */
  rescore?: (roleIds: string[], versionId: string) => Promise<string[]>;
  /** Calibration sample source. Default: up to 12 scored roles from the db. */
  calibrationSamples?: () => import('./calibration.js').CalibrationSample[];
}

// ---------------------------------------------------------------------------
// Ids (SHIM: lane A owns id generation; same `<prefix>_<ulid>` format).
// ---------------------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastMs = -1;
let lastRand: number[] = [];

/** ULID (monotonic within the same ms). */
export function ulid(now: Date = new Date()): string {
  const ms = now.getTime();
  let rand: number[];
  if (ms === lastMs) {
    rand = [...lastRand];
    for (let i = rand.length - 1; i >= 0; i--) {
      const v = (rand[i] ?? 0) + 1;
      if (v < 32) {
        rand[i] = v;
        break;
      }
      rand[i] = 0;
    }
  } else {
    rand = [...randomBytes(16)].map((b) => b % 32);
  }
  lastMs = ms;
  lastRand = rand;
  let time = '';
  let t = ms;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + rand.map((r) => CROCKFORD[r]).join('');
}

export function newId(prefix: (typeof ID_PREFIX)[keyof typeof ID_PREFIX], now: Date): string {
  return `${prefix}_${ulid(now)}`;
}

// ---------------------------------------------------------------------------
// Event writer SHIM (Wave 2: lane B writes events inside runOp).
// ---------------------------------------------------------------------------

export function createDbEmitter(db: Db): EmitFn {
  const stmt = db.prepare(
    'INSERT INTO event (id, ts, type, subject_type, subject_id, payload_json, actor, decision_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  return (ev, now) => {
    const id = newId('ev', now);
    stmt.run(id, now.toISOString(), ev.type, ev.subject_type, ev.subject_id, JSON.stringify(ev.payload), ev.actor, ev.decision_id ?? null);
    return id;
  };
}
