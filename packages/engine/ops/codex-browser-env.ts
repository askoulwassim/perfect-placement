/** Location settings needed on both sides of Codex's filtered MCP environment. Never inherit secrets. */
export function codexBrowserEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const key of [
    'HOME', // User cache and Chrome profile fallback.
    'XDG_CACHE_HOME', // The optional installed browser runtime.
    'XDG_CONFIG_HOME', // Chrome's user configuration.
    'CHROME_CONFIG_HOME', // Chrome's Linux profile override, ahead of XDG_CONFIG_HOME.
    'TMPDIR',
    'TMP',
    'TEMP', // Browser temporary files on macOS, Linux and Windows.
    'LOCALAPPDATA',
    'APPDATA', // Windows Chrome profile/cache locations.
  ]) {
    if (env[key]) selected[key] = env[key];
  }
  return selected;
}
