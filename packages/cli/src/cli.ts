import { existsSync } from 'node:fs';
import { db, ops } from '@perfect-placement/engine';
import { openFixtureDemo, type ToolNameStyle } from '@perfect-placement/mcp';
import { type Args, parseArgs } from './args.js';
import { renderDoctor } from './commands/doctor.js';
import { init } from './commands/init.js';
import { kevCommand, kevForUp, sysOf } from './commands/kev.js';
import { runCommand, schedulesCommand, servicesWithJobs } from './commands/schedules.js';
import { setupCommand } from './commands/setup.js';
import { fresh, inbox, op, score, scout } from './commands/skills.js';
import { uninstallCommand } from './commands/uninstall.js';
import { checkKev, DEFAULT_PORT, type Running, up } from './commands/up.js';
import { CliError, type Io, processIo } from './io.js';
import { nodePathChecks } from './system/clients.js';
import { codexBrowserDoctor } from './system/codex-browser.js';
import { kevInstalled } from './system/kev.js';
import { scheduleJobsCheck } from './system/schedules.js';

export const COMMANDS = [
  'setup',
  'up',
  'init',
  'kev',
  'doctor',
  'scout',
  'score',
  'fresh',
  'inbox',
  'drain',
  'run',
  'schedules',
  'op',
  'uninstall',
] as const;

const USAGE = `pp <command> [--home <PP_HOME>] [--actor agent|human|schedule]

  setup    [--runner claude|codex|cursor-agent] [--yes] [--no-kev|--kev] [--model m] [--no-mcp|--mcp claude-code,codex,cursor,claude-desktop] [--no-schedules]
                                           vault, optional Kev, MCP; browser runtime only for Codex (safe to rerun)
  up       [--port ${DEFAULT_PORT}] [--web <dir>] [--fixtures] [--no-kev] [--kev] [--no-catch-up]
                                           API /api/ops, MCP /mcp, web / on 127.0.0.1; starts Kev if installed;
                                           queues schedules missed since their last run
  init                                     create an empty vault with the default config
  kev      install [--model m] [--yes] | start [--model m] [--wait] | stop | status
  scout    --in <file|-> [--note <text>]   roles.add (dedupe into inbox)
  score    --in <file|->                   roles.score
  fresh    [--role <id>]...                roles.check_freshness
  inbox    --in <file|->                   inbox.ingest
  drain                                    launch queued skill runs (up to runs.max_concurrent), once
  run      <skill> [--schedule] [--role <id>] [--no-wait]
                                           queue a skill run, drain until it and what it triggers finish
                                           (--schedule: actor schedule; what the OS jobs run)
  schedules install|remove|status [--json] OS jobs for config.schedules (launchd, systemd user timers)
  op       <name> [<json>|--input <json>|--in f]  any op
  doctor   [--json]                        system.doctor
  uninstall [--purge [--no-backup] [--force]] [--yes] [--dry-run] [--bin-dir <dir>]
                                           undo setup: stop pp's Kev, schedule jobs, the pp MCP entry in each agent
                                           (backup first), the pp / pp-mcp launchers; keeps the vault unless --purge
                                           (vault after a tar.gz backup, Kev's model files); plan first, asks`;

/** Resolves when SIGINT / SIGTERM arrives (overridable in tests). */
export type WaitForStop = () => Promise<void>;
const waitForSignal: WaitForStop = () =>
  new Promise((done) => {
    process.once('SIGINT', () => done());
    process.once('SIGTERM', () => done());
  });

