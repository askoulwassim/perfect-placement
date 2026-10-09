import type { AskLauncher, AskSpec } from '../ops/ask.js';

/*
 * TEST-ONLY Ask doubles (#39): recorded runner transcripts (synthetic, shaped like each CLI's real
 * line-delimited JSON) and a launcher that replays them. Nothing spawns an agent.
 */

const j = (v: unknown) => JSON.stringify(v);

export interface RecordedTool {
  /** Claude Code tool name, e.g. `mcp__pp__runs_start`. */
  name: string;
  input?: unknown;
  /** The tool result text (the pp MCP server returns the op output as JSON text). */
  result: string;
  isError?: boolean;
}

/**
 * A Claude Code `stream-json` turn (`--verbose --include-partial-messages`): an optional note, the tool
 * calls with their results, then the reply streamed as text deltas and repeated in the full message.
 */
export function claudeTranscript(o: { sessionId?: string; note?: string; tools?: RecordedTool[]; reply: string }): string[] {
  const sid = o.sessionId ?? 'sess-0001';
  const delta = (text: string) =>
    j({ type: 'stream_event', session_id: sid, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  const start = j({ type: 'stream_event', session_id: sid, event: { type: 'message_start' } });
  return [
    j({ type: 'system', subtype: 'init', session_id: sid, tools: (o.tools ?? []).map((t) => t.name) }),
    ...(o.note
      ? [start, delta(o.note), j({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: o.note }] } })]
      : []),
    ...(o.tools ?? []).flatMap((t, i) => [
      j({
        type: 'assistant',
        session_id: sid,
        message: { content: [{ type: 'tool_use', id: `tu_${i + 1}`, name: t.name, input: t.input ?? {} }] },
      }),
      j({
        type: 'user',
        session_id: sid,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: `tu_${i + 1}`,
              content: [{ type: 'text', text: t.result }],
              ...(t.isError ? { is_error: true } : {}),
            },
          ],
        },
      }),
    ]),
    start,
    ...(o.reply.match(/[\s\S]{1,7}/g) ?? []).map(delta),
    j({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: o.reply }] } }),
    j({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: o.reply }),
  ];
}

/** "Score my inbox roles": lists the inbox, starts a score run, replies with a card. */
export function claudeScoreTranscript(o: { sessionId?: string; runId?: string; reply?: string } = {}): string[] {
  return claudeTranscript({
    ...(o.sessionId ? { sessionId: o.sessionId } : {}),
    note: 'Checking the inbox.',
    tools: [
      { name: 'mcp__pp__roles_list', input: { status: ['inbox'] }, result: '{"items":[]}' },
      {
        name: 'mcp__pp__runs_start',
        input: { skill: 'score' },
        result: j({ run: { id: o.runId ?? 'run_0001', op: 'score', status: 'queued' } }),
      },
    ],
    reply: o.reply ?? 'root = Reply([t])\nt = Text("Score run started for 3 inbox roles")',
  });
}

/** Claude Code signed out: the `result` line is an error. */
export const claudeLoggedOutTranscript = (): string[] => [
  j({ type: 'system', subtype: 'init', session_id: 'sess-x' }),
  j({ type: 'result', subtype: 'success', is_error: true, session_id: 'sess-x', result: 'Invalid API key · Please run /login' }),
];

/** A Codex `exec --json` turn with one pp MCP call. */
export const codexTranscript = (): string[] => [
  j({ type: 'thread.started', thread_id: 'th-0001' }),
  j({ type: 'turn.started' }),
  j({
    type: 'item.started',
    item: { id: 'item_0', type: 'mcp_tool_call', server: 'pp', tool: 'runs_start', arguments: { skill: 'scout' }, status: 'in_progress' },
  }),
  j({
    type: 'item.completed',
    item: {
      id: 'item_0',
      type: 'mcp_tool_call',
      server: 'pp',
      tool: 'runs_start',
      status: 'completed',
      result: { content: [{ type: 'text', text: j({ run: { id: 'run_0002', op: 'scout' } }) }] },
    },
  }),
  j({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'root = Reply([t])\nt = Text("Scout run started")' } }),
  j({ type: 'turn.completed', usage: {} }),
];

/** A Cursor `stream-json` turn. */
export const cursorTranscript = (): string[] => [
  j({ type: 'system', subtype: 'init', session_id: 'cur-0001' }),
  j({ type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { mcpToolCall: { args: { toolName: 'roles_list', args: {} } } } }),
  j({
    type: 'tool_call',
    subtype: 'completed',
    call_id: 'c1',
    tool_call: { mcpToolCall: { args: { toolName: 'roles_list' }, result: { success: { content: [] } } } },
  }),
  j({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'root = Reply([t])\nt = Text("Nothing in the inbox")' }] },
    session_id: 'cur-0001',
  }),
  j({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'cur-0001' }),
];

export interface FakeAskLauncher extends AskLauncher {
  specs: AskSpec[];
}

/**
 * Replays a transcript per launch: `script(spec, n)` returns the stdout lines (and optionally an exit
 * code and stderr), or `'missing'` to fail like a runner that is not installed (ENOENT).
 */
export function fakeAskLauncher(
  script: (spec: AskSpec, n: number) => string[] | { lines: string[]; code?: number; stderr?: string } | 'missing' | Promise<string[]>,
): FakeAskLauncher {
  const specs: AskSpec[] = [];
  return {
    specs,
    async start(spec) {
      specs.push(spec);
      const out = await script(spec, specs.length - 1);
      if (out === 'missing') throw Object.assign(new Error(`spawn ${spec.command} ENOENT`), { code: 'ENOENT' });
      const { lines, code = 0, stderr = '' } = Array.isArray(out) ? { lines: out } : out;
      return {
        lines: (async function* () {
          for (const l of lines) {
            await Promise.resolve();
            yield l;
          }
        })(),
        exit: Promise.resolve({ code, stderr }),
      };
    },
  };
}
