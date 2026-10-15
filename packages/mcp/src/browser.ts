/** A restricted MCP boundary between a Codex run and the optional local Chrome runtime. */
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { runners } from '@perfect-placement/engine';

export interface BrowserOptions {
  assist?: boolean;
  /** Only the two rendered PDFs in this directory can be uploaded. */
  filesDir?: string;
}

export interface BrowserAdapter {
  server: Server;
  /** Disconnect the native server; an attached Chrome instance and its tabs stay open. */
  close(): Promise<void>;
}

const PDF_NAMES = ['resume.pdf', 'cover_letter.pdf'] as const;

function denied(message: string): never {
  throw new McpError(ErrorCode.InvalidParams, message);
}

function restrictedSchema(tool: Tool): Tool {
  const remove = tool.name === 'take_snapshot' ? ['filePath'] : tool.name === 'navigate_page' ? ['initScript'] : [];
  if (!remove.length) return tool;
  const properties = { ...tool.inputSchema.properties };
  for (const name of remove) delete properties[name];
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties,
      ...(tool.inputSchema.required ? { required: tool.inputSchema.required.filter((name) => !remove.includes(name)) } : {}),
    },
  };
}

/** Validate every path before forwarding a single upload; client roots cannot extend this list. */
async function uploadPaths(value: unknown, filesDir: string): Promise<string[]> {
  if (!Array.isArray(value) || !value.length) denied('upload_file requires rendered PDF paths');
  const root = await realpath(filesDir);
  const allowed = new Set(PDF_NAMES.map((name) => join(root, name)));
  return Promise.all(
    value.map(async (file: unknown) => {
      if (typeof file !== 'string' || !isAbsolute(file)) denied('Only absolute rendered PDF paths can be uploaded');
      const canonical = await realpath(file);
      if (!allowed.has(canonical) || !(await stat(canonical)).isFile())
        denied('Only this role’s rendered resume.pdf and cover_letter.pdf can be uploaded');
      return canonical;
    }),
  );
}

function webUrl(value: unknown): void {
  if (typeof value !== 'string') denied('Browser navigation requires an HTTP or HTTPS URL');
  if (value === 'about:blank') return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    denied('Browser navigation requires an HTTP or HTTPS URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') denied('Browser navigation requires an HTTP or HTTPS URL');
}

/**
 * Native fill_form types values shorter than Puppeteer's typing threshold (100) as keystrokes, and a
 * control character there is a key press: a line break is Enter (submits a single-line field's form),
 * Tab moves focus to the next control. Longer values are set directly, without key events.
 */
const TYPED_VALUE_LIMIT = 100;
function fillValues(elements: unknown): void {
  if (!Array.isArray(elements)) return; // the native schema rejects it
  for (const element of elements) {
    const value = (element as { value?: unknown } | null)?.value;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is rejected
    if (typeof value === 'string' && value.length < TYPED_VALUE_LIMIT && /[\u0000-\u001f\u007f]/.test(value))
      denied('Short fill values cannot contain line breaks, tabs or other control characters; they would be typed as key presses');
  }
}

/**
 * The upstream transport is injectable so protocol and path checks run on synthetic servers.
 * The native client advertises no roots and never relays downstream roots or notifications.
 */
export async function createBrowserAdapter(
  upstreamTransport: Transport,
  options: BrowserOptions = {},
  signal?: AbortSignal,
): Promise<BrowserAdapter> {
  if (options.filesDir && !isAbsolute(options.filesDir)) denied('The rendered files directory must be absolute');
  const filesDir = options.assist ? options.filesDir : undefined;
  const allowed = new Set(runners.codexBrowserTools(options.assist === true, Boolean(filesDir)));
  const upstream = new Client({ name: 'perfect-placement-browser', version: '0.1.0' }, { capabilities: {} });
  const server = new Server({ name: 'perfect-placement-browser', version: '0.1.0' }, { capabilities: { tools: { listChanged: false } } });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= Promise.resolve().then(async () => {
      signal?.removeEventListener('abort', abort);
      await Promise.allSettled([server.close(), upstream.close()]);
    });
    return closing;
  };
  const abort = () => void close();
  server.onclose = () => void close();
  upstream.onclose = () => void close();

  try {
    signal?.throwIfAborted();
    signal?.addEventListener('abort', abort, { once: true });
    await upstream.connect(upstreamTransport, { signal });
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const result = await upstream.listTools(cursor ? { cursor } : undefined, { signal });
      tools.push(...result.tools.filter((tool) => allowed.has(tool.name)).map(restrictedSchema));
      cursor = result.nextCursor;
    } while (cursor);
    const available = new Set(tools.map((tool) => tool.name));
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name } = request.params;
      if (!allowed.has(name) || !available.has(name)) denied(`Browser tool is not allowed: ${name}`);
      const args = { ...request.params.arguments };
      // Check calls too: a caller can ignore the filtered JSON schema.
      if (name === 'take_snapshot' && Object.hasOwn(args, 'filePath')) denied('Snapshots must be returned inline');
      if (name === 'navigate_page' && Object.hasOwn(args, 'initScript')) denied('Navigation scripts are not allowed');
      if (name === 'new_page' || (name === 'navigate_page' && Object.hasOwn(args, 'url'))) webUrl(args.url);
      if (name === 'fill_form') fillValues(args.elements);
      if (name === 'upload_file') {
        if (!filesDir) denied('Uploads require a fill assist with rendered documents');
        args.filePaths = await uploadPaths(args.filePaths, filesDir);
      }
      // Preserve native content, structured output and tool/protocol errors, including pageId/uid.
      return upstream.request({ method: 'tools/call', params: { ...request.params, arguments: args } }, CallToolResultSchema, {
        signal: extra.signal,
      });
    });
    return { server, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Build a local-only launch specification. Installation belongs to pp setup, never a run. */
export function browserServerParameters(
  runtimeDir: string,
  options: BrowserOptions = {},
  runtime = runners.codexBrowserRuntime(),
): StdioServerParameters {
  if (!isAbsolute(runtimeDir) || resolve(runtimeDir) !== resolve(runtime.dir))
    throw new Error(`Unexpected Codex browser runtime. ${runners.CODEX_BROWSER_SETUP}`);
  const readiness = runners.codexBrowserReadiness(runtime);
  if (!readiness.ok) throw new Error(readiness.detail);
  if (!runners.codexBrowserNodeCompatible(process.version))
    throw new Error(
      'Codex browser support needs Node 22.12 or newer. Upgrade Node, rerun ./install.sh with the upgraded Node to refresh the pinned launchers, then run pp setup --runner codex',
    );
  const command = runners.stableNodePath();
  if (!isAbsolute(command)) throw new Error('The Codex browser requires an absolute Node executable');
  const env = { ...getDefaultEnvironment(), ...runners.codexBrowserEnvironment(process.env) };
  return {
    command,
    args: [
      runtime.bin,
      '--autoConnect',
      '--no-usage-statistics',
      '--no-performance-crux',
      '--no-javascript-evaluation',
      ...(options.assist && options.filesDir ? [`--workspace=${options.filesDir}`] : []),
    ],
    cwd: runtime.dir,
    env,
    stderr: 'inherit',
  };
}

export async function startBrowserAdapter(runtimeDir: string, options: BrowserOptions = {}, signal?: AbortSignal): Promise<BrowserAdapter> {
  return createBrowserAdapter(new StdioClientTransport(browserServerParameters(runtimeDir, options)), options, signal);
}
