import { z } from 'zod';

/*
 * Ask (Cmd+K) as a real agent session (#39). `POST /api/ask` on `pp up` takes an `AskChatRequest` and
 * answers with a Server-Sent Events stream of `AskChatEvent`s (`data: <json>\n\n`): the configured runner
 * (`config.runner`) runs one conversational turn with the pp MCP server, and its output is normalized
 * here so the UI does not care which agent CLI is behind it.
 */

/** Where the user was when they asked (the agent reads it as context, never as an instruction). */
export const AskChatContext = z.object({
  screen: z.string().max(40).optional(),
  role_id: z.string().max(200).optional(),
});
export type AskChatContext = z.infer<typeof AskChatContext>;

export const AskChatRequest = z.object({
  /** The thread to continue (from an earlier `thread` event); absent = a new thread. */
  thread_id: z.string().max(80).optional(),
  message: z.string().trim().min(1).max(8000),
  context: AskChatContext.optional(),
});
export type AskChatRequest = z.infer<typeof AskChatRequest>;

export const ASK_CHAT_ERROR_CODES = [
  /** The runner CLI is not on PATH. */
  'runner_missing',
  /** The runner is installed but not signed in. */
  'not_logged_in',
  /** The runner exited with an error, or produced nothing. */
  'runner_failed',
  /** Another message in this thread is still running. */
  'busy',
  'invalid_input',
  /** No agent behind this client (read-only mock, server down). */
  'unavailable',
] as const;
export type AskChatErrorCode = (typeof ASK_CHAT_ERROR_CODES)[number];

export const AskChatEvent = z.discriminatedUnion('type', [
  /** First event of every turn: the thread to send back next time. */
  z.object({ type: z.literal('thread'), thread_id: z.string(), runner: z.string() }),
  /** Reply text as it streams: OpenUI Lang cards (genui) and short prose. */
  z.object({ type: z.literal('text'), delta: z.string() }),
  /** The agent called a tool. `op` is the pp op for pp MCP tools, else null (web tools). */
  z.object({ type: z.literal('tool'), id: z.string(), name: z.string(), op: z.string().nullable() }),
  z.object({ type: z.literal('tool_result'), id: z.string(), ok: z.boolean() }),
  /** The agent started (queued) a skill run with `runs.start`. */
  z.object({ type: z.literal('run'), run_id: z.string(), skill: z.string() }),
  z.object({ type: z.literal('error'), code: z.enum(ASK_CHAT_ERROR_CODES), message: z.string() }),
  /** Last event of a turn that did not fail. */
  z.object({ type: z.literal('done') }),
]);
export type AskChatEvent = z.infer<typeof AskChatEvent>;

/** One SSE frame for an event. */
export const askChatFrame = (e: AskChatEvent): string => `data: ${JSON.stringify(e)}\n\n`;

/**
 * Parse an SSE byte stream's text into events: pass the buffered text, get the complete events and the
 * unconsumed rest. Frames that are not valid `AskChatEvent`s are skipped.
 */
export function parseAskChatFrames(buffer: string): { events: AskChatEvent[]; rest: string } {
  const events: AskChatEvent[] = [];
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? '';
  for (const part of parts) {
    const data = part
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    try {
      const parsed = AskChatEvent.safeParse(JSON.parse(data));
      if (parsed.success) events.push(parsed.data);
    } catch {
      // not JSON: skip
    }
  }
  return { events, rest };
}
