import type { Skill } from '@perfect-placement/contracts';
import { type Capability, SKILL_GRANTS, skillCapabilities, usesBrowser } from './grants.js';
import { MCP_SERVER_NAME } from './mcp-server.js';
import type { PromptText } from './text.js';

/*
 * Claude Code's names for the capabilities in grants.ts (#159): what `--allowedTools` pre-approves and
 * `--disallowedTools` denies. Every other runner binds the same capabilities to its own names.
 */

/** Built-in web tools a skill may be granted (Claude Code names; see `SKILL_TOOLS`). */
export type WebTool = 'WebSearch' | 'WebFetch';

/** Claude Code's claude.ai Gmail connector tool name prefix. */
export const GMAIL_PREFIX = 'mcp__claude_ai_Gmail__';
/**
 * Gmail search and read tools (#37, #80): the inbox run classifies replies with them, a full `connect`
 * run finds contacts' addresses in threads and signatures. Nothing else in Gmail is read.
 */
export const GMAIL_READ_TOOLS = [`${GMAIL_PREFIX}search_threads`, `${GMAIL_PREFIX}get_thread`, `${GMAIL_PREFIX}get_message`] as const;
/** The one Gmail write a run may make: a draft (`connect` only; AGENTS.md rule 4: never send). */
export const GMAIL_DRAFT_TOOL = `${GMAIL_PREFIX}create_draft`;
/**
 * Every Gmail connector tool that changes the mailbox. A run that loads the connector denies all of
 * these except what its skill is granted (`connect`: `create_draft`; `inbox`: none).
 */
export const GMAIL_WRITE_TOOLS = [
  'send_message',
  'reply',
  'forward',
  'create_draft',
  'update_draft',
  'delete_draft',
  'trash_message',
  'trash_thread',
  'untrash_message',
  'untrash_thread',
  'mark_message_spam',
  'mark_thread_spam',
  'unmark_message_spam',
  'unmark_thread_spam',
  'label_message',
  'label_thread',
  'unlabel_message',
  'unlabel_thread',
  'update_message_labels',
  'apply_sensitive_message_label',
  'apply_sensitive_thread_label',
  'create_label',
  'update_label',
  'delete_label',
].map((t) => `${GMAIL_PREFIX}${t}`);
/** Gmail tools denied to a `connect` run and the Gmail draft step: every write but `create_draft`. */
export const GMAIL_DENIED_TOOLS = GMAIL_WRITE_TOOLS.filter((t) => t !== GMAIL_DRAFT_TOOL);
/**
 * The To update step (#99, `runs.start { skill: 'connect', outreach_id }` on an in-Gmail draft with no To,
 * once its address is confirmed): read the draft, then set its To. Only this step gets `update_draft`
 * (not in `SKILL_TOOLS.connect`); it never gets `create_draft`, send, reply, forward, trash, delete or labels.
 */
export const GMAIL_UPDATE_TOOL = `${GMAIL_PREFIX}update_draft`;
export const GMAIL_GET_DRAFT_TOOL = `${GMAIL_PREFIX}get_draft`;
/** Gmail tools denied to the To update step: every write but `update_draft`. */
export const GMAIL_TO_DENIED_TOOLS = GMAIL_WRITE_TOOLS.filter((t) => t !== GMAIL_UPDATE_TOOL);

/** Claude Code's Claude in Chrome tool name prefix (`--chrome`). */
export const CHROME_PREFIX = 'mcp__claude-in-chrome__';
/**
 * The Claude in Chrome tools a run may use to read a page: `connect` reads LinkedIn (#82, wave1-decisions #4, #6),
 * `fill` reads the application portal's questions on every tab and step (#81). Open a tab, navigate to a URL,
 * read its text or accessibility tree, find an element, close the run's own tabs (#107). No click, type, form input, script, upload or shortcut:
 * nothing that can send, connect, follow, like, fill a field or submit.
 */
export const CHROME_READ_TOOLS = [
  'tabs_context_mcp',
  'tabs_create_mcp',
  'tabs_close_mcp',
  'navigate',
  'get_page_text',
  'read_page',
  'find',
].map((t) => `${CHROME_PREFIX}${t}`);
/**
 * The tab tools (#107), part of `CHROME_READ_TOOLS`: see the session's tabs and reuse its tab (`tabs_context_mcp`),
 * create one only if none is usable (`tabs_create_mcp`), close the run's own tabs at the end (`tabs_close_mcp`).
 */
