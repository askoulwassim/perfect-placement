import { OP_ERROR_CODES, type OpName, type OpOutcome } from '@perfect-placement/contracts';
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
 * not an outcome (network down, HTML 404, bad JSON) becomes `backend_unavailable`.
 */
export function createHttpClient(base: string = DEFAULT_API_BASE, fetchImpl: typeof fetch = (...a) => fetch(...a)): OpClient {
  const root = base.replace(/\/+$/, '');
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
  };
}
