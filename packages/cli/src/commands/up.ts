import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askChatFrame, type OpContext, type OpOutcome } from '@perfect-placement/contracts';
import { ops, runners } from '@perfect-placement/engine';
import { createMcpHttpHandler, type ToolNameStyle } from '@perfect-placement/mcp';

/*
 * `pp up`: one local process, loopback only.
 *   POST /api/ops/:name   runOp(name, <JSON body = op input>, { actor: 'human' }) -> OpOutcome JSON
 *   GET  /api/ops         op list
 *   GET  /api/health
 *   GET  /api/files?path= a rendered PDF / DOCX (#106) as a download, only files an application references
 *   POST /api/ask         Ask (#39): one agent turn (config.runner + pp MCP), streamed as SSE AskChatEvents;
 *                         threads kept in the vault's ask_thread table (#69), so `thread_id` survives a restart
 *   POST /mcp             MCP Streamable HTTP (actor agent), same engine
 *   GET  /*               apps/web/dist with SPA fallback
 * The web dev server (Vite) runs on 5178 and calls this API cross-origin (loopback origins only).
 */

export const DEFAULT_PORT = 5177;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export type Mount = { prefix: string; handle(req: IncomingMessage, res: ServerResponse): void | Promise<void> };

export interface UpOptions {
  engine: ops.Engine;
  /** Default 5177; 0 = ephemeral (tests). */
  port?: number;
  /** Bind address; loopback only. Default 127.0.0.1. */
  host?: string;
  /** Static web build at `/`. Default apps/web/dist if built; null = none. */
  webDir?: string | null;
  /** Mount MCP Streamable HTTP at /mcp (default true). */
  mcp?: boolean;
  toolNames?: ToolNameStyle;
  /** Extra handlers by path prefix. */
  mounts?: Mount[];
  /** Launches Ask turns (#39). Default: spawns `config.runner`. Tests inject a fake; never a real agent. */
  askLauncher?: ops.AskLauncher;
  /** The pp MCP server an Ask turn gets. Default: `defaultMcpServer(home)`. */
  askMcp?: runners.McpServerSpec;
}

export interface Running {
  server: Server;
  url: string;
  close(): Promise<void>;
}

const STATUS_FOR: Record<string, number> = {
  invalid_input: 400,
  not_found: 404,
  conflict: 409,
  forbidden_transition: 409,
  human_only: 403,
  unimplemented: 501,
  backend_unavailable: 503,
  internal: 500,
};
export const httpStatusOf = (o: OpOutcome<unknown>) =>
  o.status === 'ok' ? 200 : o.status === 'requires_human' ? 202 : (STATUS_FOR[o.code] ?? 500);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

/** apps/web/dist in the monorepo, if built. */
export function defaultWebDir(): string | null {
  const dir = fileURLToPath(new URL('../../../../apps/web/dist', import.meta.url));
  return existsSync(join(dir, 'index.html')) ? dir : null;
}

const hostnameOf = (host: string | undefined): string | null => {
  if (!host) return null;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
const fail = (res: ServerResponse, status: number, code: string, message: string) => json(res, status, { status: 'error', code, message });

async function readBody(req: IncomingMessage, limit = 5 * 1024 * 1024): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Serve a file from `dir`, or index.html for extensionless paths (SPA routes). */
function serveStatic(dir: string, pathname: string, req: IncomingMessage, res: ServerResponse): boolean {
  const root = resolve(dir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  let file = normalize(join(root, decoded));
  if (file !== root && !file.startsWith(root + sep)) return false;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(decoded) && extname(decoded) !== '.html') return false; // a missing asset is a 404, not the app
    file = join(root, 'index.html');
  }
  if (!existsSync(file)) return false;
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
  return true;
}

/** Stream one Ask turn as Server-Sent Events; the runner is killed if the client goes away. */
async function streamAsk(
  engine: ops.Engine,
  body: unknown,
  res: ServerResponse,
  o: { threads: ops.AskThreads; launcher: ops.AskLauncher; mcp: runners.McpServerSpec | undefined },
): Promise<void> {
  const abort = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) abort.abort();
  });
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.flushHeaders();
  const turn = ops.runAsk(body, {
    home: engine.home,
    runner: ops.readConfig(engine.home).runner,
    mcp: o.mcp ?? runners.defaultMcpServer(engine.home),
    launcher: o.launcher,
    threads: o.threads,
    signal: abort.signal,
  });
  try {
    for await (const ev of turn) {
      if (abort.signal.aborted) break;
      res.write(askChatFrame(ev));
    }
  } catch (e) {
    if (!abort.signal.aborted) res.write(askChatFrame({ type: 'error', code: 'runner_failed', message: (e as Error).message }));
  }
  res.end();
}