export const CHROME_TAB_TOOLS = ['tabs_context_mcp', 'tabs_create_mcp', 'tabs_close_mcp'].map((t) => `${CHROME_PREFIX}${t}`);
/**
 * Claude in Chrome tools that act on a page (or batch actions), denied to every run that could load them:
 * `computer` clicks and types (its screenshot action rides on it, so it goes too). With no safe click
 * tool, a fill run reaches other tabs and steps by navigating to their URLs (#81). The one exception is a
 * fill run with assist (#106): `FILL_ASSIST_TOOLS` only.
 */
export const CHROME_WRITE_TOOLS = [
  'computer',
  'form_input',
  'javascript_tool',
  'browser_batch',
  'file_upload',
  'upload_image',
  'shortcuts_execute',
  'gif_creator',
].map((t) => `${CHROME_PREFIX}${t}`);
/**
 * The fill assist (#106, `runs.start { skill: 'fill', assist: true }`): set a field's value (`form_input`) and
 * upload the rendered PDFs (`file_upload`). Neither clicks, presses a key or runs script, so neither can press
 * Submit; `computer`, `javascript_tool`, `browser_batch` and `shortcuts_execute` stay denied, and
 * `apply.fill_done` refuses a report that filled a submit-like control. Granted to `fill` only.
 */
export const FILL_ASSIST_TOOLS = ['form_input', 'file_upload'].map((t) => `${CHROME_PREFIX}${t}`);
/** Built-in tools a Chrome run denies outright (`connect`'s built-ins are not narrowed with `--tools`). */
export const BUILTIN_WRITE_TOOLS = ['Bash', 'Write', 'Edit', 'NotebookEdit'] as const;

/** Claude Code's tool for each capability. */
export const CLAUDE_TOOL: Readonly<Record<Capability, string>> = {
  'web.search': 'WebSearch',
  'web.fetch': 'WebFetch',
  'gmail.search': `${GMAIL_PREFIX}search_threads`,
  'gmail.thread': `${GMAIL_PREFIX}get_thread`,
  'gmail.message': `${GMAIL_PREFIX}get_message`,
  'gmail.create_draft': GMAIL_DRAFT_TOOL,
  'gmail.get_draft': GMAIL_GET_DRAFT_TOOL,
  'gmail.update_draft': GMAIL_UPDATE_TOOL,
  'browser.tabs': `${CHROME_PREFIX}tabs_context_mcp`,
  'browser.new_tab': `${CHROME_PREFIX}tabs_create_mcp`,
  'browser.close_tab': `${CHROME_PREFIX}tabs_close_mcp`,
  'browser.navigate': `${CHROME_PREFIX}navigate`,
  'browser.text': `${CHROME_PREFIX}get_page_text`,
  'browser.tree': `${CHROME_PREFIX}read_page`,
  'browser.find': `${CHROME_PREFIX}find`,
  'browser.fill': `${CHROME_PREFIX}form_input`,
  'browser.upload': `${CHROME_PREFIX}file_upload`,
};

/**
 * `SKILL_GRANTS` in Claude Code's names (#20): every run gets the pp MCP tools, then its web, Gmail and Claude in
 * Chrome tools. Each SKILL.md's `## Tools` section, rendered for Claude, lists the same (runner.test.ts checks).
 */
export const SKILL_TOOLS: Readonly<
  Record<Skill, { web: readonly WebTool[]; gmail: readonly string[]; chrome?: readonly string[]; why: string }>
> = Object.fromEntries(
  Object.entries(SKILL_GRANTS).map(([skill, g]) => [
    skill,
    {
      web: g.web.map((c) => CLAUDE_TOOL[c] as WebTool),
      gmail: g.gmail.map((c) => CLAUDE_TOOL[c]),
      ...(g.browser ? { chrome: g.browser.map((c) => CLAUDE_TOOL[c]) } : {}),
      why: g.why,
    },
  ]),
) as unknown as Record<Skill, { web: readonly WebTool[]; gmail: readonly string[]; chrome?: readonly string[]; why: string }>;

/**
 * Claude Code tool names a skill's headless run pre-approves. For `connect` and `voice`, `linkedin: false`
 * (config.linkedin.mode is not `live`) drops the Chrome tools. For `fill`, `assist: false` (a run without the
 * fill assist, #106) drops `FILL_ASSIST_TOOLS`: it only reads the portal. Default: the skill's full list.
 */
export function skillAllowedTools(skill: Skill, opts: { linkedin?: boolean; assist?: boolean } = {}): string[] {
  return [`mcp__${MCP_SERVER_NAME}`, ...skillCapabilities(skill, opts).map((c) => CLAUDE_TOOL[c])];
}

/** Does this skill's run load Claude in Chrome (`--chrome`)? `connect` and `voice` only when LinkedIn is live; `fill` always (#81). */
export const usesChrome = usesBrowser;

