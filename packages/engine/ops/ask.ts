import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  ASK_THREAD_MAX_TURNS,
  ASK_THREAD_TTL_DAYS,
  type AskChatContext,
  type AskChatErrorCode,
  type AskChatEvent,
  AskChatRequest,
  OP_NAMES,
  type RUNNER_COMMANDS,
  type RunnerConfig,
} from '@perfect-placement/contracts';
import type { AskThreadStore } from '../db/ask-threads.js';
import { isObj, type Obj } from '../runners/json.js';
import { MCP_SERVER_NAME } from '../runners/mcp-server.js';
import { RUNNERS } from '../runners/registry.js';
import type { AskSink, AskSpec, McpServerSpec } from '../runners/types.js';
import { newId } from './ids.js';

/*
 * Ask (Cmd+K) as a real agent session (#39). `pp up` serves `POST /api/ask`: each message runs one
 * conversational turn of the configured runner (`config.runner`) with the pp MCP server, streams its
 * output as `AskChatEvent`s, and keeps a thread so the next message continues the conversation (Claude Code:
 * `--resume <session_id>`; Codex and Cursor: a short transcript replayed in the prompt).
 *
 * Tools: every pp MCP tool plus web search / fetch for answering questions; no shell, no file reads or
 * writes. The MCP server runs with PP_ASK=1, so `runs.start` queues a headless skill run (the chat
 * delegates skill work) instead of making the chat the run. The policy is the engine's: medium and high
 * impact go through the decision layer; submit and send are always the human's.
 *
 * The launch is injected (`AskLauncher`): tests replay recorded transcripts and never spawn an agent.
 */

type RunnerCommand = (typeof RUNNER_COMMANDS)[number];

/**
 * The cards an Ask reply may use: the genui library's signatures (apps/web/genui/src/library.tsx,
 * `askSystemPrompt()`), copied verbatim; a web test fails if they drift.
 */
export const ASK_CARD_SIGNATURES = [
  'Reply(items: (Group | Text | RoleCard | ScoreRadar | ContactCard | ProfileDiff | OpButton)[]) — Root of every Ask reply: a vertical stack.',
  'Group(label: string, items: (Text | RoleCard | ScoreRadar | ContactCard | ProfileDiff | OpButton)[]) — A labelled row of cards, e.g. one role with its radar and people. Label is 1 to 3 words.',
  'Text(text: string) — One short line of reply text, 3 to 12 words. No em dashes, no tips.',
  'RoleCard(roleId: string) — A role with company, title, freshness and fit. Pass the role id exactly as given in context.',
  'ScoreRadar(roleId: string) — The nine-criterion fit radar for a role. Use when the user asks why a role fits.',
  'ContactCard(contactId: string, roleId?: string) — A person who can open a door, with their tier ring. Pass roleId to show the tier for that role.',
  'ProfileDiff(diffId: string) — A pending profile change, before vs after. Pass the diff id.',
  'OpButton(label: string, op: "runs.start" | "roles.check_freshness" | "profile.apply_diff", ids?: string[], skill?: "onboard" | "scout" | "score" | "freshness" | "research" | "tailor" | "connect" | "fill" | "inbox" | "learn" | "voice") — One button that runs one op on what the reply shows. Label 1 to 3 words. op is one of runs.start, roles.check_freshness, profile.apply_diff. ids: role ids for roles.check_freshness; [roleId, contactId?] for runs.start (with skill); [diffId] for profile.apply_diff. Never submit or send.',
] as const;

