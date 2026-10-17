import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AskSpec, RunnerSpec } from '../types.js';
import { CODEX_GMAIL, GmailSetupRequired, requireCodexGmailIsolation } from './gmail.js';

/** Child-only controls. Managed requirements still apply; HOME and CODEX_HOME are never replaced. */
export const CODEX_ISOLATION_SETTINGS = [
  'features.apps=false',
  'features.plugins=false',
  'features.remote_plugin=false',
  'features.hooks=false',
  'features.shell_tool=false',
  'features.unified_exec=false',
  'features.js_repl=false',
  'features.apply_patch_freeform=false',
  'features.browser_use=false',
  'features.browser_use_external=false',
  'features.browser_use_full_cdp_access=false',
  'features.computer_use=false',
  'features.in_app_browser=false',
  'features.in_app_local_automation=false',
  'features.skill_mcp_dependency_install=false',
  'features.skill_search=false',
  'agents.enabled=false',
  'approval_policy="never"',
  'sandbox_mode="read-only"',
] as const;

export const codexIsolationArgs = (): string[] => [
  '--ignore-user-config',
  '--ignore-rules',
  '--ephemeral',
  ...CODEX_ISOLATION_SETTINGS.flatMap((v) => ['-c', v]),
];

/** Reject profiles, alternate endpoints, feature toggles and arbitrary CLI/config overrides. */
export function codexSafeArgs(args: readonly string[]): string[] {
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!value || value.startsWith('-')) throw new GmailSetupRequired('unsupported runner.args');
    if (key === '-m' || key === '--model') continue;
    if (
      (key === '-c' || key === '--config') &&
      (/^(model_reasoning_effort|model_verbosity|service_tier)="[a-z0-9_-]+"$/.test(value) ||
        /^mcp_servers\.pp\.(?:tools\.[a-z_]+\.)?(?:default_tools_approval_mode|approval_mode)="prompt"$/.test(value))
    )
      continue;
    throw new GmailSetupRequired('unsupported runner.args; profiles and tool/config overrides cannot preserve isolation');
  }
  return [...args];
}

/** Read configuration without starting a thread, model, MCP connection, or agent. Never log its contents. */
export async function readCodexConfig(cwd: string, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const version = spawnSync('codex', ['--version'], { cwd, env, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
  if (version.status !== 0 || version.stdout.trim() !== `codex-cli ${CODEX_GMAIL.codexVersion}`)
    throw new GmailSetupRequired(`unverified Codex runtime; checked version is ${CODEX_GMAIL.codexVersion}`);
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server', ...CODEX_ISOLATION_SETTINGS.flatMap((v) => ['-c', v])], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let settled = false;
    const finish = (config?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      // This metadata-only process has no agent to finish. app-server can ignore SIGTERM with an open RPC stream.
      child.kill('SIGKILL');
      if (config) resolve(config);
      else reject(new GmailSetupRequired('cannot inspect inherited Codex configuration'));
    };
    const timer = setTimeout(() => finish(), 15_000);
    child.once('error', () => finish());
    child.once('exit', () => finish());
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try {
        const message = JSON.parse(line);
        if (message.id === 1 && message.result) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'config/read', params: { cwd } })}\n`);
        } else if (message.id === 2) {
          const config = message.result?.config;
          finish(config && typeof config === 'object' && !Array.isArray(config) ? config : undefined);
        } else if (message.error) finish();
      } catch {
        finish();
      }
    });
    child.stdin.on('error', () => finish());
    child.stdin.write(
      `${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'pp-isolation', version: '1' } } })}\n`,
    );
  });
}

/**
 * A fresh cwd excludes project config. exec ignores user config and profiles; system config and managed
 * requirements remain. Disable every inherited MCP server explicitly, then restore only PP's own definitions.
 * Apps/plugins are globally off, including deferred discovery. No Gmail route is supported in this process.
 */
export function isolatedCodexArgs(spec: RunnerSpec | AskSpec, config: Record<string, unknown>): string[] {
  requireCodexGmailIsolation(spec.codexIsolation?.gmailTools ?? []);
  const servers = config.mcp_servers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new GmailSetupRequired('invalid MCP configuration');
  const allowed = spec.codexIsolation?.servers ?? [];
  if (!allowed.every((s) => s === 'pp' || s === 'pp_browser')) throw new GmailSetupRequired('unexpected MCP provider');
  const disabled = Object.entries(servers).map(([name, value]) => {
    const http = value && typeof value === 'object' && 'url' in value;
    // A disabled entry still needs a valid transport after exec ignores the user layer.
    const transport = http ? 'url="http://127.0.0.1:1/disabled"' : 'command="pp-disabled-provider"';
    return `${JSON.stringify(name)}={enabled=false,${transport}}`;
  });
  // The table form handles dots, quotes and aliases in inherited names. Empty tables would merge and retain overrides.
  return [
    spec.args[0] as string,
    '-c',
    `mcp_servers={${disabled.join(',')}}`,
    ...spec.args.slice(1, -1),
    ...allowed.flatMap((server) => ['-c', `mcp_servers.${server}.enabled=true`]),
    ...codexIsolationArgs(),
    spec.args.at(-1) as string,
  ];
}

export async function prepareCodex(spec: RunnerSpec | AskSpec, cwd: string): Promise<void> {
  if (spec.command !== 'codex') return;
  requireCodexGmailIsolation(spec.codexIsolation?.gmailTools ?? []);
  if (!spec.codexIsolation || spec.cwd !== null) throw new GmailSetupRequired('missing isolated launch context');
  // Bound project discovery even when TMPDIR itself sits below a repository/configuration.
  // Codex uses Git repository validation: an empty .git directory does not bound discovery.
  mkdirSync(join(cwd, '.git', 'objects'), { recursive: true });
  mkdirSync(join(cwd, '.git', 'refs'));
  writeFileSync(join(cwd, '.git', 'HEAD'), 'ref: refs/heads/pp-isolated\n');
  const config = await readCodexConfig(cwd, { ...process.env, ...spec.env });
  spec.args = isolatedCodexArgs(spec, config);
}
