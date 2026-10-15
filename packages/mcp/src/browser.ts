/**
 * A restricted MCP boundary between a headless run and the optional local Chrome runtime. It enforces the run's
 * browser policy (#161) whatever the runner's own config allows: its tools, its rendered-PDF uploads, its sites,
 * and only the pages it opened.
 */
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  CallToolResultSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { runners } from '@perfect-placement/engine';

export type BrowserRunPolicy = runners.BrowserRunPolicy;

export interface BrowserAdapter {
  server: Server;
  /** Disconnect the native server; an attached Chrome instance and its tabs stay open. */
  close(): Promise<void>;
}

/** Tools that act on one page (`pageId`); without one, the native server would act on the selected page. */
const PAGE_TOOLS = new Set(['navigate_page', 'take_snapshot', 'fill_form', 'upload_file']);

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

/** Validate every path before forwarding a single upload; client roots cannot extend the policy's list. */
async function uploadPaths(value: unknown, uploads: readonly string[]): Promise<string[]> {
  if (!Array.isArray(value) || !value.length) denied('upload_file requires rendered PDF paths');
  // Resolve each allowed file's folder, not the file: a symlink planted at resume.pdf must not allow its target.
  const allowed = new Set(
    await Promise.all(uploads.map(async (file) => join(await realpath(dirname(file)).catch(() => dirname(file)), basename(file)))),
  );
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

/** A web URL on one of the run's sites, or about:blank. */
function siteUrl(value: unknown, sites: readonly string[]): void {
  if (typeof value !== 'string') denied('Browser navigation requires an HTTP or HTTPS URL');
  let protocol = '';
  try {
    protocol = new URL(value).protocol;
  } catch {
    // reported below
  }
  if (value !== 'about:blank' && protocol !== 'http:' && protocol !== 'https:') denied('Browser navigation requires an HTTP or HTTPS URL');
  if (!runners.siteAllowed(value, sites)) denied(`site not allowed: ${new URL(value).hostname} is not one of this run's sites`);
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

interface NativePage {
  id: number;
  url: string;
}

/** The pages a native result lists (`--experimentalStructuredContent`), or null when it lists none. */
function pagesOf(result: CallToolResult): NativePage[] | null {
  const pages = (result.structuredContent as { pages?: unknown } | undefined)?.pages;
  if (!Array.isArray(pages)) return null;
  return pages.filter(
    (p): p is NativePage => typeof p === 'object' && p !== null && typeof p.id === 'number' && typeof (p as NativePage).url === 'string',
  );
}

/**
 * Show the run only its own pages: drop other pages from the structured list and from the text's `## Pages`
 * block (`<id>: <title or url>` lines), and say how many belong to the user.
 */
function ownPagesOnly(result: CallToolResult, owned: ReadonlySet<number>): CallToolResult {
  const pages = (result.structuredContent as { pages?: unknown } | undefined)?.pages;
  if (!Array.isArray(pages)) return result;
  const hidden = pages.filter((p) => !owned.has((p as NativePage).id)).length;
  const content = result.content.map((item) => {
    if (item.type !== 'text') return item;
    const out: string[] = [];
    let inPages = false;
    for (const line of item.text.split('\n')) {
      if (line === '## Pages') {
        inPages = true;
        out.push(line);
        continue;
      }
      const page = inPages ? /^(\d+): /.exec(line) : null;
      if (page) {
        if (owned.has(Number(page[1]))) out.push(line);
        continue;
      }
      if (inPages && hidden)
        out.push(
          `(${hidden} other ${hidden === 1 ? 'page belongs' : 'pages belong'} to the user and ${hidden === 1 ? 'is' : 'are'} not shown)`,
        );
      inPages = false;
      out.push(line);
    }
    if (inPages && hidden)
      out.push(
        `(${hidden} other ${hidden === 1 ? 'page belongs' : 'pages belong'} to the user and ${hidden === 1 ? 'is' : 'are'} not shown)`,
      );
    return { ...item, text: out.join('\n') };
  });
  return {
    ...result,
    content,
    structuredContent: { ...result.structuredContent, pages: pages.filter((p) => owned.has((p as NativePage).id)) },
  };
}

/**
 * The upstream transport is injectable so protocol, path, site and page checks run on synthetic servers.
 * The native client advertises no roots and never relays downstream roots or notifications.
 */
export async function createBrowserAdapter(
  upstreamTransport: Transport,
  policy: BrowserRunPolicy,
  signal?: AbortSignal,
): Promise<BrowserAdapter> {
  if (policy.uploads.some((file) => !isAbsolute(file))) denied('The rendered files must be absolute paths');
  const allowed = new Set(policy.tools);
  const upstream = new Client({ name: 'perfect-placement-browser', version: '0.1.0' }, { capabilities: {} });
  const server = new Server({ name: 'perfect-placement-browser', version: '0.1.0' }, { capabilities: { tools: { listChanged: false } } });
  /** Pages this run opened with new_page; the only ones it may see or act on. */
  const owned = new Set<number>();
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

  const call = async (name: string, args: Record<string, unknown>, callSignal?: AbortSignal) =>
    (await upstream.request({ method: 'tools/call', params: { name, arguments: args } }, CallToolResultSchema, {
      signal: callSignal,
    })) as CallToolResult;
  /** Every page the browser has open now, with its current URL. */
  const nativePages = async (callSignal?: AbortSignal): Promise<NativePage[]> => {
    const pages = pagesOf(await call('list_pages', {}, callSignal));
    if (!pages) denied('The browser did not report its pages; run pp setup --runner codex');
    return pages;
  };
  /** A page this run opened, still on one of its sites (a redirect may have left them). */
  const ownedPage = async (pageId: unknown, callSignal?: AbortSignal, checkSite = true): Promise<void> => {
    if (typeof pageId !== 'number' || !owned.has(pageId))
      denied('Use the pageId of a page this run opened with new_page; other pages belong to the user');
    if (!checkSite) return;
    const page = (await nativePages(callSignal)).find((p) => p.id === pageId);
    if (!page) denied(`Page ${pageId} is no longer open`);
    if (!runners.siteAllowed(page.url, policy.sites))
      denied(`site not allowed: page ${pageId} is now on ${new URL(page.url).hostname}, outside this run's sites`);
  };

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
      if (name === 'new_page' || (name === 'navigate_page' && Object.hasOwn(args, 'url'))) siteUrl(args.url, policy.sites);
      if (name === 'close_page') await ownedPage(args.pageId, extra.signal, false);
      // Navigating away from an off-site page is fine; reading or filling one is not.
      if (PAGE_TOOLS.has(name)) await ownedPage(args.pageId, extra.signal, name !== 'navigate_page');
      if (name === 'fill_form') fillValues(args.elements);
      if (name === 'upload_file') {
        if (!policy.uploads.length) denied('Uploads require a fill assist with rendered documents');
        args.filePaths = await uploadPaths(args.filePaths, policy.uploads);
      }
      const before = name === 'new_page' ? new Set((await nativePages(extra.signal)).map((p) => p.id)) : null;
      // Preserve native content and tool/protocol errors, including pageId/uid; only other pages are hidden.
      const result = (await upstream.request(
        { method: 'tools/call', params: { ...request.params, arguments: args } },
        CallToolResultSchema,
        {
          signal: extra.signal,
        },
      )) as CallToolResult;
      if (before && !result.isError) {
        for (const page of pagesOf(result) ?? (await nativePages(extra.signal))) if (!before.has(page.id)) owned.add(page.id);
      }
      if (name === 'close_page' && !result.isError) owned.delete(args.pageId as number);
      return ownPagesOnly(result, owned);
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
  policy: BrowserRunPolicy,
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
      // Page IDs and URLs as data, for the adapter's page and site checks (#161).
      '--experimentalStructuredContent',
      ...(policy.uploads.length ? [`--workspace=${dirname(policy.uploads[0] as string)}`] : []),
    ],
    cwd: runtime.dir,
    env,
    stderr: 'inherit',
  };
}

export async function startBrowserAdapter(runtimeDir: string, policy: BrowserRunPolicy, signal?: AbortSignal): Promise<BrowserAdapter> {
  return createBrowserAdapter(new StdioClientTransport(browserServerParameters(runtimeDir, policy)), policy, signal);
}
