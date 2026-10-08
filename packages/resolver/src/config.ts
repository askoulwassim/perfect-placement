import type { PolicyConfig } from '@perfect-placement/contracts';
import { anthropicCall, createLlmBackend, type LlmCall } from './backends/llm.js';
import { createRuleBackend, type RuleSet } from './backends/rule.js';
import { createJevBackend, createKevBackend } from './backends/systemone.js';
import type { BackendMap } from './resolver.js';

/*
 * Build the backend map from `config.json` + environment.
 * - Jev is registered only when its key env var (default JEV_API_KEY) is set.
 * - Kev is always registered (local base URL); KEV_API_KEY is sent as a bearer token when set.
 * - The LLM is registered when ANTHROPIC_API_KEY is set (or an `llmCall` is injected).
 */
export function backendsFromConfig(
  config: PolicyConfig,
  opts: { env?: Record<string, string | undefined>; fetch?: typeof fetch; llmCall?: LlmCall; rules?: RuleSet; now?: () => Date } = {},
): BackendMap {
  const env = opts.env ?? process.env;
  const map: BackendMap = {
    rule: createRuleBackend({ ...(opts.rules ? { rules: opts.rules } : {}), ...(opts.now ? { now: opts.now } : {}) }),
  };
  const jevKey = env[config.backends.jev.keyEnv];
  const f = opts.fetch ? { fetch: opts.fetch } : {};
  if (jevKey) map.jev = createJevBackend({ baseUrl: config.backends.jev.baseUrl, apiKey: jevKey, ...f });
  const kevKey = env.KEV_API_KEY;
  map.kev = createKevBackend({ baseUrl: config.backends.kev.baseUrl, ...(kevKey ? { apiKey: kevKey } : {}), ...f });
  const llmKey = env.ANTHROPIC_API_KEY;
  if (opts.llmCall) map.llm = createLlmBackend({ call: opts.llmCall });
  else if (llmKey) {
    const model = config.backends.llm.model;
    map.llm = createLlmBackend({ call: anthropicCall({ apiKey: llmKey, ...(model ? { model } : {}) }) });
  }
  return map;
}
