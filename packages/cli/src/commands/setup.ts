/*
 * `pp setup`: first run, safe to rerun. (a) vault, (b) Kev (optional), (c) MCP registration for the
 * agent clients found on this machine, each asked first, (d) next steps.
 *   --yes            accept every step (Kev only where supported)
 *   --no-kev / --kev skip / install Kev without asking;  --model kev-0.8b|kev-4b|...
 *   --no-mcp         skip MCP;  --mcp claude-code,codex,cursor,claude-desktop  limit to these clients
 */
import { existsSync } from 'node:fs';
import { db } from '@perfect-placement/engine';
import type { Args } from '../args.js';
import { CliError, confirm, type Io } from '../io.js';
import {
  CLIENT_IDS,
  CLIENT_LABEL,
  type ClientChange,
  type ClientId,
  detectClients,
  mcpSpec,
  ppMcpBin,
  registerClient,
} from '../system/clients.js';
import { isKevModel, KEV_MODELS, type KevModel, kevInstalled, kevSupport } from '../system/kev.js';
import { init } from './init.js';
import { configuredModel, kevInstall, sysOf } from './kev.js';

export interface SetupOptions {
  /** Override the pp-mcp bin path (tests). */
  mcpBin?: string;
}

function describe(c: ClientChange): string {
  const label = CLIENT_LABEL[c.client];
  if (c.status === 'unchanged') return `mcp: ${label}: already registered (${c.target})`;
  if (c.status === 'failed') return `mcp: ${label}: not changed: ${c.detail ?? 'failed'} (${c.target})`;
  return `mcp: ${label}: ${c.status} server "pp" -> ${c.target}${c.backup ? ` (backup ${c.backup})` : ''}`;
}

/**
 * What to do after registering (or finding pp already registered): the client reads its MCP config
 * only at launch. Claude Desktop lists local servers under Settings > Developer (not Connectors).
 */
export function restartHint(client: ClientId, platform: NodeJS.Platform = process.platform): string {
  const label = CLIENT_LABEL[client];
  if (client === 'claude-desktop')
    return platform === 'darwin'
      ? 'Quit Claude Desktop (Cmd+Q) and reopen it; pp appears under Settings > Developer'
      : 'Quit Claude Desktop fully and reopen it; pp appears under Settings > Developer';
  return `restart ${label}; then ask it to call the pp tools`;
}

export async function setupCommand(args: Args, home: string, io: Io, opts: SetupOptions = {}): Promise<number> {
  const yes = args.has('yes');
  const d = sysOf(io);
  const model = args.get('model');
  if (model !== undefined && !isKevModel(model)) throw new CliError(`--model must be one of ${Object.keys(KEV_MODELS).join(', ')}`);
  let only: ClientId[] | null = null;
  if (args.has('mcp')) {
    only = (args.get('mcp') as string).split(',').map((s) => s.trim()) as ClientId[];
    const bad = only.filter((c) => !(CLIENT_IDS as readonly string[]).includes(c));
    if (bad.length) throw new CliError(`--mcp takes ${CLIENT_IDS.join(',')}; unknown: ${bad.join(', ')}`);
  }

  // (a) vault
  if (existsSync(db.dbPath(home))) io.out(`vault: ${home} (kept)`);
  else {
    const code = init(home, io);
    if (code !== 0) return code;
  }

  // (b) Kev
  let failed = false;
  if (args.has('no-kev')) io.out('kev: skipped (--no-kev)');
  else if (kevInstalled(home)) io.out(`kev: installed (model ${configuredModel(home)}); pp up starts it`);
  else {
    const support = kevSupport(d);
    if (!support.backend) io.out(`kev: ${support.message}`);
    else if (args.has('kev') || (await confirm(io, yes, 'Install Kev, the optional local decision model (multi-GB download)?', false))) {
      if ((await kevInstall(home, io, { yes: true, model: model as KevModel | undefined })) !== 0) failed = true;
    } else io.out('kev: skipped (pp works without it; pp kev install later)');
  }

  // (c) MCP
  if (args.has('no-mcp')) io.out('mcp: skipped (--no-mcp)');
  else {
    const found = detectClients(d);
    const spec = mcpSpec(home, d.nodePath, opts.mcpBin ?? ppMcpBin());
    if (!existsSync(spec.args[0] as string)) io.err(`mcp: warning: ${spec.args[0]} does not exist yet (run pnpm build)`);
    for (const client of only ?? CLIENT_IDS) {
      const label = CLIENT_LABEL[client];
      if (!found[client]) {
        io.out(`mcp: ${label}: not found (skipped)`);
        continue;
      }
      if (!(await confirm(io, yes, `Register pp with ${label}?`, true))) {
        io.out(`mcp: ${label}: skipped`);
        continue;
      }
      const change = registerClient(client, spec, d);
      if (change.status === 'failed') failed = true;
      (change.status === 'failed' ? io.err : io.out)(describe(change));
      if (change.status !== 'failed') io.out(`mcp: ${label}: ${restartHint(client, d.platform)}`);
    }
  }

  // (d) next steps
  io.out(
    [
      '',
      'Next:',
      '  pp up                     open http://127.0.0.1:5177 (Ctrl-C to stop; data stays in the vault)',
      `  your data                 ${home} (pp.db + markdown; survives restarts)`,
      '  in your agent             restart it, then ask it to call the pp tools (roles_list, pipeline_summary)',
      '  pp setup                  rerun any time to reconnect an agent or add Kev',
      '  pp doctor                 integrity checks',
    ].join('\n'),
  );
  return failed ? 1 : 0;
}
