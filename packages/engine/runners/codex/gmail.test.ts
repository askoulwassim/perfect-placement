import { SKILLS } from '@perfect-placement/contracts';
import { describe, expect, it } from 'vitest';
import { buildAskSpec } from '../../ops/ask.js';
import { ctxAt, okOut, openFixtureEngine } from '../../testing/index.js';
import { buildRunnerSpec, DEFAULT_SKILLS_DIR, gmailDraftPrompt, gmailToPrompt } from '../index.js';
import { CODEX_GMAIL_TOOLS, codexGmailTools, requireCodexGmailIsolation } from './gmail.js';
import { codexSafeArgs, isolatedCodexArgs, prepareCodex } from './isolation.js';
import { codexGrants, codexPreamble } from './text.js';

const mcp = { command: 'node', args: ['/synthetic/pp.js'], env: { PP_HOME: '/synthetic/vault' } };
const spec = (skill: (typeof SKILLS)[number]) =>
  buildRunnerSpec({ runner: { command: 'codex' }, prompt: 'P', runId: 'rn_test', skill, home: '/synthetic/vault', mcp });

describe('Codex Gmail fail-closed policy (#158)', () => {
  it('declares exact grants for every skill, mode and Ask from one policy', () => {
    const reads = ['gmail.search_emails', 'gmail.read_email_thread', 'gmail.read_email'];
    for (const skill of SKILLS) {
      const expected = skill === 'connect' ? [...reads, 'gmail.create_draft'] : ['inbox', 'voice'].includes(skill) ? reads : [];
      expect(codexGmailTools({ skill })).toEqual(expected);
      expect(
        codexGrants({ skill })
          .filter((c) => c.startsWith('gmail.'))
          .map((c) => CODEX_GMAIL_TOOLS[c as keyof typeof CODEX_GMAIL_TOOLS]),
      ).toEqual(expected);
      expect(spec(skill).codexIsolation?.gmailTools).toEqual(expected);
    }
    expect(codexGmailTools({ skill: 'connect', mode: 'gmail_draft' })).toEqual(['gmail.create_draft']);
    expect(codexGmailTools({ skill: 'connect', mode: 'gmail_to' })).toEqual(['gmail.update_draft']);
    expect(codexGmailTools()).toEqual([]);
    expect(buildAskSpec({ runner: { command: 'codex' }, message: 'hi', home: '/synthetic/vault', mcp }).codexIsolation).toEqual({
      gmailTools: [],
      servers: ['pp'],
    });
  });

  it('never launches a Gmail agent, including missing plugin/auth/schema and unknown runtime cases', async () => {
    for (const skill of ['inbox', 'voice', 'connect'] as const) {
      expect(() => requireCodexGmailIsolation(codexGmailTools({ skill }))).toThrow('setup required: Gmail');
      // No executable, credentials or machine inspection is reached: enforcement is already known insufficient.
      await expect(prepareCodex(spec(skill), '/nonexistent')).rejects.toThrow('setup required: Gmail');
    }
    for (const mode of ['gmail_draft', 'gmail_to'] as const)
      expect(() => requireCodexGmailIsolation(codexGmailTools({ skill: 'connect', mode }))).toThrow('setup required: Gmail');
  });

  it.each([
    ['--profile', 'send-approved'],
    ['-p', 'send-approved'],
    ['--enable', 'apps'],
    ['--dangerously-bypass-approvals-and-sandbox'],
    ['-c', 'apps._default.enabled=true'],
    ['--config', 'mcp_servers.alias.enabled=true'],
    ['-c', 'features.plugins=true'],
    ['-c', 'mcp_servers.pp.command="alternate-provider"'],
    ['-c', 'mcp_servers.pp_browser.enabled_tools=["send"]'],
    ['-c', 'approval_policy="on-request"'],
    ['exec'],
    ['--model=other'],
  ])('rejects conflicting runner arguments %j', (...args) => {
    expect(() => codexSafeArgs(args)).toThrow('setup required: Gmail');
  });

  it('preserves model choices and stricter PP approvals', () => {
    const args = [
      '-m',
      'example-model',
      '-c',
      'model_reasoning_effort="high"',
      '-c',
      'mcp_servers.pp.default_tools_approval_mode="prompt"',
    ];
    expect(codexSafeArgs(args)).toEqual(args);
  });

  it('disables inherited providers by exact table key and closes apps, shell, plugins and agents', () => {
    const s = spec('score');
    const args = isolatedCodexArgs(s, {
      mcp_servers: { gmail: {}, 'gmail.alias': {}, 'spoof"name': {}, codex_apps: {}, pp_browser: {}, pp: {} },
    });
    const disabled = args.find((arg) => arg.startsWith('mcp_servers={'));
    expect(disabled).toContain('"gmail.alias"={enabled=false,');
    expect(disabled).toContain('"spoof\\"name"={enabled=false,');
    for (const setting of [
      'features.apps=false',
      'features.plugins=false',
      'features.remote_plugin=false',
      'features.shell_tool=false',
      'agents.enabled=false',
    ])
      expect(args).toContain(setting);
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('mcp_servers.pp.enabled=true');
    expect(args).not.toContain('mcp_servers.pp_browser.enabled=true');
    expect(args.at(-1)).toBe('P');
    expect(() => isolatedCodexArgs(s, {})).toThrow('setup required: Gmail');
  });

  it.each([undefined, 'inbox'] as const)('finishes a %s run through ops without launch or retry', async (schedule) => {
    const e = openFixtureEngine({ config: { runner: { command: 'codex' } } });
    try {
      const run = okOut(await e.runOp('runs.start', { skill: 'inbox', ...(schedule ? { schedule } : {}) }, ctxAt('human'))).run;
      const got = okOut(await e.runOp('runs.get', { run_id: run.id }, ctxAt('human')));
      expect(got.run.status).toBe('error');
      expect(got.run.summary_json.error).toBe('setup required: Gmail');
      expect(got.run.summary_json.retried).toBeUndefined();
      expect(got.log_md).toContain('Exact Gmail isolation is not verified');
      expect(e.launcher.specs).toHaveLength(0);
      expect(okOut(await e.runOp('runs.list', { op: 'inbox' }, ctxAt('human'))).items.filter((r) => r.id === run.id)).toHaveLength(1);
    } finally {
      e.cleanup();
    }
  });

  it('binds sparse To updates to the saved draft id and confirmed recipient only', () => {
    const context = { runner: 'codex' as const, runId: 'rn_test', outreachId: 'or_test', roleId: 'synthetic_role', contactId: 'ct_test' };
    const to = gmailToPrompt(DEFAULT_SKILLS_DIR, context);
    expect(to).toContain('ONLY { draft_id: outreach.gmail_draft_id, to: to.email }');
    expect(to).toContain('no to.decision_id');
    expect(to).toContain('MIME tree and attachments');
    expect(to).not.toContain('get_draft');
    expect(to).not.toContain('subject and body you just read');
    const draft = gmailDraftPrompt(DEFAULT_SKILLS_DIR, context);
    expect(draft).toContain('mime_type: "text/plain"');
    expect(draft).toContain('never message.id or a thread id');
    expect(draft).toContain('never use `to.guess`');
    const connect = codexPreamble({ caps: codexGrants({ skill: 'connect' }), runId: 'rn_test', assist: false }).join('\n');
    expect(connect).toContain('mime_type: "text/plain"');
    expect(connect).toContain('never message.id or a thread id');
  });
});
