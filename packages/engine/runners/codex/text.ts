import { type Capability, GMAIL_STEP_CAPS, skillCapabilities } from '../grants.js';
import { type PromptText, renderText } from '../text.js';
import type { GrantRequest, PreambleContext } from '../types.js';
import { CODEX_BROWSER_SERVER } from './connectors.js';

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
  'browser.tabs': 'list_pages',
  'browser.new_tab': 'new_page',
  'browser.close_tab': 'close_page',
  'browser.navigate': 'navigate_page',
  'browser.text': 'take_snapshot',
  'browser.tree': 'take_snapshot',
  'browser.find': 'take_snapshot',
  'browser.fill': 'fill_form',
  'browser.upload': 'upload_file',
};

const fullName = (c: Capability): string => (c.startsWith('browser.') ? `mcp__${CODEX_BROWSER_SERVER}__${CODEX_TOOL[c]}` : CODEX_TOOL[c]);

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

/** Codex's grants: the skill's, or a Gmail step's; `upload_file` only when the engine rendered the PDFs (#157). */
export function codexGrants(g: GrantRequest): Capability[] {
  if (g.mode && g.mode !== 'skill') return [...GMAIL_STEP_CAPS[g.mode]];
  return skillCapabilities(g.skill, { linkedin: g.linkedin !== false, assist: g.assist === true }).filter(
    (c) => c !== 'browser.upload' || g.uploadsReady === true,
  );
}

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
  const gmail = p.caps.filter((c) => c.startsWith('gmail.')).map((c) => CODEX_TOOL[c]);
  const browserCaps = p.caps.filter((c) => c.startsWith('browser.'));
  const browser = unique(browserCaps.map(fullName));
  const uploads = browserCaps.includes('browser.upload');
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
    ...(gmail.length || browser.length
      ? [
          '## Codex tool bindings',
          '',
          ...(gmail.length
            ? [
                `Allowed Gmail capabilities: ${gmail.join(', ')}. These labels describe capabilities, not literal tool names. Inspect this session's connected Gmail tools (use tool discovery when available) and call their actual names and schemas. Never look for a claude.ai tool or infer an address from a missing mailbox connection.`,
                'Gmail is read-only except for the draft operation explicitly granted here. Never send, reply, forward, delete, trash, label or change mailbox settings. A recipient must satisfy the PP email confirmation rules before creating a draft.',
              ]
            : []),
          ...(browser.length
            ? [
                `Browser: Chrome DevTools MCP, server ${CODEX_BROWSER_SERVER}. Allowed tools: ${browser.join(', ')}.`,
                'If browser tools are missing, report the setup remedy: run pp setup --runner codex. Chrome must be running with remote debugging enabled at chrome://inspect/#remote-debugging, and the user must allow the connection request. Never install packages or change browser settings from the run.',
                'First list pages. Existing pages belong to the user: never navigate, fill or close them. Create one run-owned page at the required URL with new_page; reuse that pageId for this run. Read with take_snapshot and locate elements and links in its returned text. Navigate only by URL with navigate_page. Never write a snapshot to a file.',
                'Use the actual tool schemas: pageId is the page identifier; uid comes from take_snapshot. There is no separate find or page-text tool. new_page takes a URL; close_page takes the owned pageId. Report page IDs as tabs on runs.finish.',
                ...(p.assist
                  ? [
                      'Fill assist: fill_form takes elements: [{ uid, value }] and pageId. Only fill answer inputs, selects, checkboxes and radios; never a Submit, Apply, Send, Next or Finish control. No click, key, script or submit tools are granted.',
                      uploads
                        ? 'upload_file takes uid, filePaths: ["<absolute rendered PDF path>"], and pageId. The PP browser adapter permits only the rendered resume.pdf and cover_letter.pdf named by PP. Use an actual file input, never a chooser-opening button.'
                        : 'Uploads are unavailable: no rendered-files directory was supplied. Keep the form filling, report both documents as skipped, and do not render or attempt uploads.',
                      'Leave the filled, run-owned portal page open for the user to review and submit. Close only other pages this run created. Never submit an application.',
                    ]
                  : [
                      'Read-only browser work: no field filling, uploads, clicks, key presses or scripts. Close only pages this run created when finished.',
                    ]),
              ]
            : ['No browser is granted for this run. Do not use browser tools.']),
          renderText('{{connector.missing}}', CODEX_TEXT, { runId: p.runId }),
          '',
        ]
      : []),
  ];
}
