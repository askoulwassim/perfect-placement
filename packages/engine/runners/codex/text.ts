import { adapterBindings, adapterGrants } from '../browser/bindings.js';
import { ADAPTER_TOOL, BROWSER_SERVER } from '../browser/policy.js';
import type { Capability } from '../grants.js';
import { type PromptText, renderText } from '../text.js';
import type { PreambleContext } from '../types.js';

/*
 * Codex's names and text for every capability and placeholder (#159). Web is the built-in web tool's actions; the
 * browser is PP's Chrome DevTools adapter (`pp_browser`, #157); Gmail is whatever Gmail app or MCP server the user
 * connected, so it is named by capability and the session finds the actual tools.
 */

/** Codex's tool (or Gmail capability label) for each capability. */
export const CODEX_TOOL: Readonly<Record<Capability, string>> = {
  'web.search': 'web.run search',
  'web.fetch': 'web.run open',
  'gmail.search': 'Gmail search',
  'gmail.thread': 'Gmail read thread',
  'gmail.message': 'Gmail read message',
  'gmail.create_draft': 'Gmail create draft',
  'gmail.get_draft': 'Gmail read draft',
  'gmail.update_draft': 'Gmail update draft recipient',
  // The PP browser adapter's tools (#161).
  ...ADAPTER_TOOL,
};

const fullName = (c: Capability): string => (c.startsWith('browser.') ? `mcp__${BROWSER_SERVER}__${CODEX_TOOL[c]}` : CODEX_TOOL[c]);

export const CODEX_TEXT: PromptText = {
  ...(Object.fromEntries(
    (Object.keys(CODEX_TOOL) as Capability[]).flatMap((c) => [
      [c, CODEX_TOOL[c]],
      [`tool:${c}`, fullName(c)],
    ]),
  ) as Record<Capability | `tool:${Capability}`, string>),
  'tool:pp': 'pp',
  'browser.name': 'Chrome DevTools',
  'browser.none': 'No browser connection in this session',
  'browser.read': '`take_snapshot`',
  'browser.locate': '`take_snapshot`',
  'browser.locate_plain': 'take_snapshot',
  'browser.upload_paths': 'filePaths',
  'browser.files_access': "the PP browser adapter's rendered-file allowlist",
  'connector.tools':
    'A Gmail capability or browser connection from this list that is not set up in this session is reported as `runs.finish { run_id, status: "error", error: "setup required: <capability>", note: "<the connection needed>" }` before doing anything else; it is not retried automatically.',
  'connector.missing':
    'If a required Gmail capability is not connected or the browser cannot connect, finish with runs.finish { run_id: "{{run_id}}", status: "error", error: "setup required: <capability>", note: "<the connection needed>" }. Do not report connector_unavailable for missing setup. If an actual call is denied, follow the tool-denied rule; never work around it.',
  'connector.not_loaded': 'not connected in this session: finish with `error: "setup required: <capability>"` (Tools below)',
  'missing.error': 'error: "setup required: ',
  'missing.retry_step': '',
  'gmail.draft_tool': 'Gmail create draft',
  'gmail.source': 'use the Gmail app or MCP server connected to this runner (its `Gmail create draft` capability).',
  'gmail.connector_note': ' (the Gmail app or MCP server connected to this runner)',
  'gmail.other_clients': '',
  'connect.draft_retry': '; it is not retried: Gmail needs connecting for this runner first, then the step can run again.',
  'connect.tools_note':
    'The browser tools are available only when `config.linkedin.mode` is `live` (`off` or `dry-run`: no browser, report `skipped`). The PP browser adapter has no click, key, form, script or upload tool for this run. Gmail is read-only here except the draft: never send, reply, forward, update or delete a draft, trash, mark spam or label.',
  'fill.tools_note':
    'A run without the fill assist cannot fill fields or upload, and a fill assist uploads only when the engine rendered the PDFs. The PP browser adapter has no click, key, script or dialog tool, and this run has no Gmail.',
  'voice.tools_note':
    'The browser tools are available only when `config.linkedin.mode` is `live`. Gmail is read-only here, and the PP browser adapter has no click, key, form, script or upload tool for this run.',
  'fill.missing':
    'A required browser tool missing or denied: do not work around it; finish as error with the tool named, the Answers stay saved. A browser connection that needs setup is reported as setup required; do not retry it automatically.',
};

/** Codex's grants: the adapter's (#157, #161). */
export const codexGrants = adapterGrants;

const unique = (names: readonly string[]): string[] => [...new Set(names)];

/** The prompt's Tools line in Codex's names: web actions, browser tools, then Gmail capabilities. */
export function codexToolsPhrase(caps: readonly Capability[]): string {
  const web = caps.filter((c) => c.startsWith('web.')).map((c) => CODEX_TOOL[c]);
  const browser = unique(caps.filter((c) => c.startsWith('browser.')).map(fullName));
  const gmail = caps.filter((c) => c.startsWith('gmail.')).map((c) => CODEX_TOOL[c]);
  return `${web.length ? ` and ${web.join(', ')}` : ''}${browser.length ? ` and ${browser.join(', ')}` : ''}${gmail.length ? ` and connected Gmail capabilities (${gmail.join(', ')})` : ''}`;
}

/** What Codex reads before the skill: how its web tool works, then its Gmail and browser bindings for this run. */
export function codexPreamble(p: PreambleContext): string[] {
  const web = p.caps.filter((c) => c.startsWith('web.'));
  return [
    ...(web.length
      ? [
          'Codex web tools: use the built-in web tool (web.run) for the web actions below. Its open action fetches a URL; click and find read linked pages and page content. These are actions of one tool, not separate tools to discover.',
          web.includes('web.search')
            ? 'Web search queries and page retrieval are allowed for this skill.'
            : 'Only page retrieval is allowed for this skill; do not run web search queries.',
          'If the built-in web tool is actually unavailable or a call is denied, follow the missing-tool rule. Do not use shell commands, file tools or another connector as a fallback.',
          '',
        ]
      : []),
    ...adapterBindings(p, {
      heading: '## Codex tool bindings',
      browserTool: fullName,
      gmailLabel: (c) => CODEX_TOOL[c],
      setup: 'pp setup --runner codex',
      missing: renderText('{{connector.missing}}', CODEX_TEXT, { runId: p.runId }),
    }),
  ];
}