/** The Ask agent's system prompt: who it is, how it acts, the policy, and the reply format. */
export function askAgentPrompt(): string {
  const t = (op: string) => op.replace(/\./g, '_');
  return [
    'You are the Perfect Placement assistant, answering in the Ask panel (Cmd+K) of the user job-search app.',
    '',
    '## How you act',
    `- Every read and write goes through the ${MCP_SERVER_NAME} MCP tools: one tool per op, dots as underscores (roles.list is ${t('roles.list')}). Never edit files or the database; you have no shell.`,
    `- Answer questions from current data (${['roles.list', 'roles.get', 'runs.list', 'decisions.queue', 'profile.get', 'contacts.get', 'outreach.list'].map(t).join(', ')}). Use web search and fetch only to answer questions about companies or postings.`,
    `- Skill work (scout, score, research, tailor, fill, connect, freshness, inbox, learn, voice) is a headless run: start it with ${t('runs.start')} { skill, role_id?, contact_id? } (it is queued and runs on its own) and say which run you started. Never do the skill's work yourself in this chat. "Score my inbox roles" is ${t('runs.start')} { skill: "score" }.`,
    `- An answer to an application question for the role in focus, when the user wants it kept: save it with ${t('apply.fill')} { role_id, answers: [{ question, kind: "written", answer }] } (draft-ready roles only; it merges into that role's Answers as Saved from Ask). Ground it in Story only, no em dashes.`,
    '- Policy: medium-impact writes take a confidence (0 to 1); without it they wait for the human. A requires_human result went to Needs you: say so, do not retry. High impact goes to the human.',
    '- Never submit an application and never send an email (always the human). Gmail is drafts only. Never change a dealbreaker or the comp floor.',
    '',
    '## How you reply',
    'Write the reply as OpenUI Lang, one statement per line, `root = Reply(...)` first, then each name it references. Arguments are positional. Every defined name must be reachable from root. Reference roles, contacts and diffs by their ids; never restate titles, scores or names (the cards fetch them). At most one Text line and at most one OpButton. No em dashes, no tips, no markdown. Before the reply you may write one short plain line of what you did.',
    '',
    ...ASK_CARD_SIGNATURES,
    '',
    'Example:',
    'root = Reply([t, r])',
    't = Text("Score run started for your inbox")',
    'r = RoleCard("linear_product-lead-insights")',
  ].join('\n');
}

/** One finished turn, kept for transcript replay. */
export interface AskTurn {
  user: string;
  reply: string;
  /** How long the turn took, launch to done (#100): the agent card's latency. */
  ms?: number;
}

/** Turns replayed into a Codex / Cursor prompt (the newest ones, each capped). */
export const ASK_REPLAY_TURNS = 6;
const REPLAY_CHARS = 1200;

/** The user's message with the screen they asked from. */
export function askMessage(message: string, context?: AskChatContext): string {
  if (!context || (!context.screen && !context.role_id)) return message;
  const parts = [
    ...(context.screen ? [`screen: ${context.screen}`] : []),
    ...(context.role_id ? [`role in focus: ${context.role_id}`] : []),
  ];
  return `[context] ${parts.join('; ')}\n\n${message}`;
}

/** System prompt + the last turns + the new message, for runners that do not resume a session here. */
export function replayPrompt(system: string, turns: readonly AskTurn[], message: string): string {
  const cap = (s: string) => (s.length > REPLAY_CHARS ? `${s.slice(0, REPLAY_CHARS)}...` : s);
  const recent = turns.slice(-ASK_REPLAY_TURNS);
  return [
    system,
    ...(recent.length
      ? ['', '## Conversation so far', ...recent.flatMap((t) => [`User: ${cap(t.user)}`, `Assistant: ${cap(t.reply)}`])]
      : []),
    '',
    '## New message',
    message,
  ].join('\n');
}

export type { AskSpec } from '../runners/types.js';

/** One Ask turn's command line per runner (flags checked against `claude --help` 2.1.x, Codex and Cursor docs). */
export function buildAskSpec(opts: {
  runner: RunnerConfig;
  /** The user's message (with its context line). */
  message: string;
  home: string;
  mcp: McpServerSpec;
  system?: string;
  /** Claude Code session to resume. */
  sessionId?: string | null;
  /** Earlier turns, replayed for Codex and Cursor. */
  turns?: readonly AskTurn[];
}): AskSpec {
  const { runner, mcp, home } = opts;
  const system = opts.system ?? askAgentPrompt();
  const extra = runner.args ?? [];
  const env = { ...mcp.env, PP_ASK: '1' };
  const server = { command: mcp.command, args: mcp.args, env };
  return RUNNERS[runner.command].ask({
    message: opts.message,
    system,
    replay: replayPrompt(system, opts.turns ?? [], opts.message),
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    home,
    extra,
    env,
    server,
  });
}

