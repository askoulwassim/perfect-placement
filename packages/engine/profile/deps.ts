import type {
  Actor,
  AskFn,
  EventType,
  ID_PREFIX,
  PolicyConfig,
  ProfileComponentKey,
  RunOp,
  SubjectType,
} from '@perfect-placement/contracts';
import { ulid } from '../db/ids.js';
import type { Repos } from '../db/repo.js';
import type { ResumeDraft } from './resume.js';

/*
 * Injected dependencies for lane E handlers. The engine builds them per op call
 * (packages/engine/ops/lanes/profile.ts):
 *  - `repos`  : lane A repositories (the only db access).
 *  - `emit`   : runOp's event writer.
 *  - `ask`    : this op's resolver (lane I): rule -> Kev -> agent -> human.
 *  - `vault`  : runOp's staged vault (flushed after commit).
 *  - `runOp`  : nested ops (the learn loop proposes, applies and rejects diffs through ops).
 *  - `llm`    : optional writing model; absent by default (the agent session drafts).
 *  - `onboardStore`: the `onboard_session` table.
 */

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

/** Staged vault access (runOp's VaultTx): writes land only when the op commits. */
export interface ProfileVault {
  read(rel: string): string | null;
  write(rel: string, content: string): void;
  /** Binary files (a kept resume upload, #38). */
  writeBytes?(rel: string, content: Uint8Array): void;
  readBytes?(rel: string): Uint8Array | null;
}

export interface ProfileDeps {
  repos: Repos;
  emit: EmitFn;
  /** Resolver (lane I). Required by the learn loop and by policy routing of apply_diff. */
  ask?: AskFn;
  llm?: ProfileLlm;
  config?: PolicyConfig;
  /** When set, Story/Voice markdown is written and file_path inputs resolve. */
  vault?: ProfileVault;
  onboardStore: import('./onboard-store.js').OnboardStore;
  /** Rescore hook (lane F). Default: return the affected role ids without rescoring. */
  rescore?: (roleIds: string[], versionId: string) => Promise<string[]>;
  /** Calibration sample source. Default: up to 12 scored roles from the db. */
  calibrationSamples?: () => import('./calibration.js').CalibrationSample[];
  /** Nested ops (the learn loop runs propose / apply / reject as ops). */
  runOp?: RunOp;
}

/** `<prefix>_<ulid>` with lane A's ULID. */
export function newId(prefix: (typeof ID_PREFIX)[keyof typeof ID_PREFIX], now: Date): string {
  return `${prefix}_${ulid(now.getTime())}`;
}
