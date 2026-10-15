/** Location settings needed on both sides of a runner's filtered MCP environment (Codex clears the rest). Never inherit secrets. */
export function browserEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const key of [
    'HOME', // User cache and Chrome profile fallback.
    'XDG_CACHE_HOME', // The optional installed browser runtime.
    'XDG_CONFIG_HOME', // Chrome's user configuration.
    'CHROME_CONFIG_HOME', // Chrome's Linux profile override, ahead of XDG_CONFIG_HOME.
    // Not TMPDIR/TMP/TEMP: they vary by shell (agent sandboxes set their own), and a schedule job would
    // keep one for its whole run. The adapter attaches to a running Chrome and keeps snapshots inline.
    'LOCALAPPDATA',
    'APPDATA', // Windows Chrome profile/cache locations.
  ]) {
    if (env[key]) selected[key] = env[key];
  }
  return selected;
}
