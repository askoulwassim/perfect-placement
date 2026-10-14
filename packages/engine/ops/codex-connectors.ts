/** Codex's browser adapter. Only these tools are exposed to a headless PP run. */
export const CODEX_BROWSER_SERVER = 'pp_browser';
export const CODEX_BROWSER_READ_TOOLS = ['list_pages', 'new_page', 'close_page', 'navigate_page', 'take_snapshot'] as const;
export const CODEX_BROWSER_FILL_TOOLS = ['fill_form', 'upload_file'] as const;

export interface CodexConnectors {
  runId: string;
  browser: boolean;
  assist: boolean;
  gmail: readonly string[];
  web: readonly string[];
}

export function codexBrowserTools(assist: boolean): string[] {
  return [...CODEX_BROWSER_READ_TOOLS, ...(assist ? CODEX_BROWSER_FILL_TOOLS : [])];
}

/** CLI overrides, scoped to the child run. Runner args can select a different browser connection. */
export function codexBrowserArgs(assist: boolean, filesDir?: string): string[] {
  const prefix = `mcp_servers.${CODEX_BROWSER_SERVER}`;
  return [
    `${prefix}.command="npx"`,
    `${prefix}.args=${JSON.stringify([
      '--yes',
      'chrome-devtools-mcp@1.10.1',
      '--autoConnect',
      '--no-usage-statistics',
      '--no-performance-crux',
      '--no-javascript-evaluation',
      ...(assist && filesDir ? [`--workspace=${filesDir}`] : []),
    ])}`,
    `${prefix}.enabled=true`,
    `${prefix}.enabled_tools=${JSON.stringify(codexBrowserTools(assist))}`,
    `${prefix}.default_tools_approval_mode="approve"`,
    `${prefix}.startup_timeout_sec=60`,
  ].flatMap((setting) => ['-c', setting]);
}

const GMAIL_CAPABILITIES: Readonly<Record<string, string>> = {
  search_threads: 'Gmail search',
  get_thread: 'Gmail read thread',
  get_message: 'Gmail read message',
  create_draft: 'Gmail create draft',
  get_draft: 'Gmail read draft',
  update_draft: 'Gmail update draft recipient',
};

const BROWSER_ALIASES: Readonly<Record<string, string>> = {
  tabs_context_mcp: 'list_pages',
  tabs_create_mcp: 'new_page',
  tabs_close_mcp: 'close_page',
  navigate: 'navigate_page',
  get_page_text: 'take_snapshot',
  read_page: 'take_snapshot',
  find: 'take_snapshot',
  form_input: 'fill_form',
  file_upload: 'upload_file',
};

/**
 * Shared skills describe the workflow using Claude connector names. Bind those references to
 * Codex's browser tools and Gmail capabilities, without inventing a Gmail server/tool name.
 * Missing setup is not a transient Claude connector failure and must not trigger its retry loop.
 */
