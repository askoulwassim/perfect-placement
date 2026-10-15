import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  InitializeRequestSchema,
  ListRootsRequestSchema,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { runners } from '@perfect-placement/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BrowserAdapter, type BrowserOptions, browserServerParameters, createBrowserAdapter } from './browser.js';

const tool = (name: string, extra: Record<string, object> = {}): Tool => ({
  name,
  title: `Native ${name}`,
  description: `Synthetic ${name}`,
  inputSchema: { type: 'object', properties: { pageId: { type: 'integer' }, uid: { type: 'string' }, ...extra } },
  annotations: { readOnlyHint: true },
  _meta: { synthetic: true },
});
const nativeTools = [
  tool('list_pages'),
  tool('new_page', { url: { type: 'string' } }),
  tool('close_page'),
  tool('navigate_page', { url: { type: 'string' }, initScript: { type: 'string' } }),
  tool('take_snapshot', { filePath: { type: 'string' } }),
  tool('fill_form', { elements: { type: 'array' } }),
  tool('upload_file', { filePaths: { type: 'array', items: { type: 'string' } } }),
  ...['click', 'press_key', 'evaluate_script', 'take_screenshot', 'submit'].map((name) => tool(name)),
];
const nativeResult: CallToolResult = {
  content: [{ type: 'text', text: 'Synthetic native result' }],
  structuredContent: { pageId: 7, uid: '7_3' },
  _meta: { native: true },
};

let home: string;
let filesDir: string;
const cleanups: Array<() => Promise<void>> = [];

async function connect(options: BrowserOptions = {}, behavior: { result?: CallToolResult; error?: McpError } = {}) {
  const native = new Server({ name: 'synthetic-native', version: '1' }, { capabilities: { tools: {} } });
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  native.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: nativeTools }));
  native.setRequestHandler(CallToolRequestSchema, async (request) => {
    calls.push(request.params);
    if (behavior.error) throw behavior.error;
    return behavior.result ?? nativeResult;
  });
  const [upClient, upServer] = InMemoryTransport.createLinkedPair();
  await native.connect(upServer);
  const adapter = await createBrowserAdapter(upClient, options);
  cleanups.push(adapter.close);
  const client = new Client({ name: 'synthetic-codex', version: '1' }, { capabilities: { roots: { listChanged: true } } });
  const roots = vi.fn(async () => ({ roots: [{ uri: 'file:///', name: 'broad-client-root' }] }));
  client.setRequestHandler(ListRootsRequestSchema, roots);
  const [downClient, downServer] = InMemoryTransport.createLinkedPair();
  await adapter.server.connect(downServer);
  await client.connect(downClient);
  cleanups.push(() => client.close());
  return { native, adapter, client, calls, roots };
}

beforeEach(async () => {
  // Canonical, as the adapter forwards it (macOS tmpdir() is under the /var -> /private/var link).
  home = await realpath(await mkdtemp(join(tmpdir(), 'pp-browser-adapter-')));
  filesDir = join(home, 'files', 'synthetic-role');
  await mkdir(filesDir, { recursive: true });
  await writeFile(join(filesDir, 'resume.pdf'), 'synthetic resume');
  await writeFile(join(filesDir, 'cover_letter.pdf'), 'synthetic cover letter');
});

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
  await rm(home, { recursive: true, force: true });
});

