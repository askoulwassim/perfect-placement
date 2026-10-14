import { SKILLS, type Skill } from '@perfect-placement/contracts';
import { describe, expect, it } from 'vitest';
import { CODEX_BROWSER_FILL_TOOLS, CODEX_BROWSER_READ_TOOLS } from './codex-connectors.js';
import { buildRunnerSpec, DEFAULT_SKILLS_DIR, gmailDraftPrompt, gmailToPrompt, skillPrompt } from './runner.js';

const mcp = { command: 'node', args: ['/x/mcp/dist/bin.js'], env: { PP_HOME: '/tmp/pp-home' } };
const context = { runId: 'rn_1', roleId: 'r_1', contactId: 'ct_1', outreachId: 'out_1' };
function spec(skill: Skill, opts: { assist?: boolean; linkedin?: boolean; gmailDraft?: boolean; gmailTo?: boolean; prompt?: string } = {}) {
  return buildRunnerSpec({
    runner: { command: 'codex' },
    prompt: opts.prompt ?? skillPrompt(DEFAULT_SKILLS_DIR, { ...context, skill, assist: opts.assist }),
    runId: context.runId,
    skill,
    home: '/tmp/pp-home',
    mcp,
    ...opts,
  });
}

function browserTools(args: string[]): string[] | undefined {
  const setting = args.find((arg) => arg.startsWith('mcp_servers.pp_browser.enabled_tools='));
  return setting ? JSON.parse(setting.slice(setting.indexOf('=') + 1)) : undefined;
}

