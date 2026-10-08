#!/usr/bin/env node
/*
 * pp-mcp: run the Perfect Placement MCP server.
 *   pp-mcp                       stdio, lane B's runOp from @perfect-placement/engine (Wave 2)
 *   pp-mcp --fixtures            stdio, FAKE fixtures runOp (demo/testing only, no real data)
 *   pp-mcp --http [--port 7331]  Streamable HTTP on 127.0.0.1 at /mcp
 *   --tool-names underscore      roles_list instead of roles.list (or PP_MCP_TOOL_NAMES)
 * stdout belongs to the stdio protocol: log to stderr only.
 */
import type { RunOp } from '@perfect-placement/contracts';
import type { ToolNameStyle } from './tools.js';
import { serveStdio, startMcpHttpServer } from './transports.js';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const value = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

async function loadRunOp(): Promise<RunOp> {
  if (flag('--fixtures')) {
    const { createFakeRunOp } = await import('./testing/fake-run-op.js');
    process.stderr.write('pp-mcp: using the FAKE fixtures runOp (synthetic data, in memory)\n');
    return createFakeRunOp().runOp;
  }
  const spec = '@perfect-placement/engine';
  try {
    const engine = (await import(spec)) as { runOp?: RunOp };
    if (typeof engine.runOp === 'function') return engine.runOp;
  } catch {
    // fall through
  }
  throw new Error('runOp not available from @perfect-placement/engine yet (Wave 2). Use --fixtures for the synthetic demo.');
}

async function main(): Promise<void> {
  const runOp = await loadRunOp();
  const style = (value('--tool-names') ?? process.env.PP_MCP_TOOL_NAMES ?? 'dotted') as ToolNameStyle;
  if (style !== 'dotted' && style !== 'underscore') throw new Error(`--tool-names must be dotted or underscore, got ${style}`);
  if (flag('--http')) {
    const started = await startMcpHttpServer({ runOp, toolNames: style, port: Number(value('--port') ?? 7331) });
    process.stderr.write(`pp-mcp: listening on ${started.url.href}\n`);
    return;
  }
  await serveStdio({ runOp, toolNames: style });
}

main().catch((err: unknown) => {
  process.stderr.write(`pp-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