// ------------------------------------------------------------------ stream parsing

const TOOL_OPS = new Map<string, string>(OP_NAMES.map((op) => [op.replace(/\./g, '_'), op]));

/** The pp op behind a tool name (`mcp__pp__roles_list`, `roles_list`, `pp-roles_list`), else null. */
export function opOfTool(name: string): string | null {
  const bare = name.replace(new RegExp(`^mcp__${MCP_SERVER_NAME}__`), '').replace(new RegExp(`^${MCP_SERVER_NAME}[-:.]`), '');
  return TOOL_OPS.get(bare) ?? (OP_NAMES as readonly string[]).find((op) => op === bare) ?? null;
}

/** A `runs.start` output (`{ run: { id, op } }`) anywhere in a tool result (objects, arrays, JSON text). */
export function findRun(v: unknown, depth = 0): { run_id: string; skill: string } | null {
  if (depth > 6) return null;
  if (typeof v === 'string') {
    if (!v.includes('"run"')) return null;
    try {
      return findRun(JSON.parse(v), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = findRun(x, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (!isObj(v)) return null;
  const run = v.run;
  if (isObj(run) && typeof run.id === 'string' && typeof run.op === 'string') return { run_id: run.id, skill: run.op };
  for (const x of Object.values(v)) {
    const r = findRun(x, depth + 1);
    if (r) return r;
  }
  return null;
}

const LOGIN = /not logged in|log ?in|\/login|authenticat|unauthori[sz]ed|invalid api key|api[_ ]key|credentials/i;

/** Error code for a runner failure message. */
export const classifyAskFailure = (text: string): AskChatErrorCode => (LOGIN.test(text) ? 'not_logged_in' : 'runner_failed');

/**
 * Turns a runner's line-delimited JSON (Claude `stream-json`, Codex `exec --json`, Cursor `stream-json`)
 * into `AskChatEvent`s. Unknown lines are ignored.
 */
export class AskStreamParser {
  /** The runner's session / thread id, when it reported one. */
  sessionId: string | null = null;
  /** Reply text since the last tool call (what the transcript keeps). */
  reply = '';
  private failure: string | null = null;
  private finished = false;
  private sawText = false;
  private readonly tools = new Map<string, string>();
  private readonly started = new Set<string>();
  private readonly parse: ReturnType<(typeof RUNNERS)[RunnerCommand]['askParser']>;
  private readonly sink: AskSink;

  constructor(private readonly runner: RunnerCommand) {
    this.parse = RUNNERS[runner].askParser();
    const parser = this;
    this.sink = {
      get sessionId() {
        return parser.sessionId;
      },
      set sessionId(id) {
        parser.sessionId = id;
      },
      get reply() {
        return parser.reply;
      },
      get toolCount() {
        return parser.started.size;
      },
      text: (delta) => this.text(delta),
      tool: (id, name) => this.tool(id, name),
      result: (id, ok, content) => this.result(id, ok, content),
      finish: (failure) => {
        this.finished = true;
        if (failure !== undefined) this.failure = failure;
      },
      fail: (message) => {
        this.failure = message;
      },
    };
  }

  push(line: string): AskChatEvent[] {
    const s = line.trim();
    if (!s.startsWith('{')) return [];
    let j: unknown;
    try {
      j = JSON.parse(s);
    } catch {
      return [];
    }
    if (!isObj(j)) return [];
    return this.parse(j as Obj, this.sink);
  }

  /** The turn's last event, from the exit code and stderr. */
  end(code: number | null, stderr = ''): AskChatEvent {
    const fail = (message: string): AskChatEvent => ({ type: 'error', code: classifyAskFailure(message), message });
    if (this.failure !== null) return fail(this.failure || stderr.trim() || 'the runner failed');
    if (code !== 0 && code !== null && !this.finished) return fail(tail(stderr) || `${this.runner} exited with code ${code}`);
    if (!this.sawText && !this.finished) return fail(tail(stderr) || `${this.runner} gave no reply`);
    return { type: 'done' };
  }

  private text(delta: string): AskChatEvent[] {
    if (!delta) return [];
    this.sawText = true;
    this.reply += delta;
    return [{ type: 'text', delta }];
  }

  private tool(id: string, name: string): AskChatEvent[] {
    if (this.started.has(id)) return [];
    this.started.add(id);
    this.tools.set(id, name);
    this.reply = '';
    return [{ type: 'tool', id, name, op: opOfTool(name) }];
  }

  private result(id: string, ok: boolean, content: unknown): AskChatEvent[] {
    const out: AskChatEvent[] = [{ type: 'tool_result', id, ok }];
    const name = this.tools.get(id) ?? '';
    if (ok && (opOfTool(name) === 'runs.start' || name === '')) {
      const run = findRun(content);
      if (run) out.push({ type: 'run', ...run });
    }
    return out;
  }
}

const tail = (s: string, n = 400) => {
  const t = s.trim();
  return t.length > n ? `...${t.slice(-n)}` : t;
};

// ------------------------------------------------------------------ launching

export interface AskProcess {
  /** stdout, line by line. */
  lines: AsyncIterable<string>;
  /** Settles when the process exits (stderr tail for error messages). */
  exit: Promise<{ code: number | null; stderr: string }>;
}

export interface AskLauncher {
  /** Start the runner; reject if it cannot start (ENOENT = not installed). Abort kills it. */
  start(spec: AskSpec, signal?: AbortSignal): Promise<AskProcess>;
}

/** Spawns the runner attached (not detached: an Ask turn ends with its HTTP request). */
export function createAskSpawner(): AskLauncher {
  return {
    start(spec, signal) {
      const temp = spec.cwd === null;
      const cwd = spec.cwd ?? mkdtempSync(join(tmpdir(), 'pp-ask-'));
      for (const f of spec.files) {
        const abs = join(cwd, f.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, f.content);
      }
      const cleanup = () => {
        if (temp) rmSync(cwd, { recursive: true, force: true });
      };
      return new Promise((ok, fail) => {
        const child = spawn(spec.command, spec.args, { cwd, env: { ...process.env, ...spec.env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d: Buffer) => {
          stderr = (stderr + d.toString('utf8')).slice(-8000);
        });
        const kill = () => child.kill('SIGTERM');
        signal?.addEventListener('abort', kill, { once: true });
        const exit = new Promise<{ code: number | null; stderr: string }>((done) => {
          child.once('close', (code) => {
            signal?.removeEventListener('abort', kill);
            cleanup();
            done({ code, stderr });
          });
        });
        child.once('error', (e) => {
          cleanup();
          fail(e);
        });
        child.once('spawn', () => ok({ lines: createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY }), exit }));
      });
    },
  };
}

// ------------------------------------------------------------------ threads + one turn

export interface AskThread {
  id: string;
  createdAt: string;
  runner: RunnerCommand;
  sessionId: string | null;
  turns: AskTurn[];
  busy: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Ask threads: in memory for the life of `pp up` (at most `max`), and with a store also in the vault, so
 * a restart resumes a thread by id (#69). Threads idle for ASK_THREAD_TTL_DAYS are pruned on open and on
 * every new thread.
 */
export class AskThreads {
  private readonly map = new Map<string, AskThread>();
  private readonly max: number;
  private readonly store: AskThreadStore | undefined;
  private readonly now: () => Date;

  /** The threads' clock (turn timing uses it too, so tests stay deterministic). */
  time(): number {
    return this.now().getTime();
  }

  constructor(opts: { max?: number; store?: AskThreadStore; now?: () => Date } = {}) {
    this.max = opts.max ?? 50;
    this.store = opts.store;
    this.now = opts.now ?? (() => new Date());
    this.prune();
  }

  get(id: string | undefined): AskThread | undefined {
    if (!id) return undefined;
    const hit = this.map.get(id);
    if (hit) return hit;
    const row = this.store?.load(id);
    if (!row) return undefined;
    const t: AskThread = {
      id: row.id,
      createdAt: row.created_at,
      runner: row.runner,
      sessionId: row.session_id,
      turns: row.turns_json.map((x) => ({ ...x })),
      busy: false,
    };
    this.remember(t);
    return t;
  }

  create(runner: RunnerCommand): AskThread {
    this.prune();
    const at = this.now();
    const t: AskThread = {
      id: newId('ask_thread', at),
      createdAt: at.toISOString(),
      runner,
      sessionId: null,
      turns: [],
      busy: false,
    };
    this.remember(t);
    this.save(t);
    return t;
  }

  /** Keep a finished turn (the newest ASK_THREAD_MAX_TURNS) and the session id, then persist. */
  record(t: AskThread, turn: AskTurn, sessionId: string | null): void {
    if (sessionId) t.sessionId = sessionId;
    t.turns.push(turn);
    if (t.turns.length > ASK_THREAD_MAX_TURNS) t.turns.splice(0, t.turns.length - ASK_THREAD_MAX_TURNS);
    this.save(t);
  }

  private save(t: AskThread): void {
    this.store?.save({
      id: t.id,
      created_at: t.createdAt,
      updated_at: this.now().toISOString(),
      runner: t.runner,
      session_id: t.sessionId,
      turns_json: t.turns,
    });
  }

  private prune(): void {
    this.store?.prune(new Date(this.now().getTime() - ASK_THREAD_TTL_DAYS * DAY_MS).toISOString());
  }

  private remember(t: AskThread): void {
    this.map.set(t.id, t);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }
}

export { type AskThreadStore, dbAskThreadStore } from '../db/ask-threads.js';

export interface AskDeps {
  home: string;
  runner: RunnerConfig;
  mcp: McpServerSpec;
  launcher: AskLauncher;
  threads: AskThreads;
  signal?: AbortSignal;
}

/** One Ask turn: validate, pick or start the thread, launch the runner, stream its events. */
export async function* runAsk(raw: unknown, deps: AskDeps): AsyncGenerator<AskChatEvent> {
  const parsed = AskChatRequest.safeParse(raw);
  if (!parsed.success) {
    yield { type: 'error', code: 'invalid_input', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    return;
  }
  const req = parsed.data;
  const runner = deps.runner;
  let thread = deps.threads.get(req.thread_id);
  // Session ids are per runner: a changed runner starts a new thread.
  if (!thread || thread.runner !== runner.command) thread = deps.threads.create(runner.command);
  if (thread.busy) {
    yield { type: 'error', code: 'busy', message: 'still answering the last message' };
    return;
  }
  thread.busy = true;
  try {
    yield { type: 'thread', thread_id: thread.id, runner: runner.command };
    const message = askMessage(req.message, req.context);
    const spec = buildAskSpec({ runner, message, home: deps.home, mcp: deps.mcp, sessionId: thread.sessionId, turns: thread.turns });
    const started = deps.threads.time();
    let proc: AskProcess;
    try {
      proc = await deps.launcher.start(spec, deps.signal);
    } catch (e) {
      const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
      yield missing
        ? { type: 'error', code: 'runner_missing', message: `${runner.command} is not installed or not on PATH (config.runner)` }
        : { type: 'error', code: 'runner_failed', message: `${runner.command} did not start: ${(e as Error).message}` };
      return;
    }
    const parser = new AskStreamParser(runner.command);
    for await (const line of proc.lines) {
      if (deps.signal?.aborted) break;
      yield* parser.push(line);
    }
    const exit = await proc.exit;
    if (deps.signal?.aborted) return;
    const last = parser.end(exit.code, exit.stderr);
    if (last.type === 'done')
      deps.threads.record(
        thread,
        { user: req.message, reply: parser.reply.trim(), ms: Math.max(0, deps.threads.time() - started) },
        parser.sessionId,
      );
    yield last;
  } finally {
    thread.busy = false;
  }
}
