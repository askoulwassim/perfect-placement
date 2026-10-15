import type { BrowserRunPolicy } from '../browser-policy.js';
import { codexBrowserEnvironment } from './browser-env.js';

/** Codex's browser adapter (#157). Only these tools are exposed to a headless PP run. Its prompt text: text.ts. */
export const CODEX_BROWSER_SERVER = 'pp_browser';
export const CODEX_BROWSER_READ_TOOLS = ['list_pages', 'new_page', 'close_page', 'navigate_page', 'take_snapshot'] as const;
export const CODEX_BROWSER_FILL_TOOLS = ['fill_form', 'upload_file'] as const;

/**
 * CLI overrides, scoped to the child run: the adapter gets the run's whole policy (#161), and Codex enables exactly
 * the policy's tools. Runner args can select a different browser connection.
 */
export function codexBrowserArgs(opts: {
  nodePath: string;
  adapterBin: string;
  runtimeDir: string;
  policy: BrowserRunPolicy;
  env: NodeJS.ProcessEnv;
}): string[] {
  const prefix = `mcp_servers.${CODEX_BROWSER_SERVER}`;
  const toml = (value: unknown) => JSON.stringify(value).replaceAll('\u007f', '\\u007f');
  return [
    `${prefix}.command=${toml(opts.nodePath)}`,
    `${prefix}.args=${toml([opts.adapterBin, '--runtime-dir', opts.runtimeDir, '--policy', JSON.stringify(opts.policy)])}`,
    // Codex clears unlisted MCP environment variables, including XDG cache/profile locations.
    ...Object.entries(codexBrowserEnvironment(opts.env)).map(([key, value]) => `${prefix}.env.${key}=${toml(value)}`),
    `${prefix}.enabled=true`,
    `${prefix}.enabled_tools=${JSON.stringify(opts.policy.tools)}`,
    `${prefix}.default_tools_approval_mode="approve"`,
    `${prefix}.startup_timeout_sec=60`,
  ].flatMap((setting) => ['-c', setting]);
}
