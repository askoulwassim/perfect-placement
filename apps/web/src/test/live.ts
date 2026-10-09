import { type Actor, askChatFrame, type OpContext, type OpOutcome, type RunnerConfig } from '@perfect-placement/contracts';
import { ops } from '@perfect-placement/engine';
import {
  type FakeAskLauncher,
  type FixtureEngine,
  type FixtureOptions,
  fakeAskLauncher,
  openFixtureEngine,
  tickingClock,
} from '@perfect-placement/engine/testing';
import { FIXTURE_NOW } from '@perfect-placement/fixtures';
import { createHttpClient } from '../client/http';
import type { OpClient } from '../client/types';

/*
 * Test harness for the live client: a fake `fetch` that serves `POST /api/ops/:name` the way
 * `pp up` does (JSON body = op input, actor human, reply = OpOutcome) from a real engine over a
 * temp copy of the synthetic fixture vault. No sockets, no network, no real PP_HOME.
 * `POST /api/ask` runs the engine's Ask turn (`ops.runAsk`) with a fake runner (`askScript`) that replays a
 * recorded transcript, streamed back as SSE like `pp up`. No agent ever launches.
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
  /** The fake Ask runner (its launch specs). */
  ask: FakeAskLauncher;
  /** Run an op as another actor (the agent finishing a run, a schedule), bypassing HTTP. `over`: e.g. the agent's confidence. */
  as(actor: Actor, name: string, input: unknown, over?: Partial<OpContext>): Promise<OpOutcome<unknown>>;
  now: () => Date;
  close(): void;
}

/** Gmail double: records drafts, never sends (the engine only ever creates drafts). */
const gmailDouble = () => {
  let n = 0;
  return { mode: 'dry-run' as const, createDraft: async () => ({ draftId: `dryrun-${++n}` }) };
};

export interface LiveOptions extends FixtureOptions {
  /** The fake Ask runner: stdout lines per turn (see `fakeAskLauncher`). Default: a runner that is not installed. */
  askScript?: Parameters<typeof fakeAskLauncher>[0];
  askRunner?: RunnerConfig;
}

export function openLive(opts: LiveOptions = {}): Live {
  const engine = openFixtureEngine({ ...opts, services: { gmail: gmailDouble(), ...(opts.services ?? {}) } });
  const clock = tickingClock(FIXTURE_NOW);
  const calls: FetchCall[] = [];
  const askLauncher = fakeAskLauncher(opts.askScript ?? (() => 'missing'));
  const askThreads = new ops.AskThreads();
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (/\/api\/ask$/.test(url) && init?.method === 'POST') {
      const turn = ops.runAsk(JSON.parse(String(init.body)), {
        home: engine.home,
        runner: opts.askRunner ?? { command: 'claude' },
        mcp: { command: 'node', args: ['pp-mcp'], env: { PP_HOME: engine.home } },
        launcher: askLauncher,
        threads: askThreads,
      });
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(ctrl) {
          for await (const ev of turn) ctrl.enqueue(enc.encode(askChatFrame(ev)));
          ctrl.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
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
    ask: askLauncher,
    as: (actor, name, input, over) => engine.runOp(name, input, { ...over, actor, now: clock }),
    now: () => new Date(FIXTURE_NOW),
    close: () => engine.cleanup(),
  };
}
