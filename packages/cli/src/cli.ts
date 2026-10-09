import { existsSync } from 'node:fs';
import { db, ops } from '@perfect-placement/engine';
import { openFixtureDemo, type ToolNameStyle } from '@perfect-placement/mcp';
import { type Args, parseArgs } from './args.js';
import { renderDoctor } from './commands/doctor.js';
import { init } from './commands/init.js';
import { kevCommand, kevForUp, sysOf } from './commands/kev.js';
import { setupCommand } from './commands/setup.js';
import { fresh, inbox, op, score, scout } from './commands/skills.js';
import { checkKev, DEFAULT_PORT, type Running, up } from './commands/up.js';
import { CliError, type Io, processIo } from './io.js';
import { nodePathChecks } from './system/clients.js';
import { kevInstalled } from './system/kev.js';

export const COMMANDS = ['setup', 'up', 'init', 'kev', 'doctor', 'scout', 'score', 'fresh', 'inbox', 'op'] as const;

const USAGE = `pp <command> [--home <PP_HOME>] [--actor agent|human|schedule]

  setup    [--yes] [--no-kev|--kev] [--model m] [--no-mcp|--mcp claude-code,codex,cursor,claude-desktop]
                                           first run: vault, optional Kev, MCP for your agents (safe to rerun)
  up       [--port ${DEFAULT_PORT}] [--web <dir>] [--fixtures] [--no-kev] [--kev]
                                           API /api/ops, MCP /mcp, web / on 127.0.0.1; starts Kev if installed
  init                                     create an empty vault with the default config
  kev      install [--model m] [--yes] | start [--model m] [--wait] | stop | status
  scout    --in <file|-> [--note <text>]   roles.add (dedupe into inbox)
  score    --in <file|->                   roles.score
  fresh    [--role <id>]...                roles.check_freshness
  inbox    --in <file|->                   inbox.ingest
  op       <name> [<json>|--input <json>|--in f]  any op
  doctor   [--json]                        system.doctor`;

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
          const checks = [...res.checks, ...nodePathChecks(home, sysOf(io))];
          return renderDoctor({ ...res, checks, ok: checks.every((c) => c.ok) }, home, io, args.has('json'));
        } finally {
          engine.close();
        }
      }
      case 'up':
        return await upCommand(args, home, io, waitForStop);
    }
    const engine = ops.openEngine({ home, ...services });
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
    const opened = ops.openEngine({ home, ...(io.services ? { services: io.services } : {}) });
    engine = opened;
    closeEngine = () => opened.close();
  }

  let running: Running;
  // Kev on demand: only for a real vault, only if installed and not already answering; stopped on exit only if started here.
  const stopKev = args.has('fixtures') || args.has('no-kev') ? null : await kevForUp(engine.home, io);
  try {
    if (args.has('kev')) io.out((await checkKev(engine, args.has('fixtures') ? {} : { installed: kevInstalled(engine.home) })).line);
    running = await up({
      engine,
      port,
      ...(args.has('web') ? { webDir: args.get('web') === 'none' ? null : (args.get('web') as string) } : {}),
      ...(toolNames ? { toolNames } : {}),
    });
  } catch (e) {
    closeEngine();
    stopKev?.();
    throw e;
  }
  io.out(`pp up: ${running.url} (api ${running.url}/api/ops, mcp ${running.url}/mcp, home ${engine.home})`);
  await waitForStop();
  await running.close();
  closeEngine();
  stopKev?.();
  io.out('pp up: stopped');
  return 0;
}
