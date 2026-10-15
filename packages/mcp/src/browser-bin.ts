#!/usr/bin/env node
/** Internal Codex browser adapter. stdout is exclusively the MCP stdio protocol. */
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type BrowserAdapter, startBrowserAdapter } from './browser.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'runtime-dir': { type: 'string' },
      assist: { type: 'boolean', default: false },
      'files-dir': { type: 'string' },
    },
  });
  if (!values['runtime-dir']) throw new Error('Missing browser runtime. Run pp setup --runner codex');
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
    adapter = await startBrowserAdapter(values['runtime-dir'], { assist: values.assist, filesDir: values['files-dir'] }, controller.signal);
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