describe('restricted browser MCP boundary', () => {
  it('exposes only reads without assist, even with a files directory', async () => {
    const { client, calls } = await connect({ filesDir });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(runners.CODEX_BROWSER_READ_TOOLS);
    for (const name of ['fill_form', 'upload_file', 'click', 'press_key', 'evaluate_script', 'take_screenshot', 'submit']) {
      await expect(client.callTool({ name, arguments: {} })).rejects.toThrow('not allowed');
    }
    expect(calls).toHaveLength(0);
  });

  it('enables filling without documents, and uploads only with assist plus documents', async () => {
    const fill = await connect({ assist: true });
    expect((await fill.client.listTools()).tools.map((t) => t.name)).toEqual([...runners.CODEX_BROWSER_READ_TOOLS, 'fill_form']);
    await expect(fill.client.callTool({ name: 'upload_file', arguments: {} })).rejects.toThrow('not allowed');
    const upload = await connect({ assist: true, filesDir });
    expect((await upload.client.listTools()).tools.map((t) => t.name)).toEqual([
      ...runners.CODEX_BROWSER_READ_TOOLS,
      'fill_form',
      'upload_file',
    ]);
  });

  it('retains native schemas, metadata, results, page IDs and element UIDs', async () => {
    const { client, calls } = await connect({ assist: true, filesDir });
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === 'upload_file')).toEqual(nativeTools.find((t) => t.name === 'upload_file'));
    const args = { pageId: 7, elements: [{ uid: '7_3', value: 'Synthetic Candidate' }] };
    expect(await client.callTool({ name: 'fill_form', arguments: args })).toEqual(nativeResult);
    expect(calls).toEqual([{ name: 'fill_form', arguments: args }]);
  });

  it('rejects short fill values with control characters, which native typing would press as keys', async () => {
    const { client, calls } = await connect({ assist: true });
    for (const value of ['5\n', 'Yes\r', 'Synthetic\t ', 'No\u001b']) {
      const elements = [
        { uid: '7_1', value: 'Synthetic Candidate' },
        { uid: '7_3', value },
      ];
      await expect(client.callTool({ name: 'fill_form', arguments: { pageId: 7, elements } })).rejects.toThrow('control characters');
    }
    expect(calls).toHaveLength(0);
    // At 100 characters or more the native tool sets the value directly, so paragraphs keep their line breaks.
    const elements = [{ uid: '7_3', value: `${'Synthetic paragraph. '.repeat(5)}\n\nSecond synthetic paragraph.` }];
    await client.callTool({ name: 'fill_form', arguments: { pageId: 7, elements } });
    expect(calls).toEqual([{ name: 'fill_form', arguments: { pageId: 7, elements } }]);
  });

  it('preserves native tool errors and protocol errors', async () => {
    const result = { ...nativeResult, isError: true };
    const toolError = await connect({}, { result });
    expect(await toolError.client.callTool({ name: 'list_pages' })).toEqual(result);
    const protocolError = await connect(
      {},
      { error: new McpError(ErrorCode.InvalidParams, 'Synthetic native rejection', { field: 'pageId' }) },
    );
    await expect(protocolError.client.callTool({ name: 'list_pages' })).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      data: { field: 'pageId' },
    });
  });

  it('rejects snapshot file output and navigation scripts even when called directly', async () => {
    const { client, calls } = await connect();
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === 'take_snapshot')?.inputSchema.properties).not.toHaveProperty('filePath');
    expect(tools.find((t) => t.name === 'navigate_page')?.inputSchema.properties).not.toHaveProperty('initScript');
    await expect(client.callTool({ name: 'take_snapshot', arguments: { pageId: 7, filePath: join(home, 'output.txt') } })).rejects.toThrow(
      'inline',
    );
    await expect(
      client.callTool({ name: 'navigate_page', arguments: { pageId: 7, url: 'https://example.test', initScript: '' } }),
    ).rejects.toThrow('scripts');
    expect(calls).toHaveLength(0);
  });

  it('rejects local-file and executable navigation, allowing only web URLs and blank pages', async () => {
    const { client, calls } = await connect();
    for (const name of ['new_page', 'navigate_page']) {
      for (const url of [
        'file:///tmp/synthetic.txt',
        'javascript:alert(1)',
        'data:text/html,synthetic',
        'chrome://settings',
        'about:config',
        'ftp://example.test',
      ]) {
        await expect(client.callTool({ name, arguments: { pageId: 7, url } })).rejects.toThrow('HTTP or HTTPS');
      }
      for (const url of ['https://example.test/apply', 'http://127.0.0.1:1234', 'about:blank']) {
        await client.callTool({ name, arguments: { pageId: 7, url } });
      }
    }
    expect(calls).toHaveLength(6);
  });

  it('allows the two existing rendered PDFs and validates the whole array before forwarding', async () => {
    const { client, calls } = await connect({ assist: true, filesDir });
    const args = { pageId: 7, uid: '7_3', filePaths: [join(filesDir, 'resume.pdf'), join(filesDir, 'cover_letter.pdf')] };
    expect(await client.callTool({ name: 'upload_file', arguments: args })).toEqual(nativeResult);
    expect(calls).toEqual([{ name: 'upload_file', arguments: args }]);
    const forbidden = [
      join(filesDir, 'other.pdf'),
      join(home, 'files', 'other-role', 'resume.pdf'),
      join(home, 'profile.md'),
      join(home, 'temp.txt'),
    ];
    for (const file of forbidden) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, 'synthetic forbidden file');
      await expect(client.callTool({ name: 'upload_file', arguments: { ...args, filePaths: [args.filePaths[0], file] } })).rejects.toThrow(
        'Only this role',
      );
    }
    expect(calls).toHaveLength(1);
  });

  it('rejects escaping symlinks, directories, missing files, relative paths and empty lists', async () => {
    const { client, calls } = await connect({ assist: true, filesDir });
    const outside = join(home, 'outside.pdf');
    const resume = join(filesDir, 'resume.pdf');
    await writeFile(outside, 'synthetic outside');
    await rm(resume);
    await symlink(outside, resume);
    await expect(client.callTool({ name: 'upload_file', arguments: { filePaths: [resume] } })).rejects.toThrow('Only this role');
    await rm(resume);
    await mkdir(resume);
    await expect(client.callTool({ name: 'upload_file', arguments: { filePaths: [resume] } })).rejects.toThrow('Only this role');
    for (const filePaths of [[], ['resume.pdf'], [join(filesDir, 'missing.pdf')], [null]]) {
      await expect(client.callTool({ name: 'upload_file', arguments: { filePaths } })).rejects.toThrow();
    }
    expect(calls).toHaveLength(0);
  });

  it('supports a symlinked role directory while forwarding canonical PDF paths', async () => {
    const alias = join(home, 'role-link');
    await symlink(filesDir, alias);
    const { client, calls } = await connect({ assist: true, filesDir: alias });
    await client.callTool({ name: 'upload_file', arguments: { pageId: 7, uid: '7_3', filePaths: [join(alias, 'resume.pdf')] } });
    expect(calls[0]?.arguments?.filePaths).toEqual([join(filesDir, 'resume.pdf')]);
  });

  it('does not negotiate or forward downstream client roots, even after roots change', async () => {
    const { client, native, roots, calls } = await connect({ assist: true, filesDir });
    expect(native.getClientCapabilities()?.roots).toBeUndefined();
    await client.sendRootsListChanged();
    const outside = join(home, 'outside.pdf');
    await writeFile(outside, 'synthetic');
    await expect(client.callTool({ name: 'upload_file', arguments: { filePaths: [outside] } })).rejects.toThrow('Only this role');
    expect(roots).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('closes the upstream connection when the downstream client disconnects', async () => {
    const { client, native, adapter, calls } = await connect();
    const closed = vi.fn();
    native.onclose = closed;
    await client.close();
    await adapter.close();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0); // no close_page or browser control command is sent
  });

  it('cleans up the upstream transport if discovery fails', async () => {
    const native = new Server({ name: 'synthetic-failure', version: '1' }, { capabilities: { tools: {} } });
    native.setRequestHandler(ListToolsRequestSchema, async () => {
      throw new McpError(ErrorCode.InternalError, 'Synthetic discovery failure');
    });
    const closed = vi.fn();
    native.onclose = closed;
    const [upClient, upServer] = InMemoryTransport.createLinkedPair();
    await native.connect(upServer);
    await expect(createBrowserAdapter(upClient)).rejects.toThrow('Synthetic discovery failure');
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('closes a stalled initialization when shutdown is requested', async () => {
    const native = new Server({ name: 'synthetic-stall', version: '1' }, { capabilities: { tools: {} } });
    native.setRequestHandler(InitializeRequestSchema, () => new Promise<never>(() => {}));
    const closed = vi.fn();
    native.onclose = closed;
    const [upClient, upServer] = InMemoryTransport.createLinkedPair();
    await native.connect(upServer);
    const controller = new AbortController();
    const starting = createBrowserAdapter(upClient, {}, controller.signal);
    const rejected = expect(starting).rejects.toThrow();
    controller.abort();
    await rejected;
    expect(closed).toHaveBeenCalledTimes(1);
  });
});

describe('local browser startup', () => {
  async function runtimeFixture() {
    const runtime = runners.codexBrowserRuntime({ userHome: home, env: {} });
    await mkdir(dirname(runtime.bin), { recursive: true });
    await copyFile(runtime.manifestPath, join(runtime.dir, 'package.json'));
    await copyFile(runtime.lockfilePath, join(runtime.dir, 'pnpm-lock.yaml'));
    for (const path of runtime.patchPaths) {
      await mkdir(dirname(join(runtime.dir, path)), { recursive: true });
      await copyFile(join(runtime.manifestDir, path), join(runtime.dir, path));
    }
    await writeFile(join(runtime.dir, 'installed.json'), JSON.stringify({ fingerprint: runtime.fingerprint }));
    await writeFile(
      join(runtime.dir, 'node_modules/chrome-devtools-mcp/package.json'),
      JSON.stringify({ version: runtime.packageVersion }),
    );
    await writeFile(runtime.bin, '// synthetic runtime');
    return runtime;
  }

  it('uses absolute Node and the pinned local CLI without npm, npx, or network installation', async () => {
    const runtime = await runtimeFixture();
    const spec = browserServerParameters(runtime.dir, { assist: true, filesDir }, runtime);
    expect(spec.command).toMatch(/^\//);
    expect(spec.command).not.toMatch(/(?:npm|npx)$/);
    expect(spec.args).toEqual([
      runtime.bin,
      '--autoConnect',
      '--no-usage-statistics',
      '--no-performance-crux',
      '--no-javascript-evaluation',
      `--workspace=${filesDir}`,
    ]);
    expect(spec.cwd).toBe(runtime.dir);
    expect(browserServerParameters(runtime.dir, { filesDir }, runtime).args?.some((arg) => arg.startsWith('--workspace'))).toBe(false);
  });

  it('reports missing, incomplete, wrong-version and mismatched runtimes without installing', async () => {
    const runtime = await runtimeFixture();
    expect(() => browserServerParameters(join(home, 'different'), {}, runtime)).toThrow('pp setup --runner codex');
    await writeFile(join(runtime.dir, 'node_modules/chrome-devtools-mcp/package.json'), JSON.stringify({ version: '0.0.0' }));
    expect(() => browserServerParameters(runtime.dir, {}, runtime)).toThrow('pp setup --runner codex');
    await rm(join(runtime.dir, 'installed.json'));
    expect(() => browserServerParameters(runtime.dir, {}, runtime)).toThrow('pp setup --runner codex');
    await rm(runtime.dir, { recursive: true, force: true });
    expect(() => browserServerParameters(runtime.dir, {}, runtime)).toThrow('pp setup --runner codex');
  });

  it('reaps an actual synthetic stdio child when the adapter closes', async () => {
    const script = join(home, 'synthetic-mcp.mjs');
    const ended = join(home, 'ended.txt');
    await writeFile(
      script,
      `
      import readline from 'node:readline';
      import { writeFileSync } from 'node:fs';
      const lines = readline.createInterface({ input: process.stdin });
      lines.on('line', line => {
        const req = JSON.parse(line);
        if (req.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: req.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic', version: '1' } } }) + '\\n');
        if (req.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { tools: [] } }) + '\\n');
      });
      lines.on('close', () => { writeFileSync(process.argv[2], 'closed'); });
    `,
    );
    const transport = new StdioClientTransport({ command: process.execPath, args: [script, ended], cwd: home });
    let adapter: BrowserAdapter | undefined;
    try {
      adapter = await createBrowserAdapter(transport);
      const pid = transport.pid;
      expect(pid).toBeGreaterThan(0);
      await adapter.close();
      expect(await readFile(ended, 'utf8')).toBe('closed');
      expect(() => process.kill(pid as number, 0)).toThrow();
    } finally {
      await adapter?.close();
      await transport.close();
    }
  });
});