export function up(opts: UpOptions): Promise<Running> {
  const { engine } = opts;
  const host = opts.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) return Promise.reject(new Error(`pp up binds to loopback only, not ${host}`));
  const webDir = opts.webDir === undefined ? defaultWebDir() : opts.webDir;
  const mounts = [...(opts.mounts ?? [])];
  // Ask threads persist in the vault (#69): a restart resumes them by id; idle ones are pruned.
  const askThreads = new ops.AskThreads({ store: ops.dbAskThreadStore(engine.db) });
  const askLauncher = opts.askLauncher ?? ops.createAskSpawner();
  if (opts.mcp !== false) {
    const handle = createMcpHttpHandler({ runOp: engine.runOp, ...(opts.toolNames ? { toolNames: opts.toolNames } : {}) });
    mounts.push({ prefix: '/mcp', handle });
  }

  const server = createServer(async (req, res) => {
    try {
      // DNS-rebinding guard: only loopback Host headers, for every route.
      const hostname = hostnameOf(req.headers.host);
      if (!hostname || !LOOPBACK_HOSTS.has(hostname)) return fail(res, 403, 'forbidden', 'host not allowed');
      const url = new URL(req.url ?? '/', 'http://localhost');
      const origin = req.headers.origin;
      if (origin && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('access-control-allow-headers', 'content-type, mcp-protocol-version');
        res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
        res.setHeader('vary', 'origin');
      }
      if (req.method === 'OPTIONS') return void res.writeHead(204).end();

      for (const m of mounts)
        if (url.pathname === m.prefix || url.pathname.startsWith(`${m.prefix}/`)) return void (await m.handle(req, res));

      if (url.pathname === '/api/health') return json(res, 200, { ok: true, home: engine.home });
      if (url.pathname === '/api/files') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.setHeader('allow', 'GET');
          return fail(res, 405, 'method_not_allowed', 'GET /api/files');
        }
        // Read-only (#106): a rendered document the db references, nothing else in the vault.
        const file = ops.downloadableFile(engine.db, engine.home, url.searchParams.get('path') ?? '');
        if (!file) return fail(res, 404, 'not_found', 'no rendered document at that path');
        res.writeHead(200, {
          'content-type': file.contentType,
          'content-length': String(file.bytes),
          'content-disposition': `attachment; filename="${file.name.replace(/[^\w.-]/g, '_')}"`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        return void res.end(req.method === 'HEAD' ? undefined : readFileSync(file.abs));
      }
      if (url.pathname === '/api/ask') {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST');
          return fail(res, 405, 'method_not_allowed', 'POST /api/ask');
        }
        let body: unknown;
        try {
          body = JSON.parse((await readBody(req, 64 * 1024)) || '{}');
        } catch (e) {
          return fail(res, 400, 'invalid_input', `body is not valid JSON: ${(e as Error).message}`);
        }
        return void (await streamAsk(engine, body, res, { threads: askThreads, launcher: askLauncher, mcp: opts.askMcp }));
      }
      if (url.pathname === '/api/ops') {
        if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed', 'GET /api/ops');
        return json(
          res,
          200,
          Object.values(ops.ALL_OPS).map((d) => ({
            name: d.name,
            description: d.description,
            impact: d.impact,
            owner: d.owner,
            readOnly: Boolean(d.readOnly),
            humanOnly: Boolean(d.humanOnly),
            implemented: !d.unimplemented && engine.has(d.name),
          })),
        );
      }
      const m = /^\/api\/ops\/([^/]+)$/.exec(url.pathname);
      if (m) {
        const name = decodeURIComponent(m[1] as string);
        if (!(name in ops.ALL_OPS)) return fail(res, 404, 'not_found', `unknown op: ${name}`);
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST');
          return fail(res, 405, 'method_not_allowed', `POST /api/ops/${name}`);
        }
        const raw = await readBody(req);
        let input: unknown = {};
        if (raw.trim()) {
          try {
            input = JSON.parse(raw);
          } catch (e) {
            return fail(res, 400, 'invalid_input', `body is not valid JSON: ${(e as Error).message}`);
          }
        }
        const ctx: OpContext = { actor: 'human', now: () => new Date() };
        const outcome = await engine.runOp(name, input, ctx);
        return json(res, httpStatusOf(outcome), outcome);
      }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return fail(res, 404, 'not_found', url.pathname);
      if ((req.method === 'GET' || req.method === 'HEAD') && webDir && serveStatic(webDir, url.pathname, req, res)) return;
      fail(res, 404, 'not_found', url.pathname);
    } catch (e) {
      if (!res.headersSent) fail(res, 500, 'internal', (e as Error).message);
      else res.end();
    }
  });

  return new Promise((ok, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? DEFAULT_PORT, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      ok({
        server,
        url: `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

/**
 * `pp up --kev`: report whether Kev answers (never starts it). "not installed" when `installed: false`, or (without
 * `installed`) when `system.backends` reports `not_installed`; else "unreachable".
 */
export async function checkKev(engine: ops.Engine, opts: { installed?: boolean } = {}): Promise<{ ok: boolean; line: string }> {
  const o = await engine.runOp('system.backends', {}, { actor: 'human', now: () => new Date() });
  if (o.status !== 'ok') return { ok: false, line: `kev: unknown (${o.status === 'error' ? o.message : o.status})` };
  const items = (o.output as { items: Array<{ name: string; status: string; latencyMs: number | null }> }).items;
  const kev = items.find((i) => i.name === 'kev');
  const baseUrl = ops.readConfig(engine.home).backends.kev?.baseUrl ?? '';
  if (!kev) return { ok: false, line: 'kev: not configured' };
  const ok = kev.status !== 'down' && kev.status !== 'not_installed';
  return {
    ok,
    line: ok
      ? `kev: ${kev.status} at ${baseUrl}${kev.latencyMs === null ? '' : ` (${kev.latencyMs} ms)`}`
      : opts.installed === false || (opts.installed === undefined && kev.status === 'not_installed')
        ? 'kev: not installed (run pp kev install); decisions fall back to the agent or Needs you'
        : `kev: unreachable at ${baseUrl} (start Kev yourself; decisions fall back to the agent or Needs you)`,
  };
}
