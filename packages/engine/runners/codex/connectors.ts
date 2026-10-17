import { browserEnvironment } from '../browser/env.js';
import { BROWSER_SERVER, type BrowserRunPolicy } from '../browser/policy.js';

/**
 * CLI overrides, scoped to the child run: the adapter gets the run's whole policy (#161), and Codex enables exactly
 * the policy's tools. Browser connection settings come from PP's browser environment, not arbitrary runner args.
 */
export function codexBrowserArgs(opts: {
  nodePath: string;
  adapterBin: string;
  runtimeDir: string;
  policy: BrowserRunPolicy;
  env: NodeJS.ProcessEnv;
}): string[] {
  const prefix = `mcp_servers.${BROWSER_SERVER}`;
  const toml = (value: unknown) => JSON.stringify(value).replaceAll('\u007f', '\\u007f');
  return [
    `${prefix}.command=${toml(opts.nodePath)}`,
    `${prefix}.args=${toml([opts.adapterBin, '--runtime-dir', opts.runtimeDir, '--policy', JSON.stringify(opts.policy)])}`,
    // Codex clears unlisted MCP environment variables, including XDG cache/profile locations.
    ...Object.entries(browserEnvironment(opts.env)).map(([key, value]) => `${prefix}.env.${key}=${toml(value)}`),
    `${prefix}.enabled=true`,
    `${prefix}.enabled_tools=${JSON.stringify(opts.policy.tools)}`,
    `${prefix}.default_tools_approval_mode="approve"`,
    `${prefix}.startup_timeout_sec=60`,
  ].flatMap((setting) => ['-c', setting]);
}
