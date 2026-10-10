import Anthropic from '@anthropic-ai/sdk';
import type { AskRequest, BackendResult, DecisionBackend, Question } from '@perfect-placement/contracts';
import { z } from 'zod';
import { BackendUnavailableError } from '../errors.js';
import type { RichAnswer } from './systemone.js';

/*
 * LLM backend (Anthropic). Answers the same typed questions as Kev, as a fallback and a second
 * opinion. Output is constrained with structured outputs; the reply is parsed and validated, and
 * any malformed answer fails the backend so the resolver falls back to the human queue.
 */

export const DEFAULT_LLM_MODEL = 'claude-opus-5-5';

/** Transport seam: returns the raw JSON text. Tests inject a fake; production uses `anthropicCall`. */
export type LlmCall = (req: { system: string; user: string; schema: Record<string, unknown> }) => Promise<string>;

const SYSTEM = [
  'You answer typed decision questions about a job-search pipeline.',
  'For each question, return exactly one answer with the question id, a value, and p, your calibrated probability (0 to 1) that the value is correct.',
  'Value format: choice questions return one of the listed options verbatim; yes/no questions return "true" or "false"; score questions return an integer within the stated range.',
  'Use only the state provided. If unsure, pick the most likely value and give a low p. For choice questions, use "other" when no option fits.',
].join('\n');

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, value: { type: 'string' }, p: { type: 'number' } },
        required: ['id', 'value', 'p'],
        additionalProperties: false,
      },
    },
  },
  required: ['answers'],
  additionalProperties: false,
} as const;

const LlmReply = z.object({ answers: z.array(z.object({ id: z.string(), value: z.string(), p: z.number() })) });

function describe(q: Question): string {
  switch (q.type) {
    case 'choice':
      return `- id: ${q.id} | type: choice | options: ${q.options.join(', ')}\n  ${q.instructions}`;
    case 'noulli':
      return `- id: ${q.id} | type: yes/no\n  ${q.instructions}`;
    case 'score':
      return `- id: ${q.id} | type: score | integer ${q.min} to ${q.max}\n  ${q.instructions}`;
  }
}

export function buildPrompt(req: AskRequest): string {
  const state =
    typeof req.state === 'string'
      ? req.state
      : Object.entries(req.state)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n');
  return `<state>\n${state}\n</state>\n\nQuestions:\n${req.questions.map(describe).join('\n')}`;
}

export function parseValue(q: Question, raw: string): RichAnswer['value'] | undefined {
  const v = raw.trim();
  switch (q.type) {
    case 'choice':
      return q.options.find((o) => o.toLowerCase() === v.toLowerCase());
    case 'noulli':
      if (/^(true|yes)$/i.test(v)) return true;
      if (/^(false|no)$/i.test(v)) return false;
      return undefined;
    case 'score': {
      const n = Math.round(Number(v));
      return Number.isFinite(n) && n >= q.min && n <= q.max ? n : undefined;
    }
  }
}

export function createLlmBackend(opts: { call: LlmCall; clock?: () => number; available?: () => boolean }): DecisionBackend {
  const clock = opts.clock ?? Date.now;
  return {
    name: 'llm',
    async ask(req: AskRequest): Promise<BackendResult> {
      const started = clock();
      let text: string;
      try {
        text = await opts.call({ system: SYSTEM, user: buildPrompt(req), schema: ANSWER_SCHEMA as unknown as Record<string, unknown> });
      } catch (cause) {
        if (cause instanceof BackendUnavailableError) throw cause;
        throw new BackendUnavailableError('llm', 'call failed', { cause });
      }
      let parsed: z.infer<typeof LlmReply>;
      try {
        parsed = LlmReply.parse(JSON.parse(text));
      } catch (cause) {
        throw new BackendUnavailableError('llm', 'malformed reply', { cause });
      }
      const answers = req.questions.map((q): RichAnswer => {
        const a = parsed.answers.find((x) => x.id === q.id);
        const value = a ? parseValue(q, a.value) : undefined;
        if (!a || value === undefined) throw new BackendUnavailableError('llm', `bad answer for '${q.id}'`);
        return { id: q.id, value, p: Math.min(1, Math.max(0, a.p)) };
      });
      return { answers, latencyMs: Math.max(0, clock() - started) };
    },
    async health() {
      return { ok: opts.available ? opts.available() : true };
    },
  };
}

/**
 * Production transport over the official SDK. Thinking stays adaptive at low effort (classification).
 * Server-side refusal fallback is on ("default" routing), per current API guidance.
 */
export function anthropicCall(opts: { apiKey?: string; model?: string; client?: Anthropic } = {}): LlmCall {
  const client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  const model = opts.model ?? DEFAULT_LLM_MODEL;
  return async ({ system, user, schema }) => {
    try {
      const res = await client.beta.messages.create({
        model,
        max_tokens: 4096,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system,
        output_config: { effort: 'low', format: { type: 'json_schema', schema } },
        messages: [{ role: 'user', content: user }],
      });
      if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') {
        throw new BackendUnavailableError('llm', `stop_reason ${res.stop_reason}`);
      }
      return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    } catch (err) {
      if (err instanceof BackendUnavailableError) throw err;
      if (err instanceof Anthropic.RateLimitError)
        throw new BackendUnavailableError('llm', 'rate limited', { status: 429, retryable: true, cause: err });
      if (err instanceof Anthropic.APIError)
        throw new BackendUnavailableError('llm', `HTTP ${err.status ?? '?'}`, { status: err.status, cause: err });
      throw new BackendUnavailableError('llm', 'unreachable', { cause: err });
    }
  };
}
