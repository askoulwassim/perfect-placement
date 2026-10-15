import type { Skill } from '@perfect-placement/contracts';
import { MCP_SERVER_NAME } from './mcp-server.js';

/*
 * What each skill's headless run may use (#20). The names are Claude Code's; the other runners bind them
 * to their own tools (codex/connectors.ts). #159 turns these into runner-neutral capabilities.
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

/**
 * The single per-skill tool allowlist for headless runs (#20). Every run gets the pp MCP tools; web
 * tools only where the SKILL.md needs them; Gmail connector tools only for `inbox` (search + read,
 * #80) and `connect` (search + read + create_draft, #37, #79). Nothing else (no Bash, no Write/Edit,
 * no file reads): every read and write goes through ops. The names here are the Claude binding;
 * codex/connectors.ts binds browser actions to Chrome DevTools and Gmail to connected capabilities.
 * Chrome read tools only for `connect` (LinkedIn,
 * #82) and `fill` (the portal's questions, #81). Each SKILL.md declares the same list in its `## Tools` section (runner.test.ts checks they match).
 */
export const SKILL_TOOLS: Readonly<
  Record<Skill, { web: readonly WebTool[]; gmail: readonly string[]; chrome?: readonly string[]; why: string }>
> = {
  scout: { web: ['WebSearch', 'WebFetch'], gmail: [], why: 'runs the plan.md queries on job boards and career pages, reads each posting' },
  research: { web: ['WebSearch', 'WebFetch'], gmail: [], why: 'builds a sourced, dated company dossier from the web' },
  freshness: { web: ['WebSearch', 'WebFetch'], gmail: [], why: 'judges unsure postings from the live page when asked' },
  tailor: { web: ['WebFetch'], gmail: [], why: 'captures the full JD from the posting when only a title is on file' },
  score: { web: ['WebFetch'], gmail: [], why: 'captures the full JD from the posting when only a title is on file' },
  fill: {
    web: ['WebFetch'],
    gmail: [],
    chrome: [...CHROME_READ_TOOLS, ...FILL_ASSIST_TOOLS],
    why: 'reads the real portal questions on every tab and step via Claude in Chrome (--chrome, read + navigate tools, #81); with assist (#106) uploads the rendered PDFs and fills answer fields (form_input, file_upload; no click, key or script), stops before Submit; WebFetch for a plain posting page',
  },
  inbox: { web: [], gmail: GMAIL_READ_TOOLS, why: 'Gmail search + read (read-only) to classify replies, plus ops' },
  learn: { web: [], gmail: [], why: 'ops only' },
  voice: {
    web: [],
    gmail: GMAIL_READ_TOOLS,
    chrome: CHROME_READ_TOOLS,
    why: "Learn voice (#76): the user's own sent Gmail (search + read, read-only) and, when LinkedIn is live, their LinkedIn posts via Claude in Chrome (read + navigate tools only); proposes the Voice with profile.propose_voice",
  },
  onboard: {
    web: [],
    gmail: [],
    why: 'ops only: reads the kept resume with vault.read, writes the extraction with onboard.extract, follow-ups with onboard.propose_questions',
  },
  connect: {
    web: [],
    gmail: [...GMAIL_READ_TOOLS, GMAIL_DRAFT_TOOL],
    chrome: CHROME_READ_TOOLS,
    why: 'LinkedIn read-only via Claude in Chrome (--chrome, read + navigate tools only, #82); Gmail search + read for contact emails (#37); Gmail create_draft to finish the draft (#79)',
  },
};

/**
 * Claude Code tool names a skill's headless run pre-approves. For `connect` and `voice`, `linkedin: false`
 * (config.linkedin.mode is not `live`) drops the Chrome tools. For `fill`, `assist: false` (a run without the
 * fill assist, #106) drops `FILL_ASSIST_TOOLS`: it only reads the portal. Default: the skill's full list.
 */
export function skillAllowedTools(skill: Skill, opts: { linkedin?: boolean; assist?: boolean } = {}): string[] {
  const t = SKILL_TOOLS[skill];
  const chrome = usesChrome(skill, opts.linkedin !== false) ? (t.chrome ?? []) : [];
  return [
    `mcp__${MCP_SERVER_NAME}`,
    ...t.web,
    ...t.gmail,
    ...(opts.assist === false ? chrome.filter((x) => !FILL_ASSIST_TOOLS.includes(x)) : chrome),
  ];
}

/** Skills whose Chrome use is reading LinkedIn: on only when config.linkedin.mode is `live` (#82, #76). */
export const LINKEDIN_SKILLS: readonly Skill[] = ['connect', 'voice'];

/** Does this skill's run use Claude in Chrome? `connect` and `voice` only when LinkedIn is live; `fill` always (#81). */
export const usesChrome = (skill: Skill, linkedin = true): boolean =>
  (!LINKEDIN_SKILLS.includes(skill) || linkedin) && (SKILL_TOOLS[skill].chrome?.length ?? 0) > 0;

/** A claude.ai connector tool (Gmail) or a Claude in Chrome tool: these load with the session and can be late (#122). */
export const isConnectorTool = (t: string): boolean => t.startsWith(GMAIL_PREFIX) || t.startsWith(CHROME_PREFIX);

/** Skills granted a connector tool (#122): inbox, connect, voice (Gmail); connect, fill, voice (Chrome). */
export const CONNECTOR_SKILLS: readonly Skill[] = (Object.keys(SKILL_TOOLS) as Skill[]).filter((s) =>
  [...SKILL_TOOLS[s].gmail, ...(SKILL_TOOLS[s].chrome ?? [])].some(isConnectorTool),
);
