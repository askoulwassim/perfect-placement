import type { Answer, AskRequest, BackendResult, DecisionBackend, Question } from '@perfect-placement/contracts';
import { BackendUnavailableError } from '../errors.js';

/*
 * System One HTTP adapter shared by Jev (TypeSafe, hosted) and Kev (local, open weights).
 * Both serve `POST /v1/systemone` with the same body; only the base URL, key and model differ.
 *
 * Wire shape, confirmed 2026-10-08 against:
 *  - TypeSafe API reference https://docs.typesafe.ai/api.md (Jev)
 *  - https://github.com/jaredpalmer/kev README (Kev)
 *
 * Request:  { state, model, questions: { <id>: { type: 'noul'|'choice'|'score', instructions, criteria? } } }
 *   noul criteria   optional { true: desc, false: desc }
 *   choice criteria required { <option>: desc | null }   (max 255 options)
 *   score criteria  required [ level desc, ... ]          (2..10 levels for Jev, lowest first)
 * Response: { model, answers: { <id>: { type, noul?, choice?, score?, probabilities?, confidence? } }, usage, latency_ms? }
 * Errors: 401 bad key, 422 malformed, 429 rate limit, 529 overloaded (retry 429/529 with backoff).
 *
 * The contract names the yes/no type `noulli`; the wire name is `noul`. The mapping lives here only.
 * System One models never write text: this adapter only sends typed questions and reads numbers back.
 */

export const JEV_DEFAULT_BASE_URL = 'https://api.typesafe.ai';
export const JEV_DEFAULT_MODEL = 'jev-latest';
export const KEV_DEFAULT_BASE_URL = 'http://127.0.0.1:8009';
export const KEV_DEFAULT_MODEL = 'kev-latest';
/** Jev accepts 2..10 score levels. Kev accepts more; we use the stricter bound so both backends see the same questions. */
export const MAX_SCORE_LEVELS = 10;

type WireQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };

export interface SystemOneRequest {
  state: string | Record<string, string>;
  model: string;
  questions: Record<string, WireQuestion>;
}

export interface SystemOneWireAnswer {
  type: 'noul' | 'choice' | 'score';
  noul?: number;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
  legend?: Record<string, string>;
}

export interface SystemOneResponse {
  model?: string;
  answers: Record<string, SystemOneWireAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
  latency_ms?: number;
}

/** An Answer plus what the backend returned, kept in `decision.answer_json` for calibration work. */
export type RichAnswer = Answer & { raw?: unknown };

function scoreLevels(q: Extract<Question, { type: 'score' }>): number[] {
  const lo = Math.ceil(q.min);
  const hi = Math.floor(q.max);
  const levels: number[] = [];
  for (let v = lo; v <= hi; v++) levels.push(v);
  return levels;
}

const humanize = (option: string): string => option.replace(/[_-]+/g, ' ');

export function toWireQuestion(q: Question, backend: 'jev' | 'kev'): WireQuestion {
  switch (q.type) {
    case 'noulli':
      return { type: 'noul', instructions: q.instructions };
    case 'choice':
      return { type: 'choice', instructions: q.instructions, criteria: Object.fromEntries(q.options.map((o) => [o, humanize(o)])) };
    case 'score': {
      const levels = scoreLevels(q);
      if (levels.length < 2 || levels.length > MAX_SCORE_LEVELS) {
        throw new BackendUnavailableError(backend, `score question '${q.id}' needs 2..${MAX_SCORE_LEVELS} integer levels`);
      }
      return { type: 'score', instructions: q.instructions, criteria: levels.map(String) };
    }
  }
}

export function toSystemOneRequest(req: AskRequest, model: string, backend: 'jev' | 'kev'): SystemOneRequest {
  return {
    state: req.state,
    model,
    questions: Object.fromEntries(req.questions.map((q) => [q.id, toWireQuestion(q, backend)])),
  };
}

