import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Actor, type OpContext, type OpOutcome } from '@perfect-placement/contracts';
import { ops } from '@perfect-placement/engine';

/*
 * `pp up`: one local process serving
 *   /api/ops       op list            (GET)
 *   /api/ops/:name runOp              (POST { input, actor?, dryRun?, runId?, decisionId? })
 *   /api/health
 *   /mcp           MCP Streamable HTTP (lane C mounts here in Wave 2)
 *   /              the built web UI    (lane D, apps/web/dist)
 * Bound to 127.0.0.1 only.
 */

export type Mount = { prefix: string; handle(req: IncomingMessage, res: ServerResponse): void | Promise<void> };

export interface UpOptions {
  engine: ops.Engine;
  port?: number;
  host?: string;
  /** Static web build to serve at `/`. */
  webDir?: string | null;
  /** Extra handlers (MCP HTTP transport) by path prefix. */
  mounts?: Mount[];
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
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

/** apps/web/dist next to this package in the monorepo, if built. */
export function defaultWebDir(): string | null {
  const dir = fileURLToPath(new URL('../../../../apps/web/dist', import.meta.url));
  return existsSync(join(dir, 'index.html')) ? dir : null;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

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

function serveStatic(dir: string, pathname: string, res: ServerResponse): boolean {
  const root = resolve(dir);
  let file = normalize(join(root, decodeURIComponent(pathname)));
  if (!file.startsWith(root)) return false;
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html'); // SPA fallback
  if (!existsSync(file)) return false;
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
  return true;
}

export function up(opts: UpOptions): Promise<Running> {
  const { engine } = opts;
  const webDir = opts.webDir === undefined ? defaultWebDir() : opts.webDir;
  const mounts = opts.mounts ?? [];

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const origin = req.headers.origin;
      if (origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('access-control-allow-headers', 'content-type');
        res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      }
      if (req.method === 'OPTIONS') return void res.writeHead(204).end();

      for (const m of mounts) if (url.pathname.startsWith(m.prefix)) return void (await m.handle(req, res));

      if (url.pathname === '/api/health') return json(res, 200, { ok: true, home: engine.home });
      if (url.pathname === '/api/ops' && req.method === 'GET')
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
      const m = /^\/api\/ops\/([a-z_.]+)$/.exec(url.pathname);
      if (m && req.method === 'POST') {
        let body: Record<string, unknown> = {};
        const raw = await readBody(req);
        if (raw.trim()) body = JSON.parse(raw) as Record<string, unknown>;
        const actor = Actor.safeParse(body.actor ?? 'human');
        if (!actor.success) return json(res, 400, { status: 'error', code: 'invalid_input', message: 'bad actor' });
        const ctx: OpContext = {
          actor: actor.data,
          now: () => new Date(),
          ...(typeof body.runId === 'string' ? { runId: body.runId } : {}),
          ...(typeof body.decisionId === 'string' ? { decisionId: body.decisionId } : {}),
          ...(body.dryRun === true ? { dryRun: true } : {}),
        };
        const outcome = await engine.runOp(m[1] as string, body.input ?? {}, ctx);
        return json(res, httpStatusOf(outcome), outcome);
      }
      if (url.pathname.startsWith('/mcp'))
        return json(res, 501, { status: 'error', code: 'unimplemented', message: 'MCP HTTP mounts here (lane C)' });
      if (req.method === 'GET' && webDir && serveStatic(webDir, url.pathname, res)) return;
      json(res, 404, { status: 'error', code: 'not_found', message: url.pathname });
    } catch (e) {
      json(res, 500, { status: 'error', code: 'internal', message: (e as Error).message });
    }
  });

  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port ?? 4317, opts.host ?? '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      ok({
        server,
        url: `http://${opts.host ?? '127.0.0.1'}:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
