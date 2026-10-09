import { ASK_THREAD_MAX_TURNS, type AskChatEvent } from '@perfect-placement/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claudeLoggedOutTranscript,
  claudeScoreTranscript,
  codexTranscript,
  ctxAt,
  cursorTranscript,
  type FixtureEngine,
  fakeAskLauncher,
  okOut,
  openFixtureEngine,
} from '../testing/index.js';
import {
  type AskDeps,
  AskThreads,
  askAgentPrompt,
  buildAskSpec,
  classifyAskFailure,
  dbAskThreadStore,
  findRun,
  opOfTool,
  replayPrompt,
  runAsk,
} from './ask.js';

const mcp = { command: '/usr/bin/node', args: ['/repo/packages/mcp/dist/bin.js'], env: { PP_HOME: '/tmp/pp-home' } };

async function collect(it: AsyncIterable<AskChatEvent>): Promise<AskChatEvent[]> {
  const out: AskChatEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const deps = (launcher: AskDeps['launcher'], runner: AskDeps['runner'] = { command: 'claude' }, threads = new AskThreads()): AskDeps => ({
  home: '/tmp/pp-home',
  runner,
  mcp,
  launcher,
  threads,
});

describe('buildAskSpec', () => {
  it('claude: stream-json, pp + web tools only, no shell, PP_ASK on the MCP server, resume when a session exists', () => {
    const spec = buildAskSpec({ runner: { command: 'claude' }, message: 'hi', home: '/h', mcp, sessionId: 'sess-1' });
    const a = spec.args;
    const val = (f: string) => a[a.indexOf(f) + 1];
    expect(a.slice(0, 2)).toEqual(['-p', 'hi']);
    expect(val('--output-format')).toBe('stream-json');
    expect(a).toContain('--verbose');
    expect(a).toContain('--include-partial-messages');
    expect(a).toContain('--strict-mcp-config');
    expect(val('--tools')).toBe('WebSearch,WebFetch');
    expect(val('--allowedTools')).toBe('mcp__pp,WebSearch,WebFetch');
    expect(val('--permission-mode')).toBe('dontAsk');
    expect(val('--resume')).toBe('sess-1');
    expect(val('--append-system-prompt')).toContain('Perfect Placement assistant');
    expect(JSON.parse(val('--mcp-config') as string).mcpServers.pp.env).toEqual({ PP_HOME: '/tmp/pp-home', PP_ASK: '1' });
    expect(spec.cwd).toBe('/h');
    expect(buildAskSpec({ runner: { command: 'claude' }, message: 'hi', home: '/h', mcp }).args).not.toContain('--resume');
  });

  it('codex and cursor replay the transcript; codex is read-only, cursor denies shell and writes', () => {
    const turns = [{ user: 'first question', reply: 'first answer' }];
    const codex = buildAskSpec({ runner: { command: 'codex' }, message: 'next', home: '/h', mcp, turns });
    expect(codex.args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(codex.args).toContain('sandbox_mode="read-only"');
    expect(codex.args).toContain('mcp_servers.pp.env.PP_ASK="1"');
    const prompt = codex.args.at(-1) as string;
    expect(prompt).toContain('User: first question');
    expect(prompt.endsWith('next')).toBe(true);
    const cursor = buildAskSpec({ runner: { command: 'cursor-agent' }, message: 'next', home: '/h', mcp, turns });
    expect(cursor.args).toContain('stream-json');
    expect(cursor.cwd).toBeNull();
    const perms = JSON.parse(cursor.files.find((f) => f.path === '.cursor/cli.json')?.content ?? '{}').permissions;
    expect(perms.deny).toEqual(['Shell(*)', 'Write(**)']);
    expect(replayPrompt('S', [], 'm')).toBe('S\n\n## New message\nm');
  });

  it('the prompt carries the policy and the genui card signatures', () => {
    const p = askAgentPrompt();
    expect(p).toContain('runs_start');
    expect(p).toMatch(/Never submit an application and never send an email/);
    expect(p).toContain('RoleCard(roleId: string)');
    expect(p).not.toContain('—'.repeat(2));
  });
});

describe('stream parsing helpers', () => {
  it('maps tool names to ops and finds runs in results', () => {
    expect(opOfTool('mcp__pp__runs_start')).toBe('runs.start');
    expect(opOfTool('pp-roles_list')).toBe('roles.list');
    expect(opOfTool('WebSearch')).toBeNull();
    expect(findRun([{ type: 'text', text: '{"run":{"id":"run_1","op":"score"}}' }])).toEqual({ run_id: 'run_1', skill: 'score' });
    expect(findRun({ items: [] })).toBeNull();
    expect(classifyAskFailure('Invalid API key · Please run /login')).toBe('not_logged_in');
    expect(classifyAskFailure('boom')).toBe('runner_failed');
  });
});

describe('runAsk (fake runner, recorded transcripts)', () => {
  it('claude: thread, text, tool calls, the run it started, done; the next turn resumes the session', async () => {
    const launcher = fakeAskLauncher(() => claudeScoreTranscript());
    const d = deps(launcher);
    const events = await collect(runAsk({ message: 'Score my inbox roles', context: { screen: 'river' } }, d));
    expect(events[0]).toMatchObject({ type: 'thread', runner: 'claude' });
    expect(events.filter((e) => e.type === 'tool').map((e) => (e as { op: string | null }).op)).toEqual(['roles.list', 'runs.start']);
    expect(events.filter((e) => e.type === 'run')).toEqual([{ type: 'run', run_id: 'run_0001', skill: 'score' }]);
    const text = events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
    // The partial deltas are not repeated by the full assistant messages.
    expect(text).toBe('Checking the inbox.root = Reply([t])\nt = Text("Score run started for 3 inbox roles")');
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(launcher.specs[0]?.args[1]).toBe('[context] screen: river\n\nScore my inbox roles');

    const thread = (events[0] as { thread_id: string }).thread_id;
    const again = await collect(runAsk({ thread_id: thread, message: 'and now?' }, d));
    expect(again[0]).toMatchObject({ type: 'thread', thread_id: thread });
    const args = launcher.specs[1]?.args ?? [];
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-0001');
  });

  it('codex and cursor transcripts normalize to the same events; codex replays the first turn', async () => {
    const launcher = fakeAskLauncher(() => codexTranscript());
    const d = deps(launcher, { command: 'codex' });
    const ev = await collect(runAsk({ message: 'scout' }, d));
    expect(ev.filter((e) => e.type === 'run')).toEqual([{ type: 'run', run_id: 'run_0002', skill: 'scout' }]);
    expect(ev.find((e) => e.type === 'tool')).toMatchObject({ op: 'runs.start' });
    expect(ev.at(-1)).toEqual({ type: 'done' });
    const thread = (ev[0] as { thread_id: string }).thread_id;
    await collect(runAsk({ thread_id: thread, message: 'again' }, d));
    expect(launcher.specs[1]?.args.at(-1)).toContain('User: scout');

    const cur = await collect(
      runAsk(
        { message: 'inbox?' },
        deps(
          fakeAskLauncher(() => cursorTranscript()),
          { command: 'cursor-agent' },
        ),
      ),
    );
    expect(cur.find((e) => e.type === 'tool')).toMatchObject({ op: 'roles.list' });
    expect(cur.find((e) => e.type === 'text')).toMatchObject({ delta: expect.stringContaining('Nothing in the inbox') });
    expect(cur.at(-1)).toEqual({ type: 'done' });
  });

  it('errors: runner missing, not logged in, crash, bad input, busy thread', async () => {
    const missing = await collect(runAsk({ message: 'hi' }, deps(fakeAskLauncher(() => 'missing'))));
    expect(missing.at(-1)).toMatchObject({ type: 'error', code: 'runner_missing' });
    const out = await collect(runAsk({ message: 'hi' }, deps(fakeAskLauncher(() => claudeLoggedOutTranscript()))));
    expect(out.at(-1)).toMatchObject({ type: 'error', code: 'not_logged_in' });
    const crash = await collect(runAsk({ message: 'hi' }, deps(fakeAskLauncher(() => ({ lines: [], code: 1, stderr: 'segfault' })))));
    expect(crash.at(-1)).toEqual({ type: 'error', code: 'runner_failed', message: 'segfault' });
    const bad = await collect(runAsk({ message: '' }, deps(fakeAskLauncher(() => []))));
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ type: 'error', code: 'invalid_input' });

    let release: (v: string[]) => void = () => {};
    const threads = new AskThreads();
    const slow = deps(
      fakeAskLauncher((_s, n) => (n === 0 ? new Promise<string[]>((r) => (release = r)) : claudeScoreTranscript())),
      { command: 'claude' },
      threads,
    );
    const first = runAsk({ message: 'one' }, slow);
    const head = await first.next();
    const thread = (head.value as { thread_id: string }).thread_id;
    const pending = collect(first);
    await new Promise((r) => setTimeout(r, 0));
    const busy = await collect(runAsk({ thread_id: thread, message: 'two' }, slow));
    expect(busy).toEqual([{ type: 'error', code: 'busy', message: expect.any(String) }]);
    release(claudeScoreTranscript());
    expect((await pending).at(-1)).toEqual({ type: 'done' });
  });
});

