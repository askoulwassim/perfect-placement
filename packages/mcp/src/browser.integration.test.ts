/**
 * Opt-in regression against the installed, patched native runtime and isolated headless Chrome.
 * PP_BROWSER_TEST_CACHE must name the XDG cache used by a synthetic setup, never a real vault.
 * PP_BROWSER_TEST_CACHE=/tmp/<synthetic-cache> pnpm --filter @perfect-placement/mcp test -- src/browser.integration.test.ts
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { runners } from '@perfect-placement/engine';
import { describe, expect, it } from 'vitest';
import { type BrowserAdapter, browserServerParameters, createBrowserAdapter } from './browser.js';

const cache = process.env.PP_BROWSER_TEST_CACHE;
const resultText = (result: CallToolResult) => result.content.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join('\n');

describe.skipIf(!cache)('patched native browser uploads', () => {
  it('uploads to a file input but rejects a Submit UID without sending the form', { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pp-browser-upload-regression-'));
    const filesDir = join(root, 'files', 'synthetic-role');
    const userHome = join(root, 'home');
    const temp = join(root, 'tmp');
    await Promise.all([filesDir, userHome, temp].map((dir) => mkdir(dir, { recursive: true })));
    const resume = join(filesDir, 'resume.pdf');
    await writeFile(resume, '%PDF-1.4\n% Synthetic upload fixture\n%%EOF\n');
    const submissions: string[] = [];
    const http = createServer((req, res) => {
      if (req.method === 'POST') submissions.push(req.url ?? '');
      req.resume();
      res.setHeader('content-type', 'text/html');
      res.end(
        req.url === '/submit'
          ? '<!doctype html><title>Submitted</title><h1>Synthetic submission received</h1>'
          : '<!doctype html><title>Synthetic application</title><form method="post" action="/submit"><label>Resume <input type="file" name="resume"></label><button type="submit">Submit application</button></form>',
      );
    });
    const client = new Client({ name: 'pp-synthetic-upload-test', version: '1' });
    let adapter: BrowserAdapter | undefined;
    let native: StdioClientTransport | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        http.once('error', reject);
        http.listen(0, '127.0.0.1', resolve);
      });
      const address = http.address();
      if (!address || typeof address === 'string') throw new Error('No fixture server address');
      const url = `http://127.0.0.1:${address.port}/`;
      const runtime = runners.codexBrowserRuntime({ userHome, env: { XDG_CACHE_HOME: cache } });
      const options = { assist: true, filesDir };
      const parameters = browserServerParameters(runtime.dir, options, runtime);
      // Only the connection changes for this test. The adapter's guards and native upload tool are production code.
      parameters.args = parameters.args?.flatMap((arg) => (arg === '--autoConnect' ? ['--headless', '--isolated'] : [arg]));
      parameters.env = {
        ...parameters.env,
        HOME: userHome,
        XDG_CACHE_HOME: join(userHome, '.cache'),
        XDG_CONFIG_HOME: join(userHome, '.config'),
        TMPDIR: temp,
        TMP: temp,
        TEMP: temp,
      };
      parameters.stderr = 'pipe';
      native = new StdioClientTransport(parameters);
      adapter = await createBrowserAdapter(native, options);
      const [downClient, downServer] = InMemoryTransport.createLinkedPair();
      await adapter.server.connect(downServer);
      await client.connect(downClient);
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      expect(tools).toContain('upload_file');
      for (const forbidden of ['click', 'press_key', 'evaluate_script']) expect(tools).not.toContain(forbidden);
      const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
      const opened = await call('new_page', { url });
      expect(opened.isError, resultText(opened)).not.toBe(true);
      const pageLine = resultText(opened)
        .split('\n')
        .find((line) => line.includes(url));
      const pageId = Number(pageLine?.match(/^(\d+):/)?.[1]);
      expect(pageId).toBeGreaterThan(0);
      const uid = (snapshot: string, label: string): string => {
        const value = snapshot
          .split('\n')
          .find((line) => line.includes(`button "${label}"`))
          ?.match(/uid=(\S+)/)?.[1];
        if (!value) throw new Error(`Missing ${label} UID in ${snapshot}`);
        return value;
      };
      const before = resultText(await call('take_snapshot', { pageId }));
      const valid = await call('upload_file', { pageId, uid: uid(before, 'Resume'), filePaths: [resume] });
      expect(valid.isError, resultText(valid)).not.toBe(true);
      const afterUpload = resultText(await call('take_snapshot', { pageId }));
      expect(afterUpload).toContain('resume.pdf');
      expect(submissions).toEqual([]);
      const wrongTarget = await call('upload_file', { pageId, uid: uid(afterUpload, 'Submit application'), filePaths: [resume] });
      expect(wrongTarget.isError).toBe(true);
      const afterRejected = resultText(await call('take_snapshot', { pageId }));
      expect(submissions, resultText(wrongTarget)).toEqual([]);
      expect(afterRejected).toContain(`url="${url}"`);
      expect(afterRejected).toContain('Submit application');
      expect(afterRejected).toContain('resume.pdf');
    } finally {
      await client.close();
      await adapter?.close();
      await native?.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
