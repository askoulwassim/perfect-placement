import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type PolicyConfig,
  type RunnerConfig,
  type Skill,
  VOICE_LEARN_MAX_EMAILS,
  VOICE_LEARN_MAX_POSTS,
  VOICE_LEARN_SAMPLES_MAX,
} from '@perfect-placement/contracts';

/*
 * Headless agent runner for `runs.start` (wave1-decisions #9). UI buttons and schedules start a run;
 * the run row is committed first, then the configured runner (`config.runner`) is launched with the
 * skill's SKILL.md as the prompt and an MCP config pointing at the `pp` MCP server over stdio.
 * The runner finishes with `runs.finish`. The launch is injected (`EngineServices.launcher`):
 * tests use a fake and nothing ever spawns in CI. Flags per runner: see ops/README.md.
 */

/** Name of the MCP server in every runner's config; tools appear as `mcp__pp__<tool>` in Claude Code. */
export const MCP_SERVER_NAME = 'pp';

export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** A file the launcher writes before starting (Cursor reads MCP servers from `<cwd>/.cursor/mcp.json`). */
export interface RunnerFile {
  /** Relative to the run's working directory. */
  path: string;
  content: string;
}

export interface RunnerSpec {
  runId: string;
  command: string;
  args: string[];
  /** Working directory. `null` = a fresh temp dir (needed when `files` is non-empty). */
  cwd: string | null;
  env: Record<string, string>;
  files: RunnerFile[];
}

/** How a launched runner ended (only while the launching process is still alive to see it). */
export interface RunnerExit {
  code: number | null;
  /** The runner's stdout + stderr (Claude Code: the `--output-format json` result). */
  output: string;
  /** Where the output was written, if anywhere. */
  logFile?: string;
}

