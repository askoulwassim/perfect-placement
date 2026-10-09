import { afterEach, describe, expect, it } from 'vitest';
import { ctxAt, type FixtureEngine, fakeLauncher, okOut, openFixtureEngine } from '../testing/index.js';
import {
  buildRunnerSpec,
  DEFAULT_SKILLS_DIR,
  defaultMcpServer,
  GMAIL_DRAFT_TOOL,
  gmailDraftPrompt,
  gmailStepSection,
  MCP_SERVER_NAME,
  skillPrompt,
} from './runner.js';

/* runs.start launches the configured headless runner (fake launcher: nothing spawns in tests or CI). */

let e: FixtureEngine;
afterEach(() => e?.cleanup());
const mcp = { command: 'node', args: ['/x/mcp/dist/bin.js'], env: { PP_HOME: '/tmp/pp-home' } };

describe('runner command lines', () => {
  it('claude: print mode, the pp MCP server only, its tools allowed, no prompts; Chrome for connect', () => {
    const s = buildRunnerSpec({ runner: { command: 'claude' }, prompt: 'P', runId: 'rn_1', skill: 'research', home: '/tmp/pp-home', mcp });
    expect(s.command).toBe('claude');
    expect(s.args.slice(0, 2)).toEqual(['-p', 'P']);
    const cfg = JSON.parse(s.args[s.args.indexOf('--mcp-config') + 1] as string);
    expect(cfg).toEqual({
      mcpServers: { [MCP_SERVER_NAME]: { command: 'node', args: ['/x/mcp/dist/bin.js'], env: { PP_HOME: '/tmp/pp-home' } } },
    });
    expect(s.args).toEqual(expect.arrayContaining(['--strict-mcp-config', '--allowedTools', 'mcp__pp', '--permission-prompts', 'none']));
    expect(s.args).not.toContain('--chrome');
    expect(s.cwd).toBe('/tmp/pp-home');
    expect(s.env).toMatchObject({ PP_HOME: '/tmp/pp-home', PP_RUN_ID: 'rn_1' });
    const connect = buildRunnerSpec({
      runner: { command: 'claude', args: ['--model', 'opus'] },
      prompt: 'P',
      runId: 'rn_1',
      skill: 'connect',
      home: '/h',
      mcp,
    });
    expect(connect.args).toEqual(expect.arrayContaining(['--chrome', '--model', 'opus']));
  });

  it('codex: exec outside a git repo, MCP server via -c overrides, no approvals', () => {
    const s = buildRunnerSpec({ runner: { command: 'codex' }, prompt: 'P', runId: 'rn_1', skill: 'tailor', home: '/h', mcp });
    expect(s.args[0]).toBe('exec');
    expect(s.args).toEqual(
      expect.arrayContaining([
        '--skip-git-repo-check',
        'mcp_servers.pp.command="node"',
        'mcp_servers.pp.args=["/x/mcp/dist/bin.js"]',
        'mcp_servers.pp.env.PP_HOME="/tmp/pp-home"',
        'approval_policy="never"',
      ]),
    );
    expect(s.args.at(-1)).toBe('P');
  });

  it('cursor-agent: print mode, MCP config in a temp project dir, approvals off', () => {
    const s = buildRunnerSpec({ runner: { command: 'cursor-agent' }, prompt: 'P', runId: 'rn_1', skill: 'fill', home: '/h', mcp });
    expect(s.args).toEqual(['-p', 'P', '--output-format', 'text', '--approve-mcps', '--force']);
    expect(s.cwd).toBeNull();
    expect(s.files[0]?.path).toBe('.cursor/mcp.json');
    expect(JSON.parse(s.files[0]?.content as string).mcpServers.pp.command).toBe('node');
  });

  it('the prompt is the skill file plus the run ids', () => {
    const p = skillPrompt(DEFAULT_SKILLS_DIR, { runId: 'rn_9', skill: 'research', roleId: 'acme_pm' });
    expect(p).toContain('run_id: rn_9');
    expect(p).toContain('role_id: acme_pm');
    expect(p).toContain('# Research');
    expect(p).toContain('runs.finish');
    expect(defaultMcpServer('/h').env).toEqual({ PP_HOME: '/h' });
  });
});

describe('runs.start', () => {
  it('commits the run, then launches the configured runner once', async () => {
    e = openFixtureEngine({ config: { runner: { command: 'codex' } } });
    const run = okOut(await e.runOp('runs.start', { skill: 'tailor', role_id: 'linear_product-lead-insights' }, ctxAt('human'))).run;
    expect(run.status).toBe('running');
    expect(e.launcher.specs).toHaveLength(1);
    expect(e.launcher.specs[0]).toMatchObject({ command: 'codex', runId: run.id });
    expect(e.launcher.specs[0]?.args.at(-1)).toContain('linear_product-lead-insights');
  });

  it('a dry run or a failed op launches nothing; a runner that cannot start finishes the run as error', async () => {
    e = openFixtureEngine();
    await e.runOp('runs.start', { skill: 'scout' }, ctxAt('human', { dryRun: true }));
    await e.runOp('runs.start', { skill: 'tailor', role_id: 'nope' }, ctxAt('human'));
    expect(e.launcher.specs).toHaveLength(0);
    e.cleanup();
    const broken = fakeLauncher('spawn claude ENOENT');
    e = openFixtureEngine({ services: { launcher: broken } });
    const run = okOut(await e.runOp('runs.start', { skill: 'scout' }, ctxAt('human'))).run;
    expect(broken.specs).toHaveLength(1);
    const row = okOut(await e.runOp('runs.get', { run_id: run.id }, ctxAt('human')));
    expect(row.run.status).toBe('error');
    expect(row.log_md).toContain('did not start: spawn claude ENOENT');
  });
});