/** A claude.ai connector tool (Gmail) or a Claude in Chrome tool: these load with the session and can be late (#122). */
export const isConnectorTool = (t: string): boolean => t.startsWith(GMAIL_PREFIX) || t.startsWith(CHROME_PREFIX);

/** Claude Code's text for every placeholder (#159): its tool names and how its connectors load and retry. */
export const CLAUDE_TEXT: PromptText = {
  ...(Object.fromEntries(
    (Object.keys(CLAUDE_TOOL) as Capability[]).flatMap((c) => [
      // Prose names the browser tools without the Claude in Chrome prefix; Gmail and web tools by their full name.
      [c, CLAUDE_TOOL[c].replace(CHROME_PREFIX, '')],
      [`tool:${c}`, CLAUDE_TOOL[c]],
    ]),
  ) as Record<Capability | `tool:${Capability}`, string>),
  'tool:pp': 'mcp__pp',
  'browser.name': 'Claude in Chrome',
  'browser.none': 'No Chrome tools in this session (Codex, Cursor, no extension)',
  'browser.read': '`get_page_text` and `read_page`',
  'browser.locate': '`find` / `read_page`',
  'browser.locate_plain': 'find / read_page',
  'browser.upload_paths': 'paths',
  'browser.files_access': '`--add-dir`',
  'connector.tools':
    'A Gmail or Claude in Chrome tool from this list that is not available in the session at all (the connector did not load; not a denial) is reported as `runs.finish { run_id, status: "error", error_code: "connector_unavailable", error: "connector_unavailable: <tool>" }` before doing anything else: the engine retries the run once about 45 s later (#122).',
  'connector.missing':
    'If a Gmail or Claude in Chrome tool listed above is not available in this session at all (not loaded, as opposed to denied), do nothing else and finish with runs.finish { run_id: "{{run_id}}", status: "error", error_code: "connector_unavailable", error: "connector_unavailable: <tool>" }. The engine retries the run once a little later.',
  'connector.not_loaded': 'not loaded in this session: finish with `error_code: "connector_unavailable"` (Tools below)',
  'missing.error': 'error_code: "connector_unavailable", error: "connector_unavailable: ',
  'missing.retry_step': ' (the engine retries the step once a little later)',
  'gmail.draft_tool': "Claude Code: the Gmail connector's create_draft",
  'gmail.source':
    'Claude Code uses the claude.ai Gmail connector (`mcp__claude_ai_Gmail__create_draft`); Codex and Cursor need their own Gmail MCP server configured for this step.',
  'gmail.connector_note': " (Claude Code's claude.ai Gmail connector)",
  'gmail.other_clients':
    ' Other MCP clients (Codex, Cursor) use the search and read tools of the Gmail MCP server the user configured for them.',
  'connect.draft_retry':
    '; the engine retries the step once, and never when the outreach already has a `gmail_draft_id` or its `outreach.to_gmail` waits in Needs you (#122).',
  'connect.tools_note':
    'The Chrome tools load with `--chrome` only when `config.linkedin.mode` is `live` (`off` or `dry-run`: no Chrome, report `skipped`). Every Chrome tool that clicks, types, fills a form, runs script, uploads or records (`computer`, `form_input`, `javascript_tool`, `browser_batch`, ...) is denied, as are Bash and file writes. Every other Gmail write (send, reply, forward, draft update / delete, trash, spam, labels) is denied. Other MCP clients (Codex, Cursor) use the Gmail MCP server the user configured for them and have no Chrome: they report `skipped: "no_browser"`.',
  'fill.tools_note':
    'A run without the fill assist does not get `form_input` or `file_upload` (they are denied with the other acting tools). Denied outright (`--disallowedTools`): every other Chrome tool that acts on a page (`computer` clicks and types, `javascript_tool`, `upload_image`, `browser_batch`, `shortcuts_execute`, `gif_creator`), every Gmail write, and Bash / Write / Edit. Codex and Cursor have no Chrome: they read with WebFetch, or answer the pasted questions; no fill assist.',
  'voice.tools_note':
    'The Chrome tools load with `--chrome` only when `config.linkedin.mode` is `live`. Every Gmail write (send, reply, forward, drafts, trash, spam, labels) and every Chrome tool that clicks, types, fills a form, runs script or uploads is denied, as are Bash and file writes.',
  'fill.missing':
    'A tool missing (Codex, Cursor, or a denied Chrome tool): do not work around it; finish as error with the tool named, the Answers stay saved. Claude in Chrome granted but not loaded in this session: `error_code: "connector_unavailable"` (Tools below); the engine retries once.',
};