export interface RunnerLauncher {
  /**
   * Start the runner and resolve once it is running (reject if it cannot start). Never waits for it to
   * finish; `exit` (optional) settles when it does, so `runs.start` can fail a run the runner left open.
   */
  launch(spec: RunnerSpec): Promise<{ pid?: number; exit?: Promise<RunnerExit> }>;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The repo root (the directory holding `skills/` and `pnpm-workspace.yaml`), found by walking up from
 * `from`: works from packages/engine/ops (source) and packages/engine/dist/ops (build).
 */
export function resolveRepoRoot(from: string = HERE): string {
  for (let dir = from; ; ) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) && existsSync(join(dir, 'skills'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return join(from, /[/\\]dist([/\\]|$)/.test(from) ? '../../../..' : '../../..');
}

const REPO_ROOT = resolveRepoRoot();

/** `skills/` at the repo root. */
export const DEFAULT_SKILLS_DIR = join(REPO_ROOT, 'skills');

/** A node inside a versioned Homebrew keg (`.../Cellar/<formula>/<version>/bin/node`): gone after `brew upgrade`. */
export const CELLAR_NODE = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/;

/**
 * The node to write into any config (runner `--mcp-config`, agent MCP registrations): PP_NODE (set by
 * the install.sh launcher), else `execPath` with a Homebrew Cellar path mapped to its stable `opt/`
 * link, so a `brew upgrade` does not break it (#33).
 */
export function stableNodePath(
  env: Record<string, string | undefined> = process.env,
  execPath: string = process.execPath,
  exists: (p: string) => boolean = existsSync,
): string {
  if (env.PP_NODE && exists(env.PP_NODE)) return env.PP_NODE;
  const m = CELLAR_NODE.exec(execPath);
  if (m) {
    const opt = `${m[1]}/opt/${m[2]}/bin/node`;
    if (exists(opt)) return opt;
  }
  return execPath;
}

/** The pp MCP server over stdio (packages/mcp, built), pointed at this vault, on a stable node path. */
export function defaultMcpServer(home: string, nodePath: string = stableNodePath()): McpServerSpec {
  return { command: nodePath, args: [join(REPO_ROOT, 'packages/mcp/dist/bin.js')], env: { PP_HOME: home } };
}

export interface PromptContext {
  runId: string;
  skill: Skill;
  roleId?: string;
  contactId?: string;
  /** `connect` (#82): config.linkedin and today's remaining profile budget, stated in the prompt. */
  linkedin?: PolicyConfig['linkedin'] & { budget_left: number };
  /** `fill` (#81): the vault path of questions the user pasted (`apply.set_questions`); answer those, no portal read. */
  questions?: string;
  /** `fill` (#106): the fill assist (Open and fill): upload the PDFs and fill the answer fields, stop before Submit. */
  assist?: boolean;
  /** `voice` (#76): whether LinkedIn posts may be read (config.linkedin.mode is `live`) and the page cap. */
  voice?: { linkedin: boolean; max_pages: number };
}

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
 * read its text or accessibility tree, find an element. No click, type, form input, script, upload or shortcut:
 * nothing that can send, connect, follow, like, fill a field or submit.
 */
export const CHROME_READ_TOOLS = ['tabs_context_mcp', 'tabs_create_mcp', 'navigate', 'get_page_text', 'read_page', 'find'].map(
  (t) => `${CHROME_PREFIX}${t}`,
);
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
 * no file reads): every read and write goes through ops. Chrome read tools only for `connect` (LinkedIn,
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

/**
 * Everything a Chrome skill's run denies: Gmail writes it is not granted, every acting Chrome tool (but the
 * fill assist's `form_input` + `file_upload` on a fill run with `assist`, #106), built-in writes.
 */
export function chromeDeniedTools(skill: Skill, opts: { assist?: boolean } = {}): string[] {
  const granted = new Set(skillAllowedTools(skill, { assist: opts.assist === true }));
  return [...gmailDeniedTools(skill), ...CHROME_WRITE_TOOLS.filter((t) => !granted.has(t)), ...BUILTIN_WRITE_TOOLS];
}

/** Everything a `connect` run denies: Gmail writes but create_draft, every acting Chrome tool, built-in writes. */
export function connectDeniedTools(): string[] {
  return chromeDeniedTools('connect');
}

/** Gmail write tools a skill's run denies outright: every write it is not granted. */
export function gmailDeniedTools(skill: Skill): string[] {
  const granted = new Set(SKILL_TOOLS[skill].gmail);
  return GMAIL_WRITE_TOOLS.filter((t) => !granted.has(t));
}

/**
 * Companion files that ship next to a skill's SKILL.md in the repo and are inlined into its prompt.
 * Skill files live in the repo, never the vault: a headless run must not look for them with vault.read.
 * (`connect/RUNBOOK.md` is a human runbook for a supervised live run; it is not inlined.)
 */
export const SKILL_ASSETS: Readonly<Partial<Record<Skill, readonly string[]>>> = {
  scout: ['plan.md'],
  onboard: ['extract.md'],
};

function readAsset(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : `(not found at ${file})`;
}

/**
 * The prompt: the run ids, the tools this run has, the skill's SKILL.md and its companion files
 * (read from the repo by absolute path), and the closing instruction.
 */
export function skillPrompt(skillsDir: string, c: PromptContext): string {
  const file = join(skillsDir, c.skill, 'SKILL.md');
  const skill = existsSync(file) ? readFileSync(file, 'utf8').trim() : `# ${c.skill}\n\n(SKILL.md not found at ${file})`;
  const ids = [`run_id: ${c.runId}`, ...(c.roleId ? [`role_id: ${c.roleId}`] : []), ...(c.contactId ? [`contact_id: ${c.contactId}`] : [])];
  const live = c.voice ? c.voice.linkedin : c.linkedin ? c.linkedin.mode === 'live' : true;
  const extra = skillAllowedTools(c.skill, { linkedin: live, assist: c.assist === true }).slice(1);
  const assets = (SKILL_ASSETS[c.skill] ?? []).map((name) => {
    const abs = join(skillsDir, c.skill, name);
    return `## ${name} (skill file, ${abs})\n\n${readAsset(abs)}`;
  });
  return [
    `You are running the Perfect Placement "${c.skill}" skill headless. Every read and write goes through the ${MCP_SERVER_NAME} MCP tools; never edit files or the database directly. Never submit an application or send an email.`,
    '',
    ids.join('\n'),
    '',
    `The run already exists (runs.start was called for you). Pass run_id in your work and finish with runs.finish { run_id: "${c.runId}", status }.`,
    '',
    `Tools: the ${MCP_SERVER_NAME} MCP tools${extra.length ? ` and ${extra.join(', ')}` : ''}, nothing else. The skill's files (SKILL.md${assets.length ? `, ${(SKILL_ASSETS[c.skill] ?? []).join(', ')}` : ''}) are below; they live in the repo, not the vault, so never look for them with vault.read.`,
    `If a tool you need is denied or missing, do not work around it: finish with runs.finish { run_id: "${c.runId}", status: "error", summary: { error: "tool denied: <tool>", denied_tools: ["<tool>"] }, note: "<what you could not do>" }.`,
    ...(c.linkedin ? ['', linkedinLine(c.linkedin)] : []),
    ...(c.skill === 'fill' ? ['', fillLine(c.questions, c.assist === true)] : []),
    ...(c.voice ? ['', voiceLine(c.voice)] : []),
    '',
    skill,
    ...(assets.length ? ['', ...assets] : []),
  ].join('\n');
}

/** The LinkedIn line of a `connect` prompt (#82): mode, caps and today's budget, from config. */
export function linkedinLine(l: NonNullable<PromptContext['linkedin']>): string {
  if (l.mode !== 'live')
    return `LinkedIn: off for this run (config.linkedin.mode = ${l.mode}). Do not open LinkedIn; call people.find with linkedin: { pages_opened: 0 } and no linkedin hints.`;
  return `LinkedIn (read-only via Claude in Chrome): at most ${l.max_pages_per_run} pages this run, ${l.budget_left} profiles left today (of ${l.max_profiles_per_day}), at most ${l.max_mutual_expansions} mutual lists, wait ${l.min_delay_s} to ${l.min_delay_s * 2} s before every page. Never message, connect, follow, like or click a button.`;
}

/**
 * The portal line of a `fill` prompt (#81): pasted questions on file, or read the portal read-only. With the
 * fill assist (#106) a second line: upload the rendered PDFs and fill the answer fields, stop before Submit.
 */
export function fillLine(questions?: string, assist = false): string {
  const read = questions
    ? `Questions: the user pasted this portal's questions (vault.read { path: "${questions}" }). Answer exactly those; do not read the portal for questions.`
    : `Portal (${assist ? 'read first' : 'read-only'} via Claude in Chrome): open the apply page in a new tab and read every tab and step by navigating to its URL (find the tab and step links). Never click, type${assist ? '' : ', fill a field, upload'} or submit. If the questions stay unreadable, finish with status "error" and note "portal questions unreadable" so the user can paste them.`;
  return assist ? `${read}\n${FILL_ASSIST_LINE}` : read;
}

/** The fill assist line (#106): the user clicked Open and fill and is watching. */
export const FILL_ASSIST_LINE =
  'Fill assist (the user clicked Open and fill): after apply.fill, call apply.render_documents { role_id, formats: ["pdf"] }; in the portal tab you read (reuse it, no new tab), upload the resume PDF (and the cover letter PDF where the portal takes one) with file_upload using each file\'s abs_path, and fill each answer field from the saved Answers with form_input (find / read_page to locate fields). Never click, press a key, run script or submit, and never touch a Submit, Apply or Send control. Leave the tab open on the last step, report with apply.fill_done { role_id, filled, uploaded, skipped }, then finish. The user reviews and submits.';

/** The sources line of a `voice` prompt (#76): Gmail sent mail read-only, LinkedIn posts only when live, caps. */
export function voiceLine(v: NonNullable<PromptContext['voice']>): string {
  const gmail = `Gmail (read-only): only messages the user sent (search "in:sent", newest first), at most ${VOICE_LEARN_MAX_EMAILS}. Never read received mail beyond the user's own words, never draft, send, label or delete.`;
  const li = v.linkedin
    ? `LinkedIn (read-only via Claude in Chrome): only the user's own recent posts (their profile's activity page), at most ${VOICE_LEARN_MAX_POSTS} posts and ${v.max_pages} pages. Never like, comment, message, connect, follow or click a button.`
    : 'LinkedIn: off for this run (config.linkedin.mode is not live). Do not open LinkedIn; report linkedin_posts: 0.';
  return `${gmail}\n${li}\nPropose at most ${VOICE_LEARN_SAMPLES_MAX} short samples with profile.propose_voice; never apply the diff.`;
}

/** The `## Gmail draft step` section of a SKILL.md (up to the next `## ` heading), or null. */
export function gmailStepSection(skillMd: string): string | null {
  const m = /^## Gmail draft step\b[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(skillMd);
  return m ? `## Gmail draft step\n${m[1]}`.trim() : null;
}

/**
 * The prompt for a `connect` run scoped to one outreach (Gmail via agent): read the draft, create a
 * Gmail DRAFT with the agent's own Gmail tool (never send), record it with outreach.to_gmail.
 */
export function gmailDraftPrompt(skillsDir: string, c: { runId: string; outreachId: string; roleId: string; contactId: string }): string {
  const file = join(skillsDir, 'connect', 'SKILL.md');
  const section = existsSync(file) ? gmailStepSection(readFileSync(file, 'utf8')) : null;
  return [
    `You are running the Perfect Placement "connect" skill headless, Gmail draft step only. Every Perfect Placement read and write goes through the ${MCP_SERVER_NAME} MCP tools; never edit files or the database directly. Never send an email: create a Gmail DRAFT only. Never submit an application.`,
    '',
    [`run_id: ${c.runId}`, `outreach_id: ${c.outreachId}`, `role_id: ${c.roleId}`, `contact_id: ${c.contactId}`].join('\n'),
    '',
    '1. Read the draft: outreach_get { outreach_id }. Subject = its subject (if null: the role title from roles_get, then " at " and the company name). Body = its `body` field, exactly as returned (greeting, Hook, Proof, Ask, sign-off; plain text).',
    '2. Recipient: outreach_get returns `to` (the contact, or the mutual for a bridge draft). To = `to.email`. If `to.decision_id` is set (a guessed address waiting in Needs you) or `outreach.status` is not `drafted`, create nothing: finish ok with summary { outreach_id, skipped: "email pending" or "already in Gmail" } (the engine queues this step again once the address is confirmed). If `to.email` is null otherwise, leave To empty (`to.reason` says why); never use `to.guess`.',
    "3. Create a Gmail DRAFT with your Gmail draft tool (Claude Code: the Gmail connector's create_draft). Never call send, reply or forward. If you have no Gmail draft tool, finish the run as error with a note saying so.",
    `4. Record it: outreach_to_gmail { outreach_id: "${c.outreachId}", gmail_draft_id: "<the id your tool returned>", confidence: <0 to 1, how sure you are the draft matches> }.`,
    `5. Finish: runs_finish { run_id: "${c.runId}", status: "ok", summary: { outreach_id: "${c.outreachId}", gmail_draft_id, to: <the To you used or null>, to_reason: <to.reason when To is empty> } } (status "error" with a note if any step failed).`,
    ...(section ? ['', section] : []),
  ].join('\n');
}

/**
 * The prompt for the To update step (#99): an in-Gmail draft was created with no To while its address was
 * a guess; now the address is confirmed. Read the Gmail draft, set its To (keep subject and body exactly as
 * they are in Gmail: the user may have edited them), record it with outreach.to_gmail. Never send.
 */
export function gmailToPrompt(skillsDir: string, c: { runId: string; outreachId: string; roleId: string; contactId: string }): string {
  const file = join(skillsDir, 'connect', 'SKILL.md');
  const md = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const m = /^## Gmail To step\b[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(md);
  return [
    `You are running the Perfect Placement "connect" skill headless, Gmail To step only. Every Perfect Placement read and write goes through the ${MCP_SERVER_NAME} MCP tools; never edit files or the database directly. Never send an email: only set the To of an existing Gmail DRAFT. Never submit an application.`,
    '',
    [`run_id: ${c.runId}`, `outreach_id: ${c.outreachId}`, `role_id: ${c.roleId}`, `contact_id: ${c.contactId}`].join('\n'),
    '',
    '1. Read the record: outreach_get { outreach_id }. The Gmail draft id is `outreach.gmail_draft_id`; To = `to.email` (confirmed). If `to.email` is null, change nothing and finish the run as error with a note.',
    `2. Read the Gmail draft with ${GMAIL_GET_DRAFT_TOOL} (that id). Keep its subject and body exactly as they are in Gmail.`,
    `3. Set its To with ${GMAIL_UPDATE_TOOL}: the same draft id, To = \`to.email\`, the subject and body you just read. Never call send, reply, forward, create_draft or delete.`,
    `4. Record it: outreach_to_gmail { outreach_id: "${c.outreachId}", gmail_draft_id: "<the same draft id>", confidence: <0 to 1, how sure you are the draft now has this To> }.`,
    `5. Finish: runs_finish { run_id: "${c.runId}", status: "ok", summary: { outreach_id: "${c.outreachId}", gmail_draft_id, to: <the To you set> } } (status "error" with a note if any step failed).`,
    ...(m ? ['', `## Gmail To step\n${m[1]}`.trim()] : []),
  ].join('\n');
}

/**
 * cursor-agent project permissions (`.cursor/cli.json`): the pp MCP tools, `WebFetch(*)` for web skills,
 * no shell and no file writes (deny wins over `--force`). Cursor documents no web search permission.
 */
export function cursorPermissions(skill: Skill): { allow: string[]; deny: string[] } {
  return {
    allow: [`Mcp(${MCP_SERVER_NAME}:*)`, ...(SKILL_TOOLS[skill].web.length ? ['WebFetch(*)'] : [])],
    deny: ['Shell(*)', 'Write(**)'],
  };
}

/** Tools Claude Code denied in a headless run, from its `--output-format json` result (`permission_denials`). */
export function deniedTools(output: string): string[] {
  const names = new Set<string>();
  for (const m of output.matchAll(/"permission_denials"\s*:\s*(\[[^\]]*\])/g)) {
    try {
      for (const d of JSON.parse(m[1] as string) as Array<{ tool_name?: unknown }>)
        if (typeof d.tool_name === 'string') names.add(d.tool_name);
    } catch {
      // not JSON after all: ignore
    }
  }
  return [...names];
}

/** The error a run gets when its runner denied tools: which ones, and how to fix it. */
export function deniedToolsError(skill: Skill, tools: readonly string[]): string {
  const granted = new Set(skillAllowedTools(skill));
  const isGranted = (t: string) => granted.has(t) || t.startsWith(`mcp__${MCP_SERVER_NAME}__`);
  const blocked = tools.filter(isGranted);
  const extra = tools.filter((t) => !isGranted(t));
  const fixes = [
    ...(blocked.length
      ? [
          `${blocked.join(', ')} ${blocked.length > 1 ? 'are' : 'is'} pre-approved for ${skill} (--allowedTools ${skillAllowedTools(skill).join(',')}) but was denied anyway: remove the deny rule from your Claude Code settings (permissions.deny in ~/.claude/settings.json or managed settings).`,
        ]
      : []),
    ...(extra.length
      ? [
          `${extra.join(', ')} ${extra.length > 1 ? 'are' : 'is'} not granted to ${skill}: if the skill truly needs it, add it to SKILL_TOOLS in packages/engine/ops/runner.ts (or to config.runner.args: ["--allowedTools", "${extra.join(',')}"]).`,
        ]
      : []),
  ];
  return `tool denied: ${tools.join(', ')} (headless ${skill} run, nobody can approve a prompt). Fix: ${fixes.join(' ')}`;
}

/** Command line per runner (flags verified against each CLI's docs, 2026-10). */
export function buildRunnerSpec(opts: {
  runner: RunnerConfig;
  prompt: string;
  runId: string;
  skill: Skill;
  home: string;
  mcp: McpServerSpec;
  /**
   * The Gmail draft step (`runs.start` with `outreach_id`). Claude: no `--strict-mcp-config` (the claude.ai
   * Gmail connector must load), only its create_draft tool allowed next to pp, every other Gmail write denied, no Chrome.
   * Codex and Cursor use whatever Gmail MCP server the user configured for them.
   */
  gmailDraft?: boolean;
  /**
   * The To update step (#99): like the Gmail draft step, but only `get_draft` + `update_draft` next to pp,
   * every other Gmail write (create_draft included) denied, no Chrome.
   */
  gmailTo?: boolean;
  /**
   * `connect` (#82): read LinkedIn via Claude in Chrome (`--chrome` + the Chrome read tools). Default true;
   * `runs.start` passes `config.linkedin.mode === 'live'`.
   */
  linkedin?: boolean;
  /** `fill` (#106): the fill assist; only then are `form_input` + `file_upload` allowed. Default false (read-only). */
  assist?: boolean;
}): RunnerSpec {
  const { runner, prompt, mcp, home, runId } = opts;
  const extra = runner.args ?? [];
  // #50: the pp MCP server gets PP_RUN_ID too, so every op the run performs carries ctx.runId.
  const env = { ...mcp.env, PP_RUN_ID: runId };
  const server = { command: mcp.command, args: mcp.args, env };
  switch (runner.command) {
    case 'claude': {
      const mcpConfig = JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: server } });
      return {
        runId,
        command: 'claude',
        args: [
          '-p',
          prompt,
          '--mcp-config',
          mcpConfig,
          ...(opts.gmailTo
            ? [
                '--allowedTools',
                `mcp__${MCP_SERVER_NAME},${GMAIL_GET_DRAFT_TOOL},${GMAIL_UPDATE_TOOL}`,
                '--disallowedTools',
                GMAIL_TO_DENIED_TOOLS.join(','),
              ]
            : opts.gmailDraft
              ? ['--allowedTools', `mcp__${MCP_SERVER_NAME},${GMAIL_DRAFT_TOOL}`, '--disallowedTools', GMAIL_DENIED_TOOLS.join(',')]
              : opts.skill === 'connect'
                ? // No strict MCP config: the claude.ai Gmail connector loads for search, read and create_draft
                  // (#37, #79); every other Gmail write is denied. #82: the Chrome read + navigate tools are
                  // pre-approved, every Chrome tool that clicks, types or runs script is denied, as are
                  // built-in writes; dontAsk denies anything else.
                  [
                    '--allowedTools',
                    skillAllowedTools('connect', { linkedin: opts.linkedin !== false }).join(','),
                    '--disallowedTools',
                    connectDeniedTools().join(','),
                    '--permission-mode',
                    'dontAsk',
                  ]
                : usesChrome(opts.skill, opts.linkedin !== false)
                  ? // #81 (fill), #76 (voice with LinkedIn live): the portal is read through Claude in Chrome. No strict MCP config (as for connect,
                    // so the Chrome integration loads); built-ins narrowed to the skill's web tools; the Chrome read +
                    // navigate tools pre-approved; every acting Chrome tool (form_input, computer, javascript_tool,
                    // file_upload, ...), every Gmail write and built-in writes denied; dontAsk denies anything else.
                    // #106: a fill run with assist also gets form_input + file_upload (never computer, script or keys).
                    [
                      '--tools',
                      SKILL_TOOLS[opts.skill].web.join(','),
                      '--allowedTools',
                      skillAllowedTools(opts.skill, { linkedin: opts.linkedin !== false, assist: opts.assist === true }).join(','),
                      '--disallowedTools',
                      chromeDeniedTools(opts.skill, { assist: opts.assist === true }).join(','),
                      '--permission-mode',
                      'dontAsk',
                    ]
                  : [
                      // A skill with Gmail tools (inbox, #80) loads the claude.ai Gmail connector, so no strict
                      // MCP config for it, and every Gmail write is denied outright.
                      ...(SKILL_TOOLS[opts.skill].gmail.length ? [] : ['--strict-mcp-config']),
                      // Built-ins narrowed to the skill's web tools (no Bash, Write, Edit or Read), then pre-approved;
                      // dontAsk denies anything else instead of falling back to the user's permission mode.
                      '--tools',
                      SKILL_TOOLS[opts.skill].web.join(','),
                      '--allowedTools',
                      skillAllowedTools(opts.skill, { linkedin: opts.linkedin !== false }).join(','),
                      ...(SKILL_TOOLS[opts.skill].gmail.length ? ['--disallowedTools', gmailDeniedTools(opts.skill).join(',')] : []),
                      '--permission-mode',
                      'dontAsk',
                    ]),
          '--permission-prompts',
          'none',
          '--output-format',
          'json',
          // LinkedIn people reads (wave1-decisions #4, #82) and fill's portal reads (#81) go through Claude in Chrome;
          // the Gmail step reads no LinkedIn, and config.linkedin.mode other than `live` turns it off for connect and voice.
          ...(usesChrome(opts.skill, opts.linkedin !== false) && !opts.gmailDraft && !opts.gmailTo ? ['--chrome'] : []),
          ...extra,
        ],
        cwd: home,
        env,
        files: [],
      };
    }
    case 'codex': {
      const toml = (v: unknown) => JSON.stringify(v);
      const envPairs = Object.entries(env).flatMap(([k, v]) => ['-c', `mcp_servers.${MCP_SERVER_NAME}.env.${k}=${toml(v)}`]);
      return {
        runId,
        command: 'codex',
        args: [
          'exec',
          // PP_HOME is never a git repo (rule 5).
          '--skip-git-repo-check',
          '-c',
          `mcp_servers.${MCP_SERVER_NAME}.command=${toml(mcp.command)}`,
          '-c',
          `mcp_servers.${MCP_SERVER_NAME}.args=${toml(mcp.args)}`,
          ...envPairs,
          // Headless: nobody can approve a prompt; MCP tool calls are otherwise cancelled.
          '-c',
          'approval_policy="never"',
          // Web search per skill (SKILL_TOOLS): live retrieval for web skills, the tool removed otherwise.
          '-c',
          `web_search=${toml(SKILL_TOOLS[opts.skill].web.length ? 'live' : 'disabled')}`,
          ...extra,
          prompt,
        ],
        cwd: home,
        env,
        files: [],
      };
    }
    case 'cursor-agent':
      return {
        runId,
        command: 'cursor-agent',
        args: ['-p', prompt, '--output-format', 'text', '--trust', '--approve-mcps', '--force', ...extra],
        // cursor-agent reads MCP servers from the project's .cursor/mcp.json and permissions from
        // .cursor/cli.json: a fresh temp dir per run.
        cwd: null,
        env,
        files: [
          { path: '.cursor/mcp.json', content: `${JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: server } }, null, 2)}\n` },
          { path: '.cursor/cli.json', content: `${JSON.stringify({ permissions: cursorPermissions(opts.skill) }, null, 2)}\n` },
        ],
      };
  }
}

