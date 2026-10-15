import { codexBrowserEnvironment } from './browser-env.js';

/** Codex's browser adapter. Only these tools are exposed to a headless PP run. */
export const CODEX_BROWSER_SERVER = 'pp_browser';
export const CODEX_BROWSER_READ_TOOLS = ['list_pages', 'new_page', 'close_page', 'navigate_page', 'take_snapshot'] as const;
export const CODEX_BROWSER_FILL_TOOLS = ['fill_form', 'upload_file'] as const;

export interface CodexConnectors {
  runId: string;
  browser: boolean;
  assist: boolean;
  uploads?: boolean;
  gmail: readonly string[];
  web: readonly string[];
}

export function codexBrowserTools(assist: boolean, uploads = false): string[] {
  return [...CODEX_BROWSER_READ_TOOLS, ...(assist ? ['fill_form'] : []), ...(assist && uploads ? ['upload_file'] : [])];
}

/** CLI overrides, scoped to the child run. Runner args can select a different browser connection. */
export function codexBrowserArgs(opts: {
  nodePath: string;
  adapterBin: string;
  runtimeDir: string;
  assist: boolean;
  filesDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const prefix = `mcp_servers.${CODEX_BROWSER_SERVER}`;
  const toml = (value: unknown) => JSON.stringify(value).replaceAll('\u007f', '\\u007f');
  return [
    `${prefix}.command=${toml(opts.nodePath)}`,
    `${prefix}.args=${toml([
      opts.adapterBin,
      '--runtime-dir',
      opts.runtimeDir,
      ...(opts.assist ? ['--assist'] : []),
      ...(opts.assist && opts.filesDir ? ['--files-dir', opts.filesDir] : []),
    ])}`,
    // Codex clears unlisted MCP environment variables, including XDG cache/profile locations.
    ...Object.entries(codexBrowserEnvironment(opts.env)).map(([key, value]) => `${prefix}.env.${key}=${toml(value)}`),
    `${prefix}.enabled=true`,
    `${prefix}.enabled_tools=${JSON.stringify(codexBrowserTools(opts.assist, Boolean(opts.filesDir)))}`,
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
  const browser = c.browser ? codexBrowserTools(c.assist, c.uploads).map((name) => `mcp__${CODEX_BROWSER_SERVER}__${name}`) : [];
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
    .replace(/`--add-dir`/g, 'the PP browser adapter’s rendered-file allowlist')
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

  // Missing files must not leave instructions to render or use a tool that was deliberately withheld.
  if (!c.uploads) {
    body = body
      // Keep the engine's "Uploads: none." failure line and its concrete skip reasons intact.
      // Other Uploads lines may come from omitted metadata or name files without a matching grant.
      .replace(
        /^Uploads: (?!none\.)[^\n]*/gm,
        'Uploads: none. No rendered-files directory was supplied to this run. Do not render or upload documents; fill the answer fields, then report apply.fill_done with uploaded: [] and skipped including { label: "Resume", reason: "uploads unavailable: no rendered-files directory was supplied" } and { label: "Cover letter", reason: "uploads unavailable: no rendered-files directory was supplied" }.',
      )
      .replace(
        /^Fill assist \(the user clicked Open and fill\):[^\n]*/gm,
        'Fill assist (the user clicked Open and fill): after apply.fill, reuse the portal tab and fill saved answer fields with fill_form, locating them with take_snapshot. Do not upload or render documents. Never click, press a key, run script or submit, and never touch a Submit, Apply or Send control. Leave the portal tab open, report apply.fill_done with uploaded: [] and both documents skipped, then finish. The user reviews and submits.',
      )
      .replace(
        /^1\. The PDFs:[^\n]*/gm,
        '1. Uploads are unavailable in this run. Do not render or upload documents; report Resume and Cover letter as skipped using the rendering failure reason when provided.',
      )
      .replace(/^3\. Upload:[^\n]*/gm, '3. Skip document uploads; continue filling the saved answer fields.')
      .replace(/uploaded: \["resume", "cover_letter"\]/g, 'uploaded: []');
  }

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
          'If browser tools are missing, report the setup remedy: run pp setup --runner codex. Chrome must be running with remote debugging enabled at chrome://inspect/#remote-debugging, and the user must allow the connection request. Never install packages or change browser settings from the run.',
          'First list pages. Existing pages belong to the user: never navigate, fill or close them. Create one run-owned page at the required URL with new_page; reuse that pageId for this run. Read with take_snapshot and locate elements and links in its returned text. Navigate only by URL with navigate_page. Never write a snapshot to a file.',
          'Use the actual tool schemas: pageId is the page identifier; uid comes from take_snapshot. There is no separate find or page-text tool. new_page takes a URL; close_page takes the owned pageId. Report page IDs as tabs on runs.finish.',
          ...(c.assist
            ? [
                'Fill assist: fill_form takes elements: [{ uid, value }] and pageId. Only fill answer inputs, selects, checkboxes and radios; never a Submit, Apply, Send, Next or Finish control. No click, key, script or submit tools are granted.',
                ...(c.uploads
                  ? [
                      'upload_file takes uid, filePaths: ["<absolute rendered PDF path>"], and pageId. The PP browser adapter permits only the rendered resume.pdf and cover_letter.pdf named by PP. Use an actual file input, never a chooser-opening button.',
                    ]
                  : [
                      'Uploads are unavailable: no rendered-files directory was supplied. Keep the form filling, report both documents as skipped, and do not render or attempt uploads.',
                    ]),
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
