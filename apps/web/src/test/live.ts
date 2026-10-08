import type { Actor, OpOutcome } from '@perfect-placement/contracts';
import { type FixtureEngine, type FixtureOptions, openFixtureEngine, tickingClock } from '@perfect-placement/engine/testing';
import { FIXTURE_NOW } from '@perfect-placement/fixtures';
import { createHttpClient } from '../client/http';
import type { OpClient } from '../client/types';

/*
 * Test harness for the live client: a fake `fetch` that serves `POST /api/ops/:name` the way
 * `pp up` does (JSON body = op input, actor human, reply = OpOutcome) from a real engine over a
 * temp copy of the synthetic fixture vault. No sockets, no network, no real PP_HOME.
 */

const STATUS: Record<string, number> = { invalid_input: 400, not_found: 404, conflict: 409, forbidden_transition: 409, human_only: 403 };
const httpStatus = (o: OpOutcome<unknown>) => (o.status === 'ok' ? 200 : o.status === 'requires_human' ? 202 : (STATUS[o.code] ?? 500));

export interface FetchCall {
  url: string;
  name: string;
  body: unknown;
  status: OpOutcome<unknown>['status'];
}

export interface Live {
  engine: FixtureEngine;
  fetch: typeof fetch;
  client: OpClient;
  calls: FetchCall[];
  /** Run an op as another actor (the agent finishing a run, a schedule), bypassing HTTP. */
  as(actor: Actor, name: string, input: unknown): Promise<OpOutcome<unknown>>;
  now: () => Date;
  close(): void;
}

/** Gmail double: records drafts, never sends (the engine only ever creates drafts). */
const gmailDouble = () => {
  let n = 0;
  return { mode: 'dry-run' as const, createDraft: async () => ({ draftId: `dryrun-${++n}` }) };
};

export function openLive(opts: FixtureOptions = {}): Live {
  const engine = openFixtureEngine({ ...opts, services: { gmail: gmailDouble(), ...(opts.services ?? {}) } });
  const clock = tickingClock(FIXTURE_NOW);
  const calls: FetchCall[] = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const m = /\/api\/ops\/([^/?#]+)$/.exec(url);
    if (!m || init?.method !== 'POST')
      return new Response('<!doctype html>not found', { status: 404, headers: { 'content-type': 'text/html' } });
    const name = decodeURIComponent(m[1] as string);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const outcome = await engine.runOp(name, body, { actor: 'human', now: clock });
    calls.push({ url, name, body, status: outcome.status });
    return new Response(JSON.stringify(outcome), { status: httpStatus(outcome), headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return {
    engine,
    fetch: fake,
    client: createHttpClient('/api', fake),
    calls,
    as: (actor, name, input) => engine.runOp(name, input, { actor, now: clock }),
    now: () => new Date(FIXTURE_NOW),
    close: () => engine.cleanup(),
  };
}