export async function runCli(argv: readonly string[], io: Io = processIo, waitForStop: WaitForStop = waitForSignal): Promise<number> {
  const args: Args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || args.has('help')) {
    io.out(USAGE);
    return 0;
  }
  if (!(COMMANDS as readonly string[]).includes(cmd)) {
    io.err(`pp: unknown command "${cmd}"\n\n${USAGE}`);
    return 1;
  }
  const home = db.resolvePpHome(args.get('home'), io.env);
  const services = io.services ? { services: io.services } : {};

  try {
    switch (cmd) {
      case 'init':
        return init(home, io);
      case 'setup':
        return await setupCommand(args, home, io);
      case 'kev':
        return await kevCommand(args, home, io);
      case 'uninstall':
        return await uninstallCommand(args, home, io);
      case 'schedules':
        return await schedulesCommand(args, home, io);
      case 'doctor': {
        if (!existsSync(db.dbPath(home))) {
          io.err(`pp doctor: no vault at ${home} (run pp init)`);
          return 1;
        }
        const engine = ops.openEngine({ home, ...services });
        try {
          const o = await engine.runOp('system.doctor', {}, { actor: 'human', now: () => new Date() });
          if (o.status !== 'ok') throw new Error(o.status === 'error' ? o.message : 'requires a human');
          const res = o.output as db.DoctorResult;
          // Machine checks (#33): node paths in the runner and agent MCP configs survive a brew upgrade.
          // #29: the OS schedule jobs match config.schedules.
          const checks = [
            ...res.checks,
            ...nodePathChecks(home, sysOf(io)),
            scheduleJobsCheck(home, ops.readConfig(home).schedules, sysOf(io)),
            codexBrowserDoctor(ops.readConfig(home).runner.command, sysOf(io)),
          ];
          return renderDoctor({ ...res, checks, ok: checks.every((c) => c.ok) }, home, io, args.has('json'));
        } finally {
          engine.close();
        }
      }
      case 'up':
        return await upCommand(args, home, io, waitForStop);
    }
    // `pp op config.update` keeps the OS schedule jobs in line too (#29).
    const engine = ops.openEngine({ home, services: servicesWithJobs(io, home) });
    try {
      switch (cmd) {
        case 'scout':
          return await scout(engine, args, io);
        case 'score':
          return await score(engine, args, io);
        case 'fresh':
          return await fresh(engine, args, io);
        case 'inbox':
          return await inbox(engine, args, io);
        case 'drain':
          return await drain(engine, io);
        case 'run':
          return await runCommand(engine, args, io, (e) => drainQueue(e, io));
        case 'op':
          return await op(engine, args, io);
      }
      return 1;
    } finally {
      engine.close();
    }
  } catch (e) {
    io.err(`pp ${cmd}: ${(e as Error).message}`);
    return e instanceof CliError ? 2 : 1;
  }
}

/** Stale-run sweep + queue dispatch interval in `pp up`. */
const SWEEP_MS = 30_000;

/**
 * The run queue, once (#30): finish runs whose runner is gone (they hold a slot), then launch queued
 * runs that fit. `pp up` does this on start and every SWEEP_MS; `pp drain` does it once (schedules,
 * headless use). Runs started or finished anywhere also dispatch on their own.
 */
async function drainQueue(
  engine: ops.Engine,
  io: Io,
): Promise<{ interrupted: string[]; stalled: string[]; launched: string[]; queued: number }> {
  const interrupted = await ops
    .interruptStaleRuns(engine.runOp, io.runnerAlive ? { isAlive: (r) => (io.runnerAlive as (id: string) => boolean)(r.id) } : {})
    .catch(() => [] as string[]);
  // #121: a scheduled run past its skill's cap is killed and finished `stalled` (then retried with backoff).
  const stalled = await ops
    .capStalledRuns(engine.runOp, io.killRunner ? { kill: (r) => (io.killRunner as (id: string) => void)(r.id) } : {})
    .catch(() => [] as string[]);
  const o = await engine.runOp('runs.dispatch', {}, { actor: 'schedule', now: () => new Date() });
  const out = o.status === 'ok' ? (o.output as { launched: string[]; queued: number }) : { launched: [], queued: 0 };
  return { interrupted, stalled, launched: out.launched, queued: out.queued };
}

