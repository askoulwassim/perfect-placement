import type { AskChatEvent, Skill } from '@perfect-placement/contracts';
import {
  BUILTIN_WRITE_TOOLS,
  CHROME_WRITE_TOOLS,
  CLAUDE_TEXT,
  CLAUDE_TOOL,
  GMAIL_DENIED_TOOLS,
  GMAIL_DRAFT_TOOL,
  GMAIL_GET_DRAFT_TOOL,
  GMAIL_TO_DENIED_TOOLS,
  GMAIL_UPDATE_TOOL,
  GMAIL_WRITE_TOOLS,
  SKILL_TOOLS,
  skillAllowedTools,
  usesChrome,
  type WebTool,
} from './claude-tools.js';
import { type Capability, GMAIL_STEP_CAPS, skillCapabilities } from './grants.js';
import { isObj, type Obj, str } from './json.js';
import { MCP_SERVER_NAME } from './mcp-server.js';
import type { AskContext, AskLineParser, AskSpec, GrantRequest, RunContext, RunnerBinding, RunnerSpec } from './types.js';

/* Claude Code: `claude -p`, flags checked against `claude --help` 2.1.x. */

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
          `${extra.join(', ')} ${extra.length > 1 ? 'are' : 'is'} not granted to ${skill}: if the skill truly needs it, add it to SKILL_TOOLS in packages/engine/runners/grants.ts (or to config.runner.args: ["--allowedTools", "${extra.join(',')}"]).`,
        ]
      : []),
  ];
  return `tool denied: ${tools.join(', ')} (headless ${skill} run, nobody can approve a prompt). Fix: ${fixes.join(' ')}`;
}

/** Web tools an Ask session may use (Claude Code names). */
export const ASK_WEB_TOOLS: readonly WebTool[] = ['WebSearch', 'WebFetch'];

/** Claude Code tool names an Ask session pre-approves: the pp MCP tools and web search / fetch. */
export const askAllowedTools = (): string[] => [`mcp__${MCP_SERVER_NAME}`, ...ASK_WEB_TOOLS];

function run(opts: RunContext): RunnerSpec {
  const { prompt, home, runId, extra, env, server } = opts;
  const addDir =
    opts.skill === 'fill' && opts.assist === true && opts.filesDir && !opts.gmailDraft && !opts.gmailTo ? ['--add-dir', opts.filesDir] : [];
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
      // #123: the fill assist's file_upload reads the rendered PDFs; the session may read that one folder only.
      // Followed by a flag, so the variadic --add-dir takes exactly this one directory.
      ...addDir,
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

function ask(opts: AskContext): AskSpec {
  const { system, extra, env, server, home } = opts;
  return {
    command: 'claude',
    args: [
      '-p',
      opts.message,
      '--append-system-prompt',
      system,
      '--mcp-config',
      JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: server } }),
      '--strict-mcp-config',
      // Built-ins narrowed to web search and fetch (no Bash, Read, Write or Edit), then pre-approved
      // with the pp tools; dontAsk + no prompts deny anything else.
      '--tools',
      ASK_WEB_TOOLS.join(','),
      '--allowedTools',
      askAllowedTools().join(','),
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      ...(opts.sessionId ? ['--resume', opts.sessionId] : []),
      ...extra,
    ],
    // Sessions are stored per working directory: always the vault, so --resume finds them.
    cwd: home,
    env,
    files: [],
  };
}

/** Claude `stream-json` (`--include-partial-messages`): text deltas, then the full message (its text skipped when deltas came). */
function askParser(): AskLineParser {
  /** Text deltas seen since the last full assistant message (so its text is not repeated). */
  let partial = false;
  return (j: Obj, s): AskChatEvent[] => {
    const sid = str(j.session_id);
    if (sid) s.sessionId = sid;
    switch (j.type) {
      case 'stream_event': {
        const ev = isObj(j.event) ? j.event : {};
        const delta = isObj(ev.delta) ? ev.delta : {};
        if (ev.type === 'content_block_delta' && delta.type === 'text_delta') {
          partial = true;
          return s.text(str(delta.text) ?? '');
        }
        return [];
      }
      case 'assistant': {
        const content = isObj(j.message) && Array.isArray(j.message.content) ? (j.message.content as unknown[]) : [];
        const out: AskChatEvent[] = [];
        for (const b of content) {
          if (!isObj(b)) continue;
          if (b.type === 'text' && !partial) out.push(...s.text(str(b.text) ?? ''));
          if (b.type === 'tool_use') out.push(...s.tool(str(b.id) ?? `t${s.toolCount}`, str(b.name) ?? 'tool'));
        }
        partial = false;
        return out;
      }
      case 'user': {
        const content = isObj(j.message) && Array.isArray(j.message.content) ? (j.message.content as unknown[]) : [];
        return content.flatMap((b) =>
          isObj(b) && b.type === 'tool_result' ? s.result(str(b.tool_use_id) ?? '', b.is_error !== true, b.content) : [],
        );
      }
      case 'result':
        s.finish(
          j.is_error === true || (typeof j.subtype === 'string' && j.subtype !== 'success')
            ? (str(j.result) ?? (Array.isArray(j.errors) ? j.errors.map(String).join('; ') : str(j.subtype)) ?? '')
            : undefined,
        );
        return [];
      default:
        return [];
    }
  };
}

/**
 * Claude's grants: the skill's (#20), or a Gmail step's. Claude in Chrome reads the PDFs through `--add-dir`, granted
 * with the fill assist whether or not they were rendered (a render failure is in the Uploads line).
 */
export function claudeGrants(g: GrantRequest): Capability[] {
  if (g.mode && g.mode !== 'skill') return [...GMAIL_STEP_CAPS[g.mode]];
  return skillCapabilities(g.skill, { linkedin: g.linkedin !== false, assist: g.assist === true });
}

/** The prompt's Tools line in Claude's names: every granted tool. */
export const claudeToolsPhrase = (caps: readonly Capability[]): string =>
  caps.length ? ` and ${caps.map((c) => CLAUDE_TOOL[c]).join(', ')}` : '';

export const claude: RunnerBinding = {
  command: 'claude',
  grants: claudeGrants,
  text: CLAUDE_TEXT,
  toolsPhrase: claudeToolsPhrase,
  run,
  ask,
  askParser,
  deniedTools,
};
