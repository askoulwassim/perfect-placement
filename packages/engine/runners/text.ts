import type { Capability } from './grants.js';

/*
 * Runner-neutral prompt text (#159). SKILL.md files and the engine's prompt lines name tools and runner mechanics
 * as {{placeholders}}; each runner's `PromptText` says what they are for that runner. Syntax:
 *   {{web.fetch}}          a capability's tool, as the prose names it (Claude: WebFetch; Codex: web.run open)
 *   {{tool:web.fetch}}     its full tool name, as a tool list names it
 *   {{browser.name}} ...   a fragment: a phrase or sentence about how this runner works (FRAGMENTS)
 *   {{run_id}}             the run's id
 *   {{#uploads.off}}A{{/uploads.off}}{{^uploads.off}}B{{/uploads.off}}
 *                          A when the fill assist was asked for but this run cannot upload, else B
 * An unknown placeholder throws, so a typo fails the tests instead of reaching an agent.
 */

export const FRAGMENTS = [
  /** The pp MCP server's tools as this runner names them in a tool list ("mcp__pp"). */
  'tool:pp',
  /** The browser integration's name ("Claude in Chrome"). */
  'browser.name',
  /** A session with no browser tools at all, as connect's LinkedIn step names it. */
  'browser.none',
  /** How to read a page's text and structure ("`get_page_text` and `read_page`"). */
  'browser.read',
  /** How to locate a field or link, in code form ("`find` / `read_page`"). */
  'browser.locate',
  /** The same in plain text, for the engine's one-line instructions. */
  'browser.locate_plain',
  /** The upload tool's argument for file paths ("paths"). */
  'browser.upload_paths',
  /** What lets the session read the rendered PDFs ("`--add-dir`"). */
  'browser.files_access',
  /** The Tools section's rule for a Gmail or browser tool the session did not load. */
  'connector.tools',
  /** The prompt line with that rule (uses {{run_id}}). */
  'connector.missing',
  /** A step's short form of that rule. */
  'connector.not_loaded',
  /** The error fields a missing connector reports, up to the tool name (`error_code: ..., error: "...: `). */
  'missing.error',
  /** What happens to a Gmail step that finished on a missing connector (" (the engine retries ...)"). */
  'missing.retry_step',
  /** The Gmail draft tool, as the Gmail draft step names it. */
  'gmail.draft_tool',
  /** Which Gmail tool this runner uses for drafts (connect's Gmail draft step). */
  'gmail.source',
  /** Where the inbox's Gmail search comes from (" (Claude Code's claude.ai Gmail connector)"). */
  'gmail.connector_note',
  /** How other clients reach Gmail, after inbox's read-only rule. */
  'gmail.other_clients',
  /** connect: a missing draft tool, after the error fields. */
  'connect.draft_retry',
  /** connect, fill, voice: how this runner loads and limits the browser and Gmail (end of `## Tools`). */
  'connect.tools_note',
  'fill.tools_note',
  'voice.tools_note',
  /** fill: a browser tool missing or not loaded. */
  'fill.missing',
] as const;
export type Fragment = (typeof FRAGMENTS)[number];

export type TextKey = Capability | `tool:${Capability}` | Fragment;

/** One runner's text for every placeholder. */
export type PromptText = Readonly<Record<TextKey, string>>;

export interface TextState {
  runId?: string;
  /** The fill assist was asked for but this run cannot upload (no rendered PDFs, or no upload tool). */
  uploadsOff?: boolean;
}

const SECTION = /\{\{([#^])([\w.]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g;
const PLACEHOLDER = /\{\{([\w.:]+)\}\}/g;
const FLAGS: Readonly<Record<string, (s: TextState) => boolean>> = { 'uploads.off': (s) => s.uploadsOff === true };

/** Resolve every placeholder in `template` with a runner's text. */
export function renderText(template: string, text: PromptText, state: TextState = {}): string {
  const sections = template.replace(SECTION, (_all, kind: string, name: string, body: string) => {
    const flag = FLAGS[name];
    if (!flag) throw new Error(`unknown section {{${kind}${name}}}`);
    return flag(state) === (kind === '#') ? body : '';
  });
  return sections.replace(PLACEHOLDER, (_all, key: string) => {
    if (key === 'run_id') {
      if (state.runId === undefined) throw new Error('{{run_id}} needs a run id');
      return state.runId;
    }
    const value = (text as Record<string, string | undefined>)[key];
    if (value === undefined) throw new Error(`unknown placeholder {{${key}}}`);
    return value.includes('{{run_id}}') ? renderText(value, text, state) : value;
  });
}

/** Every placeholder and section name a template uses (tests: each must resolve for every runner). */
export function placeholdersIn(template: string): string[] {
  return [...template.matchAll(/\{\{[#^/]?([\w.:]+)\}\}/g)].map((m) => m[1] as string);
}
