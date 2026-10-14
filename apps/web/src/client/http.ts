import {
  type AskChatEvent,
  type AskChatRequest,
  OP_ERROR_CODES,
  type OpName,
  type OpOutcome,
  parseAskChatFrames,
  trimTrailingSlashes,
} from '@perfect-placement/contracts';
import type { In, OpClient, Out } from './types';

/** Same origin as the UI when `pp up` serves it. `VITE_PP_API` overrides (README). */
export const DEFAULT_API_BASE = '/api';

const isOutcome = (v: unknown): v is OpOutcome<unknown> => {
  if (!v || typeof v !== 'object') return false;
  const o = v as { status?: unknown; code?: unknown; decisionId?: unknown };
  if (o.status === 'ok') return 'output' in o;
  if (o.status === 'requires_human') return typeof o.decisionId === 'string';
  return o.status === 'error' && (OP_ERROR_CODES as readonly unknown[]).includes(o.code);
};

/**
 * Live client: `POST {base}/ops/{name}` with the op input as the JSON body; the reply is an
 * `OpOutcome` whatever the HTTP status (`pp up` maps codes to 202 / 4xx / 5xx). Anything that is
 * not an outcome (network down, HTML 404, bad JSON) becomes `backend_unavailable`. `ask` streams Ask turns (#39).
 */
export function createHttpClient(base: string = DEFAULT_API_BASE, fetchImpl: typeof fetch = (...a) => fetch(...a)): OpClient {
  const root = trimTrailingSlashes(base);
  return {
    async run<N extends OpName>(name: N, input: In<N>): Promise<OpOutcome<Out<N>>> {
      const down = (message: string): OpOutcome<Out<N>> => ({ status: 'error', code: 'backend_unavailable', message });
      let res: Response;
      try {
        res = await fetchImpl(`${root}/ops/${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(input ?? {}),
        });
      } catch (e) {
        return down(e instanceof Error ? e.message : String(e));
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return down(`${name}: HTTP ${res.status}`);
      }
      return isOutcome(body) ? (body as OpOutcome<Out<N>>) : down(`${name}: HTTP ${res.status}`);
    },
    fileUrl: (path: string) => `${root}/files?path=${encodeURIComponent(path)}`,
    /** `POST {base}/ask`, read as Server-Sent Events. Network or HTTP failures become an `unavailable` error event. */
    async *ask(req: AskChatRequest, signal?: AbortSignal): AsyncGenerator<AskChatEvent> {
      const down = (message: string): AskChatEvent => ({ type: 'error', code: 'unavailable', message });
      let res: Response;
      try {
        res = await fetchImpl(`${root}/ask`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify(req),
          ...(signal ? { signal } : {}),
        });
      } catch (e) {
        if (!signal?.aborted) yield down(e instanceof Error ? e.message : String(e));
        return;
      }
      if (!res.ok || !res.body || !(res.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
        yield down(`Ask: HTTP ${res.status}`);
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const { events, rest } = parseAskChatFrames(buf);
          buf = rest;
          yield* events;
        }
      } catch (e) {
        if (!signal?.aborted) yield down(e instanceof Error ? e.message : String(e));
        return;
      }
      if (buf.trim()) yield* parseAskChatFrames(`${buf}\n\n`).events;
    },
  };
}
