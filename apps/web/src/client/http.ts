import type { OpOutcome } from '@perfect-placement/contracts';
import type { AnyOpName, In, OpClient, Out } from './types';

/**
 * Live client for Wave 2: POST {base}/ops/{name} with the op input as JSON, expecting an
 * `OpOutcome` back. The route shape is a proposal (see CONTRACT_CHANGES.md, Lane D requests).
 */
export function createHttpClient(base = '/api', fetchImpl: typeof fetch = fetch): OpClient {
  return {
    async run<N extends AnyOpName>(name: N, input: In<N>): Promise<OpOutcome<Out<N>>> {
      try {
        const res = await fetchImpl(`${base}/ops/${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input ?? {}),
        });
        return (await res.json()) as OpOutcome<Out<N>>;
      } catch (e) {
        return { status: 'error', code: 'backend_unavailable', message: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
