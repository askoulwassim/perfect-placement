/*
 * Minimal HTTP surface the adapters and the page fallback need. The global `fetch` satisfies it;
 * tests inject a fake that serves recorded fixtures (no live calls in CI).
 */

export interface HttpResponse {
  status: number;
  /** Final URL after redirects. */
  url: string;
  redirected: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface HttpInit {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  redirect?: 'follow' | 'manual';
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init?: HttpInit) => Promise<HttpResponse>;

export const USER_AGENT = 'perfect-placement-freshness/0.1 (+local job-search tool; low volume)';
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Wrap the global fetch with a UA and timeout. */
export function defaultFetch(timeoutMs = DEFAULT_TIMEOUT_MS): FetchLike {
  return (url, init) =>
    fetch(url, {
      method: init?.method ?? 'GET',
      redirect: init?.redirect ?? 'follow',
      headers: { 'user-agent': USER_AGENT, accept: '*/*', ...(init?.headers ?? {}) },
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    });
}

export type JsonResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; body: unknown }
  | { ok: false; status: 0; error: string };

/** GET a JSON endpoint. Never throws: network errors come back as status 0. */
export async function getJson<T>(fetchFn: FetchLike, url: string): Promise<JsonResult<T>> {
  let res: HttpResponse;
  try {
    res = await fetchFn(url, { headers: { accept: 'application/json' } });
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
  const raw = await res.text().catch(() => '');
  let body: unknown = raw;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    // Non-JSON body (e.g. Ashby "Not Found"); keep the raw text.
  }
  if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, body: body as T };
  return { ok: false, status: res.status, body };
}
