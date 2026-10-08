/*
 * Test-only fake `fetch` that serves recorded ATS responses (no live calls in CI).
 * Recorded 2026-10-08 from the public Greenhouse (vercel), Lever (leverdemo) and Ashby (linear)
 * posting APIs; descriptions shortened and anything not needed scrubbed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FetchLike, HttpResponse } from '../http.js';

// Tests run from source, so the JSON sits next to this file.
const DIR = fileURLToPath(new URL('./', import.meta.url));

export function recorded(name: string): string {
  return readFileSync(`${DIR}${name}`, 'utf8');
}
export const recordedJson = <T = unknown>(name: string): T => JSON.parse(recorded(name)) as T;

export interface FakeReply {
  status: number;
  body?: string;
  /** Final URL after redirects (defaults to the request URL). */
  finalUrl?: string;
}

export type Route = (url: string) => FakeReply | undefined;

/** Fake fetch over a route function; records every requested URL. Unrouted URLs throw (no accidental live calls). */
export function fakeFetch(route: Route): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const r = route(url);
    if (!r) throw new Error(`unrouted URL in test: ${url}`);
    const res: HttpResponse = {
      status: r.status,
      url: r.finalUrl ?? url,
      redirected: r.finalUrl !== undefined && r.finalUrl !== url,
      headers: { get: () => null },
      text: async () => r.body ?? '',
    };
    return res;
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

export const page = (bodyHtml: string, title = 'Job') =>
  `<!doctype html><html><head><title>${title}</title></head><body>${bodyHtml}</body></html>`;