/** Where the spawn launcher keeps runner output and pid files (OS temp dir, never the vault). */
export const runnerDir = (base: string = tmpdir()) => join(base, 'pp-runs');

/** `process.kill(pid, 0)`: true if the process exists (EPERM = exists, owned by someone else). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Is the runner for `runId` still alive? Reads the pid file the spawn launcher wrote; no file (never
 * launched here, temp dir cleared by a reboot) = gone. The runner is detached, so it can outlive `pp up`.
 */
export function runnerAlive(runId: string, base: string = tmpdir()): boolean {
  try {
    const pid = Number.parseInt(readFileSync(join(runnerDir(base), `${runId}.pid`), 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 && pidAlive(pid);
  } catch {
    return false;
  }
}

/**
 * Spawns the runner detached; output goes to a log file in the OS temp dir (never the vault), next to
 * a `<runId>.pid` file (removed on exit) so a restarted `pp up` can tell a live runner from a dead one.
 * `exit` settles with the log when the runner ends, as long as this process is still alive.
 */
export function createSpawnLauncher(): RunnerLauncher {
  return {
    launch(spec) {
      const cwd = spec.cwd ?? mkdtempSync(join(tmpdir(), `pp-run-${spec.runId}-`));
      for (const f of spec.files) {
        const abs = join(cwd, f.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, f.content);
      }
      const logDir = runnerDir();
      const pidFile = join(logDir, `${spec.runId}.pid`);
      mkdirSync(logDir, { recursive: true });
      const logFile = join(logDir, `${spec.runId}.log`);
      const log = openSync(logFile, 'a');
      return new Promise((ok, fail) => {
        const child = spawn(spec.command, spec.args, {
          cwd,
          env: { ...process.env, ...spec.env },
          detached: true,
          stdio: ['ignore', log, log],
        });
        const exit = new Promise<RunnerExit>((done) => {
          child.once('exit', (code) => {
            rmSync(pidFile, { force: true });
            let output = '';
            try {
              output = readFileSync(logFile, 'utf8');
            } catch {
              // log gone: report the exit code only
            }
            done({ code, output, logFile });
          });
        });
        child.once('error', (e) => {
          closeSync(log);
          fail(e);
        });
        child.once('spawn', () => {
          closeSync(log);
          if (child.pid !== undefined) writeFileSync(pidFile, String(child.pid));
          child.unref();
          ok(child.pid === undefined ? { exit } : { pid: child.pid, exit });
        });
      });
    },
  };
}
