/*
 * `pp setup`: first run, safe to rerun. (a) vault, (b) Kev (optional), (c) MCP registration for the
 * agent clients found on this machine, each asked first, (d) next steps, then a summary of every
 * step (failures marked, with the fix) as the last lines; exit 1 when any step failed.
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
import { configuredModel, ensureUv, kevInstall, sysOf } from './kev.js';

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

/** One line of the end-of-setup summary. */
export interface SetupStep {
  step: string;
  result: 'ok' | 'skipped' | 'failed';
  detail: string;
  /** The exact command (or action) that fixes a failed step. */
  fix?: string;
}

const MARK: Record<SetupStep['result'], string> = { ok: 'ok  ', skipped: 'skip', failed: 'FAIL' };

/** The last lines of `pp setup`: every step, its result, and the fix for each failure. */
export function summaryLines(steps: SetupStep[]): string[] {
  const failed = steps.filter((s) => s.result === 'failed').length;
  const width = Math.max(...steps.map((s) => s.step.length));
  const lines = ['', 'Setup summary:'];
  for (const s of steps) {
    lines.push(`  ${MARK[s.result]}  ${s.step.padEnd(width)}  ${s.detail}`);
    if (s.result === 'failed' && s.fix) lines.push(`  ${' '.repeat(4)}  ${' '.repeat(width)}  fix: ${s.fix}`);
  }
  lines.push(failed ? `setup: ${failed} step(s) failed (fixes above); rerun pp setup when done` : 'setup: all done');
  return lines;
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

  const steps: SetupStep[] = [];
  const finish = (): number => {
    for (const line of summaryLines(steps)) io.out(line);
    return steps.some((s) => s.result === 'failed') ? 1 : 0;
  };

  // (a) vault
  if (existsSync(db.dbPath(home))) {
    io.out(`vault: ${home} (kept)`);
    steps.push({ step: 'vault', result: 'ok', detail: `${home} (kept)` });
  } else if (init(home, io) === 0) steps.push({ step: 'vault', result: 'ok', detail: `${home} (created)` });
  else {
    steps.push({
      step: 'vault',
      result: 'failed',
      detail: `could not create ${home} (see above)`,
      fix: 'set PP_HOME to an empty dir outside any git repo, then pp setup',
    });
    return finish();
  }

  // (b) Kev
  steps.push(await setupKev(args, home, io, yes, model as KevModel | undefined));

  // (c) MCP
  if (args.has('no-mcp')) {
    io.out('mcp: skipped (--no-mcp)');
    steps.push({ step: 'mcp', result: 'skipped', detail: '--no-mcp' });
  } else {
    const found = detectClients(d);
    const spec = mcpSpec(home, d.nodePath, opts.mcpBin ?? ppMcpBin());
    if (!existsSync(spec.args[0] as string)) io.err(`mcp: warning: ${spec.args[0]} does not exist yet (run pnpm build)`);
    for (const client of only ?? CLIENT_IDS) {
      const label = CLIENT_LABEL[client];
      const step = `mcp ${label}`;
      if (!found[client]) {
        io.out(`mcp: ${label}: not found (skipped)`);
        steps.push({ step, result: 'skipped', detail: 'not found on this machine' });
        continue;
      }
      if (!(await confirm(io, yes, `Register pp with ${label}?`, true))) {
        io.out(`mcp: ${label}: skipped`);
        steps.push({ step, result: 'skipped', detail: 'declined' });
        continue;
      }
      const change = registerClient(client, spec, d);
      (change.status === 'failed' ? io.err : io.out)(describe(change));
      if (change.status === 'failed')
        steps.push({
          step,
          result: 'failed',
          detail: change.detail ?? 'failed',
          fix: `fix ${change.target}, then pp setup --mcp ${client}`,
        });
      else {
        io.out(`mcp: ${label}: ${restartHint(client, d.platform)}`);
        steps.push({
          step,
          result: 'ok',
          detail: change.status === 'unchanged' ? 'already registered' : `${change.status}; restart ${label}`,
        });
      }
    }
  }

  // (d) next steps, then the summary (always the last lines)
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
  return finish();
}

async function setupKev(args: Args, home: string, io: Io, yes: boolean, model: KevModel | undefined): Promise<SetupStep> {
  const step = 'kev';
  if (args.has('no-kev')) {
    io.out('kev: skipped (--no-kev)');
    return { step, result: 'skipped', detail: '--no-kev (add later: pp kev install)' };
  }
  if (kevInstalled(home)) {
    io.out(`kev: installed (model ${configuredModel(home)}); pp up starts it`);
    return { step, result: 'ok', detail: `installed (model ${configuredModel(home)})` };
  }
  const support = kevSupport(sysOf(io));
  if (!support.backend) {
    io.out(`kev: ${support.message}`);
    return { step, result: 'skipped', detail: 'not supported on this machine' };
  }
  if (!(args.has('kev') || (await confirm(io, yes, 'Install Kev, the optional local decision model (multi-GB download)?', false)))) {
    io.out('kev: skipped (pp works without it; pp kev install later)');
    return { step, result: 'skipped', detail: 'declined (add later: pp kev install)' };
  }
  const uv = await ensureUv(io, yes);
  if (!uv.ok) return { step, result: 'failed', detail: `not installed: ${uv.detail}`, ...(uv.fix ? { fix: uv.fix } : {}) };
  try {
    if ((await kevInstall(home, io, { yes: true, model })) !== 0 || !kevInstalled(home))
      return { step, result: 'failed', detail: 'not installed (see the kev: lines above)', fix: 'pp kev install' };
  } catch (e) {
    io.err(`kev: ${(e as Error).message}`);
    return { step, result: 'failed', detail: `not installed: ${(e as Error).message}`, fix: 'pp kev install' };
  }
  return { step, result: 'ok', detail: `installed (model ${configuredModel(home)}); the model downloads on first start` };
}