async function drain(engine: ops.Engine, io: Io): Promise<number> {
  const r = await drainQueue(engine, io);
  if (r.interrupted.length)
    io.out(`pp drain: ${r.interrupted.length} interrupted run${r.interrupted.length === 1 ? '' : 's'} marked error`);
  if (r.stalled.length) io.out(`pp drain: ${r.stalled.length} stalled run${r.stalled.length === 1 ? '' : 's'} stopped`);
  io.out(`pp drain: ${r.launched.length} launched${r.launched.length ? ` (${r.launched.join(', ')})` : ''}, ${r.queued} queued`);
  return 0;
}

async function upCommand(args: Args, home: string, io: Io, waitForStop: WaitForStop): Promise<number> {
  const port = Number(args.get('port') ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CliError(`--port must be 0 to 65535, got ${args.get('port')}`);
  const toolNames = args.get('tool-names') as ToolNameStyle | undefined;
  if (toolNames && toolNames !== 'dotted' && toolNames !== 'underscore') throw new CliError('--tool-names must be dotted or underscore');

  let engine: ops.Engine;
  let closeEngine: () => void;
  if (args.has('fixtures')) {
    const demo = await openFixtureDemo(io.services ? { services: io.services } : {});
    engine = demo.engine;
    closeEngine = demo.close;
    io.out(`pp up: fixtures demo (synthetic data, offline) at ${demo.home}`);
  } else {
    const opened = ops.openEngine({ home, services: servicesWithJobs(io, home) });
    engine = opened;
    closeEngine = () => opened.close();
  }

  // Runs a previous pp up left open (their runner is gone) end as error "interrupted"; then keep sweeping
  // for detached runners that die without runs.finish while nothing is watching them. Each sweep also
  // dispatches the run queue (#30): runs queued while nothing was running launch here.
  const sweep = async () => {
    const r = await drainQueue(engine, io);
    const ids = r.interrupted;
    if (ids.length) io.out(`pp up: ${ids.length} interrupted run${ids.length === 1 ? '' : 's'} marked error (${ids.join(', ')})`);
    if (r.stalled.length)
      io.out(`pp up: ${r.stalled.length} stalled run${r.stalled.length === 1 ? '' : 's'} stopped (${r.stalled.join(', ')})`);
    if (r.launched.length) io.out(`pp up: launched ${r.launched.length} queued run${r.launched.length === 1 ? '' : 's'}`);
  };
  // #29 fallback for the OS jobs: a schedule that fired since its last run started (machine off,
  // no job) is queued once now. Never for the fixtures demo.
  if (!args.has('fixtures') && !args.has('no-catch-up')) {
    const caught = await ops.catchUpSchedules(engine.db, engine.runOp, ops.readConfig(engine.home), () => new Date()).catch(() => []);
    if (caught.length) io.out(`pp up: caught up ${caught.map((c) => `${c.key} (${c.run_id})`).join(', ')}`);
  }
  await sweep();
  const sweeper = setInterval(() => void sweep(), SWEEP_MS);
  sweeper.unref();

  let running: Running;
  // Kev on demand: only for a real vault, only if installed and not already answering; stopped on exit only if started here.
  const stopKev = args.has('fixtures') || args.has('no-kev') ? null : await kevForUp(engine.home, io);
  try {
    // A fixtures demo runs on a temp vault that never holds Kev (the real one may): report reachability only.
    if (args.has('kev')) io.out((await checkKev(engine, { installed: args.has('fixtures') ? true : kevInstalled(engine.home) })).line);
    running = await up({
      engine,
      port,
      ...(args.has('web') ? { webDir: args.get('web') === 'none' ? null : (args.get('web') as string) } : {}),
      ...(toolNames ? { toolNames } : {}),
    });
  } catch (e) {
    clearInterval(sweeper);
    closeEngine();
    stopKev?.();
    throw e;
  }
  io.out(`pp up: ${running.url} (api ${running.url}/api/ops, mcp ${running.url}/mcp, home ${engine.home})`);
  await waitForStop();
  clearInterval(sweeper);
  await running.close();
  closeEngine();
  stopKev?.();
  io.out('pp up: stopped');
  return 0;
}
