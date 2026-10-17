import { type Capability, GMAIL_STEP_CAPS, skillCapabilities } from '../grants.js';
import type { GrantRequest, PreambleContext } from '../types.js';
import { BROWSER_SERVER } from './policy.js';

/*
 * What every runner on the PP browser adapter (Codex, Cursor) shares in its prompt (#161): the grants, and the
 * tool-bindings block that states the adapter's page, site and upload rules. Each runner adds its own names.
 */

/** Grants on the adapter: the skill's, or a Gmail step's; `upload_file` only when the engine rendered the PDFs (#157). */
export function adapterGrants(g: GrantRequest): Capability[] {
  if (g.mode && g.mode !== 'skill') return [...GMAIL_STEP_CAPS[g.mode]];
  return skillCapabilities(g.skill, { linkedin: g.linkedin !== false, assist: g.assist === true }).filter(
    (c) => c !== 'browser.upload' || g.uploadsReady === true,
  );
}

export interface BindingNames {
  /** The block's heading ("## Codex tool bindings"). */
  heading: string;
  /** A browser capability's tool as this runner lists it. */
  browserTool: (c: Capability) => string;
  /** A Gmail capability's label. */
  gmailLabel: (c: Capability) => string;
  gmailInstruction?: string;
  /** The command that installs the browser runtime for this runner. */
  setup: string;
  /** The rule for a connector that needs setup (this runner's `connector.missing`, rendered). */
  missing: string;
}

/** The tool-bindings block for a run with Gmail or the browser; nothing for other runs. */
export function adapterBindings(p: PreambleContext, n: BindingNames): string[] {
  const gmail = p.caps.filter((c) => c.startsWith('gmail.')).map(n.gmailLabel);
  const browserCaps = p.caps.filter((c) => c.startsWith('browser.'));
  const browser = [...new Set(browserCaps.map(n.browserTool))];
  const uploads = browserCaps.includes('browser.upload');
  return [
    ...(gmail.length || browser.length
      ? [
          n.heading,
          '',
          ...(gmail.length
            ? [
                `Allowed Gmail capabilities: ${gmail.join(', ')}. ${n.gmailInstruction ?? "These labels describe capabilities, not literal tool names. Inspect this session's connected Gmail tools (use tool discovery when available) and call their actual names and schemas. Never look for a claude.ai tool or infer an address from a missing mailbox connection."}`,
                'Gmail is read-only except for the draft operation explicitly granted here. Never send, reply, forward, delete, trash, label or change mailbox settings. A recipient must satisfy the PP email confirmation rules before creating a draft.',
              ]
            : []),
          ...(browser.length
            ? [
                `Browser: Chrome DevTools MCP, server ${BROWSER_SERVER}. Allowed tools: ${browser.join(', ')}.`,
                `If browser tools are missing, report the setup remedy: run ${n.setup}. Chrome must be running with remote debugging enabled at chrome://inspect/#remote-debugging, and the user must allow the connection request. Never install packages or change browser settings from the run.`,
                'First list pages. Existing pages belong to the user: never navigate, fill or close them. Create one run-owned page at the required URL with new_page; reuse that pageId for this run. Read with take_snapshot and locate elements and links in its returned text. Navigate only by URL with navigate_page. Never write a snapshot to a file.',
                'The PP browser adapter enforces this: every page call needs the pageId of a page this run opened, list_pages shows only those pages, and only this run\'s allowed sites open (the posting\'s, the portal\'s and the company\'s sites and applicant-tracking and sign-in sites for fill; LinkedIn for connect and voice). A refused site is not retried: finish with status "error" and error "site not allowed: <host>", naming the URL in the note.',
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
          n.missing,
          '',
        ]
      : []),
  ];
}
