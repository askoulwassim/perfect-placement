import { ops } from '@perfect-placement/engine';
import { type Args, parseArgs } from './args.js';
import * as doctorCmd from './commands/doctor.js';
import * as migrateCmd from './commands/migrate.js';
import { fresh, inbox, op, score, scout } from './commands/skills.js';
import { up } from './commands/up.js';
import { CliError, exitCodeOf, type Io, processIo, show } from './io.js';

export const COMMANDS = ['up', 'migrate', 'doctor', 'scout', 'score', 'fresh', 'inbox', 'op'] as const;

const USAGE = `pp <command> [--home <PP_HOME>] [--actor agent|human|schedule]

  up       [--port 4317] [--web <dir>]     local API (+ MCP, web)
  scout    --in <file|-> [--note <text>]   roles.add (dedupe into inbox)
  score    --in <file|->                   roles.score
  fresh    [--role <id>]...                roles.check_freshness
  inbox    --in <file|->                   inbox.ingest
  op       <name> [--input <json>|--in f]  any op
  doctor                                   system.doctor
  migrate  --from <v1 repo>                v1 import (lane A)`;

/** Lane A owns commands/migrate.ts and commands/doctor.ts; call their `run` once they export one. */
type LaneACommand = { run?: (argv: string[], io: Io) => Promise<number> | number };

export async function runCli(argv: readonly string[], io: Io = processIo): Promise<number> {
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

  if (cmd === 'migrate') {
    const m = migrateCmd as LaneACommand;
    if (typeof m.run === 'function') return m.run(argv.slice(1) as string[], io);
    io.err('pp migrate: not merged yet (lane A)');
    return 1;
  }
  const d = doctorCmd as LaneACommand;
  if (cmd === 'doctor' && typeof d.run === 'function') return d.run(argv.slice(1) as string[], io);

  const home = args.get('home') ?? ops.resolveHome(io.env);
  let engine: ReturnType<typeof ops.openEngine> | undefined;
  try {
    engine = ops.openEngine({ home, ...(io.services ? { services: io.services } : {}) });
    switch (cmd) {
      case 'doctor': {
        const o = await engine.runOp('system.doctor', {}, { actor: 'human', now: () => new Date() });
        show(io, o);
        return exitCodeOf(o);
      }
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
      case 'up': {
        const running = await up({
          engine,
          port: Number(args.get('port') ?? 4317),
          ...(args.get('web') ? { webDir: args.get('web') as string } : {}),
        });
        io.out(`pp up: ${running.url} (api /api/ops, mcp /mcp, home ${home})`);
        const opened = engine;
        engine = undefined; // keep the db open while serving
        await new Promise<void>((done) => {
          const stop = () =>
            void running.close().then(() => {
              opened.close();
              done();
            });
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
        });
        return 0;
      }
    }
    return 1;
  } catch (e) {
    io.err(`pp ${cmd}: ${(e as Error).message}`);
    return e instanceof CliError ? 2 : 1;
  } finally {
    engine?.close();
  }
}
