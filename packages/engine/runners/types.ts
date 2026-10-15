import type { AskChatEvent, RunnerConfig, Skill } from '@perfect-placement/contracts';

/*
 * One module per runner (#160): each `RunnerBinding` owns its command lines (headless run, Ask turn), how its
 * Ask output is parsed, and what only it needs (Claude's denied-tool report, Codex's schedule job env).
 * Shared pieces (grants, prompts, the pp MCP server, the spawn launcher) live next to them in runners/.
 */

export type RunnerCommand = RunnerConfig['command'];

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

/** `buildRunnerSpec`'s input: one headless skill run (`runs.start`). */
export interface RunRequest {
  runner: RunnerConfig;
  prompt: string;
  runId: string;
  skill: Skill;
  home: string;
  mcp: McpServerSpec;
  /**
   * The Gmail draft step (`runs.start` with `outreach_id`). Claude: no `--strict-mcp-config` (the claude.ai
   * Gmail connector must load), only its create_draft tool allowed next to pp, every other Gmail write denied, no Chrome.
   * Codex uses connected Gmail app/MCP capabilities; Cursor uses the configured Gmail MCP server.
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
  /**
   * `fill` with assist (#123): the absolute `<PP_HOME>/files/<role_id>` folder holding the rendered PDFs. Claude gets
   * `--add-dir <it>` (that folder only, never PP_HOME or files/) so Claude in Chrome's file_upload can read the PDFs.
   * Ignored for every other run. Codex passes this folder to PP's browser adapter, which permits
   * only its rendered PDFs, never as a Codex --add-dir writable root. Cursor documents no equivalent.
   */
  filesDir?: string;
}

/** What every binding's `run` gets: the request plus what `buildRunnerSpec` prepares for all runners. */
export interface RunContext extends RunRequest {
  /** `config.runner.args`, appended. */
  extra: readonly string[];
  /** The pp MCP server's env plus PP_RUN_ID (#50); also the runner process's env. */
  env: Record<string, string>;
  /** The pp MCP server as the runner's config names it. */
  server: McpServerSpec;
}

/** One Ask turn's process (#39). */
export interface AskSpec {
  command: RunnerCommand;
  args: string[];
  /** `null` = a fresh temp dir (Cursor reads its MCP config and permissions from the working directory). */
  cwd: string | null;
  env: Record<string, string>;
  files: RunnerFile[];
}

/** What every binding's `ask` gets, prepared by `buildAskSpec`. */
export interface AskContext {
  /** The user's message (with its context line). */
  message: string;
  /** The Ask agent's system prompt. */
  system: string;
  /** System prompt + recent turns + the message, for runners that do not resume a session here. */
  replay: string;
  /** Claude Code session to resume. */
  sessionId?: string | null;
  home: string;
  extra: readonly string[];
  /** The pp MCP server's env plus PP_ASK=1; also the runner process's env. */
  env: Record<string, string>;
  server: McpServerSpec;
}

/** The parser state a binding's Ask parser reads and feeds (`AskStreamParser` owns it). */
export interface AskSink {
  /** The runner's session / thread id, when it reported one. */
  sessionId: string | null;
  /** Reply text since the last tool call. */
  readonly reply: string;
  /** Tool calls started so far (a fallback id for calls without one). */
  readonly toolCount: number;
  text(delta: string): AskChatEvent[];
  tool(id: string, name: string): AskChatEvent[];
  result(id: string, ok: boolean, content: unknown): AskChatEvent[];
  /** The turn ended; `failure` (even empty) marks it failed. */
  finish(failure?: string): void;
  /** A failure reported before the turn ended. */
  fail(message: string): void;
}

/** One JSON line of a runner's Ask output to chat events. A fresh parser per turn: its state lives in the closure. */
export type AskLineParser = (line: Record<string, unknown>, sink: AskSink) => AskChatEvent[];

export interface RunnerBinding {
  readonly command: RunnerCommand;
  /** A headless skill run's command line. */
  run(r: RunContext): RunnerSpec;
  /** One Ask turn's command line. */
  ask(a: AskContext): AskSpec;
  /** A parser for one Ask turn's line-delimited JSON. */
  askParser(): AskLineParser;
  /** Tools the runner reported denying, from a finished run's output. Only Claude reports them. */
  deniedTools?(output: string): string[];
  /** Variables a scheduled job keeps for this runner, from the installing shell's env (Codex: browser locations). */
  jobEnv?(env: NodeJS.ProcessEnv): Record<string, string>;
}