describe('Ask threads in the vault (#69)', () => {
  let engine: FixtureEngine | null = null;
  afterEach(() => {
    engine?.cleanup();
    engine = null;
  });

  it('a finished turn keeps how long it took (#100)', async () => {
    engine = openFixtureEngine();
    let t = Date.parse('2026-10-08T12:00:00.000Z');
    const clock = () => {
      t += 1000;
      return new Date(t);
    };
    const threads = new AskThreads({ store: dbAskThreadStore(engine.db), now: clock });
    const ev = await collect(
      runAsk(
        { message: 'Score my inbox roles' },
        deps(
          fakeAskLauncher(() => claudeScoreTranscript()),
          undefined,
          threads,
        ),
      ),
    );
    const id = (ev[0] as { thread_id: string }).thread_id;
    const row = engine.db.prepare('SELECT turns_json FROM ask_thread WHERE id = ?').get(id) as { turns_json: string };
    expect(JSON.parse(row.turns_json)[0].ms).toBe(1000);
  });

  it('a restart resumes a thread by id (Claude session, Codex replay), caps its turns and prunes idle ones', async () => {
    engine = openFixtureEngine();
    const db = engine.db;
    let now = new Date('2026-10-08T12:00:00.000Z');
    const clock = () => now;
    const launcher = fakeAskLauncher(() => claudeScoreTranscript());
    const first = await collect(
      runAsk({ message: 'Score my inbox roles' }, deps(launcher, undefined, new AskThreads({ store: dbAskThreadStore(db), now: clock }))),
    );
    const id = (first[0] as { thread_id: string }).thread_id;
    expect(id).toMatch(/^ask_/);
    const row = db.prepare('SELECT * FROM ask_thread WHERE id = ?').get(id) as Record<string, string>;
    expect(row.runner).toBe('claude');
    expect(row.session_id).toBe('sess-0001');
    expect(JSON.parse(row.turns_json)).toEqual([{ user: 'Score my inbox roles', reply: expect.stringContaining('root = Reply'), ms: 0 }]);

    // `pp up` restarted: new memory, same vault.
    const again = await collect(
      runAsk(
        { thread_id: id, message: 'and now?' },
        deps(launcher, undefined, new AskThreads({ store: dbAskThreadStore(db), now: clock })),
      ),
    );
    expect(again[0]).toMatchObject({ type: 'thread', thread_id: id });
    const args = launcher.specs[1]?.args ?? [];
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-0001');
    expect(
      JSON.parse((db.prepare('SELECT turns_json FROM ask_thread WHERE id = ?').get(id) as { turns_json: string }).turns_json),
    ).toHaveLength(2);

    // Codex replays the restored turns; the newest ASK_THREAD_MAX_TURNS are kept.
    const codex = fakeAskLauncher(() => codexTranscript());
    const cThreads = () => new AskThreads({ store: dbAskThreadStore(db), now: clock });
    const c0 = await collect(runAsk({ message: 'turn 0' }, deps(codex, { command: 'codex' }, cThreads())));
    const cid = (c0[0] as { thread_id: string }).thread_id;
    for (let i = 1; i <= ASK_THREAD_MAX_TURNS + 2; i++)
      await collect(runAsk({ thread_id: cid, message: `turn ${i}` }, deps(codex, { command: 'codex' }, cThreads())));
    expect(codex.specs.at(-1)?.args.at(-1)).toContain(`User: turn ${ASK_THREAD_MAX_TURNS + 1}`);
    const turns = JSON.parse((db.prepare('SELECT turns_json FROM ask_thread WHERE id = ?').get(cid) as { turns_json: string }).turns_json);
    expect(turns).toHaveLength(ASK_THREAD_MAX_TURNS);
    expect(turns[0].user).toBe('turn 3');

    // A runner change starts a new thread; an unknown id starts one too.
    const swapped = await collect(runAsk({ thread_id: cid, message: 'hi' }, deps(launcher, undefined, cThreads())));
    expect((swapped[0] as { thread_id: string }).thread_id).not.toBe(cid);

    // 31 days idle: pruned on the next open; recent ones stay.
    now = new Date('2026-11-08T13:00:00.000Z');
    db.prepare('UPDATE ask_thread SET updated_at = ? WHERE id = ?').run('2026-10-30T00:00:00.000Z', cid);
    new AskThreads({ store: dbAskThreadStore(db), now: clock });
    const left = (db.prepare('SELECT id FROM ask_thread').all() as { id: string }[]).map((r) => r.id);
    expect(left).toEqual([cid]);
    const gone = await collect(
      runAsk(
        { thread_id: id, message: 'still there?' },
        deps(launcher, undefined, new AskThreads({ store: dbAskThreadStore(db), now: clock })),
      ),
    );
    expect((gone[0] as { thread_id: string }).thread_id).not.toBe(id);
  });
});

describe('runs.start from the Ask agent (queue: true)', () => {
  let engine: FixtureEngine | null = null;
  afterEach(() => {
    engine?.cleanup();
    engine = null;
  });

  it('an agent with queue: true gets a queued headless run (actor ask) that the dispatcher launches; without it, the agent is the run', async () => {
    engine = openFixtureEngine();
    const queued = okOut(await engine.runOp('runs.start', { skill: 'score', queue: true }, ctxAt('agent')));
    expect(queued.run.summary_json.actor).toBe('ask');
    expect(engine.launcher.specs.map((s) => s.runId)).toContain(queued.run.id);
    const own = okOut(await engine.runOp('runs.start', { skill: 'research', role_id: undefined }, ctxAt('agent')));
    expect(own.run.status).toBe('running');
    expect(engine.launcher.specs.map((s) => s.runId)).not.toContain(own.run.id);
  });
});