export function codexConnectorPrompt(prompt: string, c: CodexConnectors): string {
  if (!c.browser && !c.gmail.length && !/mcp__claude|Claude in Chrome/.test(prompt)) return prompt;
  const gmail = c.gmail.map((name) => GMAIL_CAPABILITIES[name.replace('mcp__claude_ai_Gmail__', '')] ?? name);
  const browser = c.browser ? codexBrowserTools(c.assist).map((name) => `mcp__${CODEX_BROWSER_SERVER}__${name}`) : [];
  const missing = `If a required Gmail capability is not connected or the browser cannot connect, finish with runs.finish { run_id: "${c.runId}", status: "error", error: "setup required: <capability>", note: "<the connection needed>" }. Do not report connector_unavailable for missing setup. If an actual call is denied, follow the tool-denied rule; never work around it.`;

  let body = prompt
    // Replace the adapter-specific tool inventory, including its unconditional transient retry rule.
    .replace(/^## Tools\n[\s\S]*?(?=^## |(?![\s\S]))/m, `## Tools\n\nUse the Codex tool bindings above. ${missing}\n\n`)
    .replace(/^If a Gmail or Claude in Chrome tool listed above[^\n]*/gm, missing)
    .replace(
      /^Tools: the pp MCP tools[^\n]*?(?= The skill's files)/gm,
      `Tools: the pp MCP tools${c.web.length ? ` and ${c.web.join(', ')}` : ''}${browser.length ? ` and ${browser.join(', ')}` : ''}${gmail.length ? ` and connected Gmail capabilities (${gmail.join(', ')})` : ''}, nothing else.`,
    )
    .replace(/mcp__claude_ai_Gmail__(\w+)/g, (_all, name: string) => GMAIL_CAPABILITIES[name] ?? `Gmail ${name}`)
    .replace(/mcp__claude-in-chrome__(\w+)/g, (_all, name: string) => `mcp__${CODEX_BROWSER_SERVER}__${BROWSER_ALIASES[name] ?? name}`)
    .replace(
      /Claude in Chrome granted but not loaded[^\n]*/g,
      'A browser connection that needs setup is reported as setup required; do not retry it automatically.',
    )
    .replace(/`error_code: "connector_unavailable"`/g, '`error: "setup required: Gmail"`')
    .replace(/error_code: "connector_unavailable",?\s*/g, '')
    .replace(/connector_unavailable: /g, 'setup required: ')
    .replace(/\(?[Tt]he engine retries[^.\n]*\.?\)?/g, '')
    .replace(/Claude Code: the Gmail connector's create_draft/g, 'use your connected Gmail draft tool')
    .replace(
      /Claude Code uses the claude\.ai Gmail connector \([^)]*\); Codex and Cursor need their own Gmail MCP server configured for this step\./g,
      'Use the Gmail app or MCP server connected to this runner.',
    )
    .replace(/\*\*The portal\*\*, read through Claude in Chrome/g, '**The portal**, read through Chrome DevTools')
    .replace(/Claude in Chrome/g, 'Chrome DevTools')
    .replace(/`--add-dir`/g, '`--workspace` on the browser connector')
    .replace(/No Chrome tools in this session \(Codex, Cursor, no extension\)/g, 'No browser connection in this session')
    .replace(/A tool missing \(Codex, Cursor, or a denied Chrome tool\)/g, 'A required browser tool missing or denied');

  // Long identifiers are unambiguous. Short verbs are replaced only as code, not in prose.
  for (const [from, to] of Object.entries(BROWSER_ALIASES)) {
    body = body.replaceAll(`\`${from}\``, `\`${to}\``);
    if (from.includes('_')) body = body.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
  }
  body = body
    .replace(/find \/ take_snapshot/g, 'take_snapshot')
    .replace(/`take_snapshot` (?:\/|and) `take_snapshot`/g, '`take_snapshot`')
    .replace(/paths: \[/g, 'filePaths: [');

  return [
    '## Codex tool bindings',
    '',
    ...(gmail.length
      ? [
          `Allowed Gmail capabilities: ${gmail.join(', ')}. These labels describe capabilities, not literal tool names. Inspect this session's connected Gmail tools (use tool discovery when available) and call their actual names and schemas. Never look for a claude.ai tool or infer an address from a missing mailbox connection.`,
          'Gmail is read-only except for the draft operation explicitly granted here. Never send, reply, forward, delete, trash, label or change mailbox settings. A recipient must satisfy the PP email confirmation rules before creating a draft.',
        ]
      : []),
    ...(c.browser
      ? [
          `Browser: Chrome DevTools MCP, server ${CODEX_BROWSER_SERVER}. Allowed tools: ${browser.join(', ')}.`,
          'First list pages. Existing pages belong to the user: never navigate, fill or close them. Create one run-owned page at the required URL with new_page; reuse that pageId for this run. Read with take_snapshot and locate elements and links in its returned text. Navigate only by URL with navigate_page. Never write a snapshot to a file.',
          'Use the actual tool schemas: pageId is the page identifier; uid comes from take_snapshot. There is no separate find or page-text tool. new_page takes a URL; close_page takes the owned pageId. Report page IDs as tabs on runs.finish.',
          ...(c.assist
            ? [
                'Fill assist: fill_form takes elements: [{ uid, value }] and pageId. upload_file takes uid, filePaths: ["<absolute rendered PDF path>"], and pageId. Upload only the rendered resume/cover letter named by PP. Use an actual file input, never a chooser-opening button. Only fill answer inputs, selects, checkboxes and radios; never a Submit, Apply, Send, Next or Finish control. No click, key, script or submit tools are granted.',
                'Leave the filled, run-owned portal page open for the user to review and submit. Close only other pages this run created. Never submit an application.',
              ]
            : [
                'Read-only browser work: no field filling, uploads, clicks, key presses or scripts. Close only pages this run created when finished.',
              ]),
        ]
      : ['No browser is granted for this run. Do not use browser tools.']),
    missing,
    '',
    body,
  ].join('\n');
}