describe('runs.start from an agent session', () => {
  it('records the run but launches nothing (the agent is the session doing the work)', async () => {
    e = openFixtureEngine();
    okOut(await e.runOp('runs.start', { skill: 'research', role_id: 'linear_product-lead-insights' }, ctxAt('agent')));
    expect(e.launcher.specs).toHaveLength(0);
  });
});

describe('runs.start: the Gmail draft step (Gmail via agent)', () => {
  it('claude: the Gmail connector loads (no strict MCP config), only create_draft is allowed, sending is denied, no Chrome', () => {
    const s = buildRunnerSpec({
      runner: { command: 'claude' },
      prompt: 'P',
      runId: 'rn_1',
      skill: 'connect',
      home: '/h',
      mcp,
      gmailDraft: true,
    });
    expect(s.args).not.toContain('--strict-mcp-config');
    expect(s.args).not.toContain('--chrome');
    expect(s.args[s.args.indexOf('--allowedTools') + 1]).toBe(`mcp__pp,${GMAIL_DRAFT_TOOL}`);
    const denied = s.args[s.args.indexOf('--disallowedTools') + 1] as string;
    expect(denied).toContain('mcp__claude_ai_Gmail__send_message');
    expect(denied).not.toContain('create_draft');
  });

  it('the prompt: read outreach.get, create a draft (never send), record with gmail_draft_id + confidence, finish', () => {
    const p = gmailDraftPrompt(DEFAULT_SKILLS_DIR, { runId: 'rn_9', outreachId: 'or_1', roleId: 'acme_pm', contactId: 'ct_1' });
    expect(p).toContain('outreach_id: or_1');
    expect(p).toContain('outreach_get');
    expect(p).toContain('Never send');
    expect(p).toMatch(/outreach_to_gmail \{ outreach_id: "or_1", gmail_draft_id: .*confidence/);
    expect(p).toContain('runs_finish { run_id: "rn_9"');
    // The skill's own Gmail draft step is appended; nothing else of the connect skill (no people.find).
    expect(p).toContain('## Gmail draft step');
    expect(p).not.toContain('people.find');
    expect(gmailStepSection('# x\n\n## Gmail draft step\n\nA\n\n## Never\n\nB')).toBe('## Gmail draft step\n\nA');
  });

  it('runs.start { skill: connect, outreach_id } launches the Gmail run with role + contact from the outreach (fake launcher)', async () => {
    e = openFixtureEngine();
    const run = okOut(await e.runOp('runs.start', { skill: 'connect', outreach_id: 'or_0001' }, ctxAt('human'))).run;
    expect(run.summary_json).toMatchObject({ skill: 'connect', outreach_id: 'or_0001', step: 'gmail_draft' });
    expect(e.launcher.specs).toHaveLength(1);
    const spec = e.launcher.specs[0];
    expect(spec?.args).not.toContain('--chrome');
    const prompt = spec?.args[1] as string;
    expect(prompt).toContain(`run_id: ${run.id}`);
    expect(prompt).toContain('outreach_id: or_0001');
    expect(prompt).toMatch(/role_id: \S+/);
    expect(prompt).toContain('gmail_draft_id');
  });

  it('refuses outreach_id on another skill, an unknown outreach, a mismatched role, or a draft already in Gmail', async () => {
    e = openFixtureEngine();
    expect(await e.runOp('runs.start', { skill: 'tailor', outreach_id: 'or_0001' }, ctxAt('human'))).toMatchObject({
      code: 'invalid_input',
    });
    expect(await e.runOp('runs.start', { skill: 'connect', outreach_id: 'or_nope' }, ctxAt('human'))).toMatchObject({ code: 'not_found' });
    expect(await e.runOp('runs.start', { skill: 'connect', outreach_id: 'or_0001', role_id: 'stripe_x' }, ctxAt('human'))).toMatchObject({
      code: 'invalid_input',
    });
    okOut(await e.runOp('outreach.to_gmail', { outreach_id: 'or_0001', gmail_draft_id: 'r-1' }, ctxAt('human')));
    expect(await e.runOp('runs.start', { skill: 'connect', outreach_id: 'or_0001' }, ctxAt('human'))).toMatchObject({ code: 'conflict' });
    expect(e.launcher.specs).toHaveLength(0);
  });
});
