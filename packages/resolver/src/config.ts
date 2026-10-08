import type { PolicyConfig } from '@perfect-placement/contracts';
import { type AgentAnswers, createAgentBackend } from './backends/agent.js';
import { anthropicCall, createLlmBackend, type LlmCall } from './backends/llm.js';
import { createRuleBackend, type RuleSet } from './backends/rule.js';
import { createJevBackend, createKevBackend } from './backends/systemone.js';
import type { BackendMap } from './resolver.js';

/*
 * Build the backend map from `config.json` + environment (wave1-decisions #7, #9).
 * - rule: always.
 * - kev: always (local base URL); KEV_API_KEY is sent as a bearer token when set.
 * - agent: only when an agent session is attached to the op call (`agent` option). Never calls an API.
 * - jev: only when `backends.jev.enabled` AND its key env var (default JEV_API_KEY) is set.
 * - llm (Anthropic API): only when `backends.llm.enabled` AND ANTHROPIC_API_KEY is set (or an `llmCall`
 *   is injected for tests). Off by default: all LLM work runs in the agent session.
 */
export function backendsFromConfig(
  config: PolicyConfig,
  opts: {
    env?: Record<string, string | undefined>;
    fetch?: typeof fetch;
    llmCall?: LlmCall;
    rules?: RuleSet;
    now?: () => Date;
    /** The calling agent session's supplied answers; omit when no agent is attached. */
    agent?: AgentAnswers;
  } = {},
): BackendMap {
  const env = opts.env ?? process.env;
  const map: BackendMap = {
    rule: createRuleBackend({ ...(opts.rules ? { rules: opts.rules } : {}), ...(opts.now ? { now: opts.now } : {}) }),
  };
  const f = opts.fetch ? { fetch: opts.fetch } : {};
  const jevKey = env[config.backends.jev.keyEnv];
  if (config.backends.jev.enabled && jevKey) map.jev = createJevBackend({ baseUrl: config.backends.jev.baseUrl, apiKey: jevKey, ...f });
  const kevKey = env.KEV_API_KEY;
  map.kev = createKevBackend({ baseUrl: config.backends.kev.baseUrl, ...(kevKey ? { apiKey: kevKey } : {}), ...f });
  if (opts.agent) map.agent = createAgentBackend(opts.agent);
  if (config.backends.llm?.enabled) {
    const llmKey = env.ANTHROPIC_API_KEY;
    if (opts.llmCall) map.llm = createLlmBackend({ call: opts.llmCall });
    else if (llmKey) {
      const model = config.backends.llm.model;
      map.llm = createLlmBackend({ call: anthropicCall({ apiKey: llmKey, ...(model ? { model } : {}) }) });
    }
  }
  return map;
}