describe('Codex connector bindings', () => {
  it('exposes only browser reads, with filling and uploads only for fill assist', () => {
    for (const skill of SKILLS) {
      const expected = ['fill', 'connect', 'voice'].includes(skill) ? [...CODEX_BROWSER_READ_TOOLS] : undefined;
      expect(browserTools(spec(skill).args)).toEqual(expected);
    }
    const assist = spec('fill', { assist: true });
    expect(browserTools(assist.args)).toEqual([...CODEX_BROWSER_READ_TOOLS, ...CODEX_BROWSER_FILL_TOOLS]);
    expect(browserTools(spec('connect', { assist: true }).args)).toEqual([...CODEX_BROWSER_READ_TOOLS]);
    expect(browserTools(spec('connect', { linkedin: false }).args)).toBeUndefined();
    expect(browserTools(spec('voice', { linkedin: false }).args)).toBeUndefined();
    expect(assist.args).toContain('mcp_servers.pp_browser.default_tools_approval_mode="approve"');
    const command = assist.args.find((arg) => arg.startsWith('mcp_servers.pp_browser.args='));
    expect(command).toContain('chrome-devtools-mcp@1.10.1');
    expect(command).toContain('--autoConnect');
    expect(command).toContain('--no-usage-statistics');
    expect(command).toContain('--no-performance-crux');
    expect(command).toContain('--no-javascript-evaluation');
    for (const denied of ['click', 'press_key', 'type_text', 'evaluate_script', 'handle_dialog', 'take_screenshot']) {
      expect(browserTools(assist.args)).not.toContain(denied);
    }
  });

  it('delivers the fill workflow with real Codex browser names and schemas, keeping submit and tab restrictions', () => {
    const prompt = spec('fill', { assist: true }).args.at(-1) as string;
    expect(prompt).toContain('mcp__pp_browser__take_snapshot');
    expect(prompt).toContain('fill_form takes elements: [{ uid, value }] and pageId');
    expect(prompt).toContain('upload_file takes uid, filePaths:');
    expect(prompt).toContain('Use an actual file input, never a chooser-opening button');
    expect(prompt).toContain('Existing pages belong to the user: never navigate, fill or close them');
    expect(prompt).toContain('Leave the filled, run-owned portal page open');
    expect(prompt).toContain('Never submit an application');
    expect(prompt).toContain('apply.fill_done');
    expect(prompt).toContain('web.run open');
    expect(prompt).not.toMatch(/mcp__claude|Claude in Chrome|tabs_context_mcp|form_input|file_upload|error_code: "connector_unavailable"/);
    expect(prompt).not.toContain('engine retries');
  });

  it('grants file access only to the rendered-document folder, without adding a Codex writable root', () => {
    const dir = '/tmp/fixture-vault/files/r_1';
    const s = buildRunnerSpec({
      runner: { command: 'codex' },
      prompt: 'P',
      runId: 'rn_1',
      skill: 'fill',
      home: '/tmp/fixture-vault',
      mcp,
      assist: true,
      filesDir: dir,
    });
    const setting = s.args.find((arg) => arg.startsWith('mcp_servers.pp_browser.args=')) as string;
    const browserArgs = JSON.parse(setting.slice(setting.indexOf('=') + 1)) as string[];
    expect(browserArgs.filter((arg) => arg.startsWith('--workspace'))).toEqual([`--workspace=${dir}`]);
    expect(s.args).not.toContain('--add-dir');
    const readOnly = buildRunnerSpec({
      runner: { command: 'codex' },
      prompt: 'P',
      runId: 'rn_1',
      skill: 'fill',
      home: '/tmp/fixture-vault',
      mcp,
      filesDir: dir,
    });
    expect(readOnly.args.join(' ')).not.toContain('--workspace');
  });

  it('keeps pasted questions usable and preserves the writing rules', () => {
    const prompt = spec('fill', {
      prompt: skillPrompt(DEFAULT_SKILLS_DIR, { ...context, skill: 'fill', questions: 'applications/r_1/questions.md' }),
    }).args.at(-1) as string;
    expect(prompt).toContain("the user pasted this portal's questions");
    expect(prompt).toContain('do not read the portal for questions');
    expect(prompt).toContain('the only source of facts');
    expect(prompt).toContain('No em dashes');
    expect(prompt).not.toContain('mcp__pp_browser__fill_form');
    expect(prompt).not.toContain('mcp__pp_browser__upload_file');
  });

  it('binds Gmail to connected capabilities without inventing server names or retrying missing setup', () => {
    for (const skill of ['inbox', 'voice', 'connect'] as const) {
      const prompt = spec(skill).args.at(-1) as string;
      expect(prompt).toContain('Gmail search');
      expect(prompt).toContain('call their actual names and schemas');
      expect(prompt).toContain('setup required: <capability>');
      expect(prompt).not.toMatch(/mcp__claude_ai_Gmail|error_code: "connector_unavailable"/);
      expect(prompt).not.toContain('engine retries');
      const grants = prompt.split('\n').find((line) => line.startsWith('Allowed Gmail capabilities:'));
      expect(grants?.includes('Gmail create draft')).toBe(skill === 'connect');
      expect(grants).not.toContain('update draft');
    }
  });

  it('keeps draft creation and To updates separate and grants neither browser tools nor extra Gmail writes', () => {
    const draft = spec('connect', { gmailDraft: true, prompt: gmailDraftPrompt(DEFAULT_SKILLS_DIR, context) });
    const update = spec('connect', { gmailTo: true, prompt: gmailToPrompt(DEFAULT_SKILLS_DIR, context) });
    for (const s of [draft, update]) {
      expect(browserTools(s.args)).toBeUndefined();
      expect(s.args.at(-1)).not.toMatch(/mcp__claude|error_code: "connector_unavailable"/);
      expect(s.args.at(-1)).toContain('Never send');
    }
    const grants = (args: string[]) =>
      args
        .at(-1)
        ?.split('\n')
        .find((line) => line.startsWith('Allowed Gmail capabilities:'));
    expect(grants(draft.args)).toContain('Gmail create draft');
    expect(grants(draft.args)).not.toContain('update draft');
    expect(grants(update.args)).toContain('Gmail read draft, Gmail update draft recipient');
    expect(grants(update.args)).not.toContain('Gmail create draft');
  });
});
