/*
 * Transports: stdio (Claude Code, Codex, Cursor spawn the server) and Streamable HTTP
 * (mounted by `pp up`, lane B). HTTP is stateless: a fresh server per request, so there
 * is no session state to leak between clients, and it only answers loopback hosts.
 */
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createPpMcpServer, type PpMcpServerOptions } from './server.js';

export async function serveStdio(options: PpMcpServerOptions): Promise<void> {
  const server = createPpMcpServer(options);
  await server.connect(new StdioServerTransport());
}

export interface HttpOptions extends PpMcpServerOptions {
  /** Hostnames (no port) allowed in the Host header. Default: loopback only. */
  allowedHostnames?: string[];
}

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

function hostnameOf(host: string | undefined): string | null {
  if (!host) return null;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

function jsonRpcError(res: ServerResponse, http: number, code: number, message: string): void {
  res.writeHead(http, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/**
 * Node request handler for the MCP endpoint. Mount it at `/mcp` from `pp up`.
 * POST carries JSON-RPC; GET and DELETE are 405 (stateless, no standalone SSE stream).
 */
export function createMcpHttpHandler(options: HttpOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const allowed = new Set(options.allowedHostnames ?? LOOPBACK);
  return async (req, res) => {
    const hostname = hostnameOf(req.headers.host);
    if (!hostname || !allowed.has(hostname)) return jsonRpcError(res, 403, -32000, 'host not allowed');
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return jsonRpcError(res, 405, -32000, 'method not allowed');
    }
    const server = createPpMcpServer(options);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) jsonRpcError(res, 500, -32603, err instanceof Error ? err.message : 'internal error');
    }
  };
}

export interface StartedHttpServer {
  url: URL;
  server: HttpServer;
  close: () => Promise<void>;
}

/** Standalone HTTP server (for `pp-mcp --http`). `pp up` should mount `createMcpHttpHandler` instead. */
export async function startMcpHttpServer(
  options: HttpOptions & { port?: number; host?: string; path?: string },
): Promise<StartedHttpServer> {
  const host = options.host ?? '127.0.0.1';
  const path = options.path ?? '/mcp';
  const handler = createMcpHttpHandler(options);
  const server = createServer((req, res) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== path) return jsonRpcError(res, 404, -32000, 'not found');
    void handler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  const { port } = server.address() as AddressInfo;
  const url = new URL(`http://${host.includes(':') ? `[${host}]` : host}:${port}${path}`);
  return {
    url,
    server,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
