#!/usr/bin/env node
/** Internal Codex browser adapter. stdout is exclusively the MCP stdio protocol. */
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runners } from '@perfect-placement/engine';
import { type BrowserAdapter, startBrowserAdapter } from './browser.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'runtime-dir': { type: 'string' },
      /** The run's browser policy (#161), JSON: its tools, rendered-PDF uploads and sites. */
      policy: { type: 'string' },
    },
  });
  if (!values['runtime-dir']) throw new Error('Missing browser runtime. Run pp setup --runner codex');
  if (!values.policy) throw new Error("Missing the run's browser policy");
  const policy = runners.parseBrowserPolicy(values.policy);
  const controller = new AbortController();
  let adapter: BrowserAdapter | undefined;
  const shutdown = () => {
    controller.abort();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);
  try {
    adapter = await startBrowserAdapter(values['runtime-dir'], policy, controller.signal);
    controller.signal.throwIfAborted();
    await adapter.server.connect(new StdioServerTransport());
  } catch (error) {
    await adapter?.close();
    if (controller.signal.aborted) return;
    throw error;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`pp-browser: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
