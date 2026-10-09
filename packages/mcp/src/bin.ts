#!/usr/bin/env node
/*
 * pp-mcp: the Perfect Placement MCP server on the real engine.
 *   pp-mcp [--home <dir>]          stdio, `openEngine()` on --home / PP_HOME / ~/.perfect-placement
 *   pp-mcp --fixtures              stdio, demo: the real engine on a temp copy of the synthetic fixture vault
 *   pp-mcp --http [--port 7331]    Streamable HTTP on 127.0.0.1 at /mcp (`pp up` also mounts /mcp)
 *   --tool-names dotted            roles.list instead of the default roles_list (or PP_MCP_TOOL_NAMES)
 * stdout belongs to the stdio protocol: log to stderr only.
 */
import type { RunOp } from '@perfect-placement/contracts';
import { openEngine, ops } from '@perfect-placement/engine';
import { openFixtureDemo } from './engine.js';
import { DEFAULT_TOOL_NAME_STYLE, type ToolNameStyle } from './tools.js';
import { serveStdio, startMcpHttpServer } from './transports.js';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const value = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main(): Promise<void> {
  const style = (value('--tool-names') ?? process.env.PP_MCP_TOOL_NAMES ?? DEFAULT_TOOL_NAME_STYLE) as ToolNameStyle;
  if (style !== 'dotted' && style !== 'underscore') throw new Error(`--tool-names must be dotted or underscore, got ${style}`);

  let runOp: RunOp;
  let close: () => void;
  if (flag('--fixtures')) {
    const demo = await openFixtureDemo();
    process.stderr.write(`pp-mcp: fixtures demo (synthetic data, offline) at ${demo.home}\n`);
    runOp = demo.engine.runOp;
    close = demo.close;
  } else {
    const engine = openEngine({ home: value('--home') ?? ops.resolveHome() });
    process.stderr.write(`pp-mcp: PP_HOME ${engine.home}\n`);
    runOp = engine.runOp;
    close = () => engine.close();
  }
  let closed = false;
  const shutdown = () => {
    if (closed) return;
    closed = true;
    close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  if (flag('--http')) {
    const started = await startMcpHttpServer({ runOp, toolNames: style, port: Number(value('--port') ?? 7331) });
    process.stderr.write(`pp-mcp: listening on ${started.url.href}\n`);
    return;
  }
  // When the client closes stdin, in-flight calls finish, the loop drains, then the engine closes.
  process.once('beforeExit', () => {
    if (!closed) {
      closed = true;
      close();
    }
  });
  // A headless skill run (#50): the runner passes its run id; every op is linked to it.
  const runId = process.env.PP_RUN_ID?.trim() || undefined;
  if (runId) process.stderr.write(`pp-mcp: run ${runId}\n`);
  // An Ask session (#39): skill runs it starts are queued headless runs.
  const ask = process.env.PP_ASK === '1';
  await serveStdio({ runOp, toolNames: style, ...(runId ? { runId } : {}), ...(ask ? { ask } : {}) });
}

main().catch((err: unknown) => {
  process.stderr.write(`pp-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
