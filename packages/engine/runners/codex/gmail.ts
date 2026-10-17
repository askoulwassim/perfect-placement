import type { Capability } from '../grants.js';
import type { GrantRequest } from '../types.js';

/** #158: verified against the installed plugin and headless MCP metadata, 2026-10-17. */
export const CODEX_GMAIL = {
  pluginId: 'plugin_connector_1p_95d39881713c8191931482a62d6edff9',
  plugin: 'gmail@openai-curated-remote',
  catalog: 'openai-curated',
  connectorId: 'connector_2128aebfecb84f64a069897515042a44',
  pluginVersion: '0.1.10',
  codexVersion: '0.163.0',
  server: 'codex_apps',
} as const;

/** Raw protocol names, not display titles or discovery aliases. No get_draft exists. */
export const CODEX_GMAIL_TOOLS = {
  'gmail.search': 'gmail.search_emails',
  'gmail.thread': 'gmail.read_email_thread',
  'gmail.message': 'gmail.read_email',
  'gmail.create_draft': 'gmail.create_draft',
  'gmail.update_draft': 'gmail.update_draft',
} as const;

export const CODEX_GMAIL_DRAFT_INPUT =
  'Use payload: { mime_type: "text/plain", body: { content: <the exact saved body> } }. Record the returned top-level draft id, never message.id or a thread id. A missing draft id is an error; never create another draft to recover it.';

export function codexGmailCaps(g?: GrantRequest): Capability[] {
  if (!g) return []; // Ask
  if (g.mode === 'gmail_draft') return ['gmail.create_draft'];
  if (g.mode === 'gmail_to') return ['gmail.update_draft'];
  const reads: Capability[] = ['gmail.search', 'gmail.thread', 'gmail.message'];
  if (g.skill === 'connect') return [...reads, 'gmail.create_draft'];
  return g.skill === 'inbox' || g.skill === 'voice' ? reads : [];
}

export function codexGmailTools(g?: GrantRequest): string[] {
  return codexGmailCaps(g).map((c) => CODEX_GMAIL_TOOLS[c as keyof typeof CODEX_GMAIL_TOOLS]);
}

export const CODEX_GMAIL_BLOCKER =
  'Codex 0.163.0 app tool policy matches titles as well as raw names; its built-in codex_apps server ignores MCP enabled_tools. Exact Gmail isolation is not verified. See issue #158.';

export class GmailSetupRequired extends Error {
  constructor(detail = CODEX_GMAIL_BLOCKER) {
    super(`setup required: Gmail: ${detail}`);
    this.name = 'GmailSetupRequired';
  }
}

/** No capability flag, environment variable, provider alias or runner argument can bypass this gate. */
export function requireCodexGmailIsolation(tools: readonly string[]): void {
  if (tools.length) throw new GmailSetupRequired();
}
