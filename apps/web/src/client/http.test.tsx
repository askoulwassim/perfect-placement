import { FIXTURE_NOW } from '@perfect-placement/fixtures';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { createHttpClient } from './http';

type Handler = (name: string, body: unknown) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

/** A scripted fetch: records each call and answers from the handler. */
function fakeFetch(handler: Handler) {
  const calls: Array<{ url: string; method?: string; headers?: HeadersInit; body: unknown }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init?.method, headers: init?.headers, body });
    const name = decodeURIComponent(url.split('/ops/')[1] ?? '');
    const r = await handler(name, body);
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('createHttpClient', () => {
  it('POSTs the op input as JSON to {base}/ops/{name} and returns the OpOutcome', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { status: 'ok', output: { ok: true }, eventIds: ['ev_1'] } }));
    const c = createHttpClient('http://127.0.0.1:5177/api/', f.fetch);
    const o = await c.run('profile.reject_diff', { diff_id: 'pd_0001' });
    expect(o).toEqual({ status: 'ok', output: { ok: true }, eventIds: ['ev_1'] });
    expect(f.calls[0]).toMatchObject({
      url: 'http://127.0.0.1:5177/api/ops/profile.reject_diff',
      method: 'POST',
      body: { diff_id: 'pd_0001' },
    });
  });

  it('reads the outcome whatever the HTTP status (202 requires_human, 4xx/5xx error)', async () => {
    const f = fakeFetch((name) =>
      name === 'config.update'
        ? { status: 202, body: { status: 'requires_human', decisionId: 'dc_9' } }
        : { status: 409, body: { status: 'error', code: 'forbidden_transition', message: 'active -> applied' } },
    );
    const c = createHttpClient('/api', f.fetch);
    expect(await c.run('config.update', { patch: {} })).toEqual({ status: 'requires_human', decisionId: 'dc_9' });
    const e = await c.run('roles.move', { role_id: 'x', to: 'applied' });
    expect(e.status === 'error' && e.code).toBe('forbidden_transition');
  });

  it('maps network failures and non-outcome replies to backend_unavailable', async () => {
    const down = createHttpClient('/api', (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    const a = await down.run('pipeline.summary', {});
    expect(a.status === 'error' && a.code).toBe('backend_unavailable');
    const html = createHttpClient('/api', fakeFetch(() => ({ status: 404, body: '<!doctype html>' })).fetch);
    const b = await html.run('pipeline.summary', {});
    expect(b.status === 'error' && b.code).toBe('backend_unavailable');
    const junk = createHttpClient('/api', fakeFetch(() => ({ status: 200, body: { hello: 1 } })).fetch);
    const d = await junk.run('pipeline.summary', {});
    expect(d.status === 'error' && d.code).toBe('backend_unavailable');
  });
});

describe('OpOutcome handling in the app', () => {
  it('requires_human toasts "Queued for you" and refreshes the Needs-you badge', async () => {
    let needs = 0;
    const summary = () => ({
      status: 'ok',
      output: { counts: {}, archived_by_reason: {}, needs_you: needs, auto_share_24h: 1, closed_today: 0, drafts_ready: 0, replies: 0 },
      eventIds: [],
    });
    const f = fakeFetch((name) => {
      if (name === 'config.update') {
        needs = 1;
        return { status: 202, body: { status: 'requires_human', decisionId: 'dc_new' } };
      }
      if (name === 'pipeline.summary') return { status: 200, body: summary() };
      return { status: 501, body: { status: 'error', code: 'unimplemented', message: name } };
    });
    window.location.hash = '#/settings';
    const { container } = render(<App client={createHttpClient('/api', f.fetch)} now={() => new Date(FIXTURE_NOW)} />);
    await waitFor(() => expect(f.calls.some((c) => c.url.endsWith('/pipeline.summary'))).toBe(true));
    expect(container.querySelector('.rail__badge')).toBeNull();
    await act(async () => {
      (container.querySelector('.btn--primary') as HTMLButtonElement).click();
    });
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Queued for you'));
    await waitFor(() => expect(container.querySelector('.rail__badge')).not.toBeNull());
  });

  it('errors toast without throwing (offline API)', async () => {
    window.location.hash = '#/settings';
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const { container } = render(<App client={createHttpClient('/api', down)} now={() => new Date(FIXTURE_NOW)} />);
    await act(async () => {
      (container.querySelector('.btn--primary') as HTMLButtonElement).click();
    });
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Offline'));
  });
});