function argmax(probs: Record<string, number>): [string, number] | undefined {
  let best: [string, number] | undefined;
  for (const [k, v] of Object.entries(probs)) if (!best || v > best[1]) best = [k, v];
  return best;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

export function fromWireAnswer(q: Question, a: SystemOneWireAnswer | undefined, backend: 'jev' | 'kev'): RichAnswer {
  if (!a) throw new BackendUnavailableError(backend, `no answer for '${q.id}'`);
  switch (q.type) {
    case 'noulli': {
      if (typeof a.noul !== 'number') throw new BackendUnavailableError(backend, `'${q.id}' missing noul`);
      const yes = a.noul >= 0.5;
      return { id: q.id, value: yes, p: clamp01(yes ? a.noul : 1 - a.noul), raw: a };
    }
    case 'choice': {
      if (typeof a.choice !== 'string' || !q.options.includes(a.choice)) {
        throw new BackendUnavailableError(backend, `'${q.id}' choice not in options`);
      }
      const p = a.probabilities?.[a.choice] ?? a.confidence;
      if (typeof p !== 'number') throw new BackendUnavailableError(backend, `'${q.id}' missing probability`);
      return { id: q.id, value: a.choice, p: clamp01(p), raw: a };
    }
    case 'score': {
      const levels = scoreLevels(q);
      // Probabilities are keyed by level index ("0".."n-1"). Prefer the argmax level; fall back to the rounded score.
      const best = a.probabilities ? argmax(a.probabilities) : undefined;
      let idx: number;
      let p: number | undefined;
      if (best) {
        idx = Number(best[0]);
        p = best[1];
      } else if (typeof a.score === 'number') {
        idx = Math.round(a.score);
        p = a.confidence;
      } else {
        throw new BackendUnavailableError(backend, `'${q.id}' missing score`);
      }
      const value = levels[Math.min(levels.length - 1, Math.max(0, idx))];
      if (value === undefined || typeof p !== 'number') throw new BackendUnavailableError(backend, `'${q.id}' bad score answer`);
      return { id: q.id, value, p: clamp01(p), raw: a };
    }
  }
}

export interface SystemOneOptions {
  name: 'jev' | 'kev';
  baseUrl: string;
  apiKey?: string;
  model: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Retries on 429 / 529 / 503. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

const RETRYABLE = new Set([429, 503, 529]);

export function createSystemOneBackend(opts: SystemOneOptions): DecisionBackend {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const retries = opts.retries ?? 2;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = opts.clock ?? Date.now;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

  async function post(body: SystemOneRequest): Promise<SystemOneResponse> {
    let lastErr: BackendUnavailableError | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(250 * 2 ** (attempt - 1));
      let res: Response;
      try {
        res = await doFetch(`${base}/v1/systemone`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        lastErr = new BackendUnavailableError(opts.name, 'unreachable', { cause, retryable: false });
        break; // network failure: fall back now, don't burn the latency budget on retries
      }
      if (res.ok) {
        const json = (await res.json()) as SystemOneResponse;
        if (!json || typeof json !== 'object' || !json.answers) throw new BackendUnavailableError(opts.name, 'malformed response');
        return json;
      }
      lastErr = new BackendUnavailableError(opts.name, `HTTP ${res.status}`, { status: res.status, retryable: RETRYABLE.has(res.status) });
      if (!lastErr.retryable) break;
    }
    throw lastErr ?? new BackendUnavailableError(opts.name, 'unknown error');
  }

  return {
    name: opts.name,
    async ask(req: AskRequest): Promise<BackendResult> {
      const started = clock();
      const body = toSystemOneRequest(req, opts.model, opts.name);
      const res = await post(body);
      const answers = req.questions.map((q) => fromWireAnswer(q, res.answers[q.id], opts.name));
      return { answers, latencyMs: Math.max(0, clock() - started) };
    },
    async health() {
      const started = clock();
      try {
        const res = await doFetch(`${base}/v1/models`, { headers, signal: AbortSignal.timeout(Math.min(timeoutMs, 3000)) });
        // Kev may not serve /v1/models; any non-auth, non-5xx answer means the server is up.
        return { ok: res.status < 500 && res.status !== 401 && res.status !== 403, latencyMs: clock() - started };
      } catch {
        return { ok: false };
      }
    },
  };
}

export function createJevBackend(o: Omit<SystemOneOptions, 'name' | 'baseUrl' | 'model'> & { baseUrl?: string; model?: string }) {
  return createSystemOneBackend({ ...o, name: 'jev', baseUrl: o.baseUrl || JEV_DEFAULT_BASE_URL, model: o.model ?? JEV_DEFAULT_MODEL });
}

export function createKevBackend(o: Omit<SystemOneOptions, 'name' | 'baseUrl' | 'model'> & { baseUrl?: string; model?: string }) {
  return createSystemOneBackend({ ...o, name: 'kev', baseUrl: o.baseUrl || KEV_DEFAULT_BASE_URL, model: o.model ?? KEV_DEFAULT_MODEL });
}
