import { DEFAULT_CONFIG, SKILLS, type Skill } from '@perfect-placement/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserEnvironment } from '../browser/env.js';
import { BROWSER_FILL_TOOLS, BROWSER_READ_TOOLS } from '../browser/policy.js';
import { browserRuntime } from '../browser/runtime.js';
import { buildRunnerSpec, DEFAULT_SKILLS_DIR, gmailDraftPrompt, gmailToPrompt, skillPrompt, uploadsLine } from '../index.js';

const mcp = { command: '/opt/node/bin/node', args: ['/x/mcp/dist/bin.js'], env: { PP_HOME: '/tmp/pp-home' } };
const context = { runId: 'rn_1', roleId: 'r_1', contactId: 'ct_1', outreachId: 'out_1' };
const filesDir = '/tmp/pp-home/files/r_1';
function spec(
  skill: Skill,
  opts: { assist?: boolean; linkedin?: boolean; gmailDraft?: boolean; gmailTo?: boolean; prompt?: string; filesDir?: string } = {},
) {
  return buildRunnerSpec({
    runner: { command: 'codex' },
    prompt:
      opts.prompt ??
      skillPrompt(DEFAULT_SKILLS_DIR, {
        ...context,
        runner: 'codex',
        skill,
        assist: opts.assist,
        ...(opts.filesDir
          ? {
              uploads: {
                dir: opts.filesDir,
                files: [
                  { doc: 'resume', abs_path: `${opts.filesDir}/resume.pdf` },
                  { doc: 'cover_letter', abs_path: `${opts.filesDir}/cover_letter.pdf` },
                ],
              },
            }
          : {}),
        linkedin: { ...DEFAULT_CONFIG.linkedin, mode: opts.linkedin === false ? 'off' : 'live', budget_left: 5 },
        voice: { linkedin: opts.linkedin !== false, max_pages: 5 },
      }),
    runId: context.runId,
    skill,
    home: '/tmp/pp-home',
    mcp,
    ...opts,
  });
}

/** The run's browser policy, as the adapter receives it (#161). */
function policyOf(args: string[]): { tools: string[]; uploads: string[]; sites: string[] } {
  const setting = args.find((arg) => arg.startsWith('mcp_servers.pp_browser.args=')) as string;
  const adapterArgs = JSON.parse(setting.slice(setting.indexOf('=') + 1)) as string[];
  return JSON.parse(adapterArgs[adapterArgs.indexOf('--policy') + 1] as string);
}

function browserTools(args: string[]): string[] | undefined {
  const setting = args.find((arg) => arg.startsWith('mcp_servers.pp_browser.enabled_tools='));
  return setting ? JSON.parse(setting.slice(setting.indexOf('=') + 1)) : undefined;
}

function expectNoUploadInstructions(prompt: string): void {
  expect(prompt).not.toContain('upload_file');
  expect(prompt).not.toMatch(/^Uploads: (?:call |rendered )|^3\. Upload:|\bUpload these absolute paths with/m);
  expect(prompt).not.toMatch(/\bcall apply\.render_documents \{|\bupload each returned abs_path/);
  expect(prompt).not.toContain('Only a prompt with no Uploads line renders here');
}

afterEach(() => vi.unstubAllEnvs());

describe('Codex connector bindings', () => {
  it('preserves explicit browser locations through Codex’s filtered MCP environment', () => {
    const locations = {
      HOME: '/tmp/pp-synthetic-user',
      XDG_CACHE_HOME: '/tmp/pp-synthetic-cache',
      XDG_CONFIG_HOME: '/tmp/pp-synthetic-config',
      CHROME_CONFIG_HOME: '/tmp/pp-browser scratch "quotes" \\ slash\nnew line\u007f',
      LOCALAPPDATA: '/tmp/pp-local-app-data',
      APPDATA: '/tmp/pp-app-data',
    };
    vi.stubEnv('XDG_CACHE_HOME', '/tmp/pp-parent-cache');
    vi.stubEnv('TMPDIR', '/tmp/pp-shell-scratch');
    vi.stubEnv('PP_BROWSER_TEST_SECRET', 'must-not-be-forwarded');
    const s = buildRunnerSpec({
      runner: { command: 'codex' },
      skill: 'fill',
      prompt: 'P',
      runId: 'rn_1',
      home: '/tmp/pp-home',
      mcp: { ...mcp, env: { ...mcp.env, ...locations } },
    });
    const prefix = 'mcp_servers.pp_browser.env.';
    const forwarded = Object.fromEntries(
      s.args
        .filter((arg) => arg.startsWith(prefix))
        .map((arg) => {
          const equals = arg.indexOf('=');
          return [arg.slice(prefix.length, equals), JSON.parse(arg.slice(equals + 1))];
        }),
    );
    expect(forwarded).toEqual(locations);
    expect(s.args.filter((arg) => arg.startsWith('mcp_servers.')).join('\n')).not.toContain('\u007f');
    expect(s.args.filter((arg) => arg.startsWith('mcp_servers.pp_browser.')).join('\n')).not.toContain('must-not-be-forwarded');
    // Codex retains only its small default allowlist plus explicit per-server env overrides.
    const filteredChildEnv = { HOME: '/tmp/pp-default-user', PATH: '/usr/bin', ...forwarded };
    const setting = s.args.find((arg) => arg.startsWith('mcp_servers.pp_browser.args=')) as string;
    const args = JSON.parse(setting.slice(setting.indexOf('=') + 1)) as string[];
    expect(browserRuntime({ env: filteredChildEnv }).dir).toBe(args[args.indexOf('--runtime-dir') + 1]);
    expect(browserEnvironment(filteredChildEnv)).toEqual(locations);
  });

  it('forwards only nonempty browser locations and adds no browser config to other runs', () => {
    expect(browserEnvironment({ HOME: '/tmp/user', XDG_CACHE_HOME: '', TOKEN: 'secret' })).toEqual({ HOME: '/tmp/user' });
    vi.stubEnv('XDG_CACHE_HOME', '/tmp/pp-browser-cache');
    for (const runner of ['claude', 'cursor-agent', 'codex'] as const) {
      const s = buildRunnerSpec({ runner: { command: runner }, skill: 'score', prompt: 'P', runId: 'rn_1', home: '/tmp/pp-home', mcp });
      expect(s.args.join('\n')).not.toContain('pp_browser');
      expect(s.args.join('\n')).not.toContain('/tmp/pp-browser-cache');
    }
  });

  it('exposes only browser reads, with filling and uploads only for fill assist', () => {
    for (const skill of SKILLS) {
      const expected = ['fill', 'connect', 'voice'].includes(skill) ? [...BROWSER_READ_TOOLS] : undefined;
      expect(browserTools(spec(skill).args)).toEqual(expected);
    }
    const assist = spec('fill', { assist: true, filesDir });
    expect(browserTools(assist.args)).toEqual([...BROWSER_READ_TOOLS, ...BROWSER_FILL_TOOLS]);
    expect(browserTools(spec('connect', { assist: true }).args)).toEqual([...BROWSER_READ_TOOLS]);
    expect(browserTools(spec('connect', { linkedin: false }).args)).toBeUndefined();
    expect(browserTools(spec('voice', { linkedin: false }).args)).toBeUndefined();
    expect(assist.args).toContain('mcp_servers.pp_browser.default_tools_approval_mode="approve"');
    const command = assist.args.find((arg) => arg.startsWith('mcp_servers.pp_browser.args='));
    expect(assist.args).toContain(`mcp_servers.pp_browser.command="${mcp.command}"`);
    expect(command).toContain('/packages/mcp/dist/browser-bin.js');
    expect(command).toContain('--runtime-dir');
    expect(command).toContain('--policy');
    expect(policyOf(assist.args).uploads).toEqual([`${filesDir}/resume.pdf`, `${filesDir}/cover_letter.pdf`]);
    expect(command).not.toMatch(/npx|--yes|chrome-devtools-mcp@/);
    for (const denied of ['click', 'press_key', 'type_text', 'evaluate_script', 'handle_dialog', 'take_screenshot']) {
      expect(browserTools(assist.args)).not.toContain(denied);
    }
  });

  it('delivers the fill workflow with real Codex browser names and schemas, keeping submit and tab restrictions', () => {
    const prompt = spec('fill', { assist: true, filesDir }).args.at(-1) as string;
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

  it('passes the rendered-document folder to the adapter without adding a Codex writable root', () => {
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
    expect(policyOf(s.args).uploads).toEqual([`${dir}/resume.pdf`, `${dir}/cover_letter.pdf`]);
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
    expect(policyOf(readOnly.args).uploads).toEqual([]);
  });

  it('drives the adapter, Codex config and prompt from one policy for every browser skill and mode (#161)', () => {
    for (const skill of ['fill', 'connect', 'voice'] as const)
      for (const assist of [false, true])
        for (const dir of [undefined, filesDir]) {
          const s = spec(skill, { assist, filesDir: dir });
          const policy = policyOf(s.args);
          const prompt = s.args.at(-1) as string;
          expect(browserTools(s.args), skill).toEqual(policy.tools);
          const allowed = prompt.split('\n').find((line) => line.startsWith('Browser: Chrome DevTools MCP'));
          expect(allowed, skill).toContain(`Allowed tools: ${policy.tools.map((t) => `mcp__pp_browser__${t}`).join(', ')}.`);
          expect(policy.sites).toEqual(
            skill === 'fill' ? expect.arrayContaining(['lever.co', 'login.microsoftonline.com']) : ['linkedin.com'],
          );
          expect(policy.uploads.length > 0).toBe(skill === 'fill' && assist && Boolean(dir));
        }
    const sites = ['acme.test', 'lever.co'];
    expect(
      policyOf(buildRunnerSpec({ runner: { command: 'codex' }, prompt: 'P', runId: 'rn_1', skill: 'fill', home: '/h', mcp, sites }).args)
        .sites,
    ).toEqual(sites);
  });

  it('withholds uploads after a render failure while preserving filling and an accurate report', () => {
    const uploads = { error: 'synthetic renderer failure' };
    const failed = spec('fill', {
      assist: true,
      prompt: skillPrompt(DEFAULT_SKILLS_DIR, {
        ...context,
        runner: 'codex',
        skill: 'fill',
        assist: true,
        uploads,
      }),
    });
    expect(browserTools(failed.args)).toEqual([...BROWSER_READ_TOOLS, 'fill_form']);
    const prompt = failed.args.at(-1) as string;
    expect(prompt).toContain(uploadsLine(uploads));
    expect(prompt).toContain('fill_form takes elements:');
    expect(prompt).toContain('Uploads are unavailable');
    expect(prompt).toContain('uploaded: []');
    expect(prompt).toContain('report both documents as skipped');
    expectNoUploadInstructions(prompt);
    expect(failed.args.join(' ')).not.toContain('--files-dir');
  });

  it('keeps filling usable when no upload metadata was given, and Claude still renders in the session', () => {
    const prompt = spec('fill', { assist: true }).args.at(-1) as string;
    expect(browserTools(spec('fill', { assist: true }).args)).toEqual([...BROWSER_READ_TOOLS, 'fill_form']);
    expectNoUploadInstructions(prompt);
    expect(prompt).toContain('fill saved answer fields with fill_form');
    expect(prompt).toContain('uploaded: []');
    for (const label of ['Resume', 'Cover letter']) {
      expect(prompt).toContain(`{ label: "${label}", reason: "uploads unavailable: no rendered-files directory was supplied" }`);
    }
    expect(prompt).not.toContain(`${filesDir}/resume.pdf`);
    // Claude reads the PDFs through --add-dir, so its run renders them itself when the engine did not.
    const claude = skillPrompt(DEFAULT_SKILLS_DIR, { ...context, skill: 'fill', assist: true });
    expect(claude).toContain('Uploads: call apply.render_documents');
    expect(claude).toContain('with file_upload');
  });

  it('keeps pasted questions usable and preserves the writing rules', () => {
    const prompt = spec('fill', {
      prompt: skillPrompt(DEFAULT_SKILLS_DIR, { ...context, skill: 'fill', questions: 'applications/r_1/questions.md' }),
    }).args.at(-1) as string;
    expect(prompt).toContain("the user pasted this portal's questions");
    expect(prompt).toContain('do not read the portal for questions');
    expect(prompt).toContain('the only source of facts');
    expect(prompt).toContain('No em dashes');
    const tools = prompt.split('\n').find((line) => line.startsWith('Tools:'));
    expect(tools).not.toContain('mcp__pp_browser__fill_form');
    expect(tools).not.toContain('mcp__pp_browser__upload_file');
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
    const draft = spec('connect', { gmailDraft: true, prompt: gmailDraftPrompt(DEFAULT_SKILLS_DIR, { ...context, runner: 'codex' }) });
    const update = spec('connect', { gmailTo: true, prompt: gmailToPrompt(DEFAULT_SKILLS_DIR, { ...context, runner: 'codex' }) });
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

  it('sweeps every skill and mode for legacy tool names and mismatched upload grants', () => {
    const legacy = /mcp__claude|Claude in Chrome|WebFetch|WebSearch|tabs_context_mcp|form_input|file_upload/;
    for (const assist of [false, true]) {
      for (const linkedin of [false, true]) {
        for (const dir of [undefined, filesDir]) {
          for (const skill of SKILLS) {
            const s = spec(skill, { assist, linkedin, filesDir: dir });
            expect(s.args.at(-1), `${skill}, assist=${assist}, linkedin=${linkedin}, files=${Boolean(dir)}`).not.toMatch(legacy);
            const uploads = skill === 'fill' && assist && Boolean(dir);
            const prompt = s.args.at(-1) as string;
            expect(browserTools(s.args)?.includes('upload_file') ?? false).toBe(uploads);
            // The Tools line lists what the run is granted; the SKILL.md's own Tools list documents the skill's full grant.
            expect(
              prompt
                .split('\n')
                .find((line) => line.startsWith('Tools:'))
                ?.includes('mcp__pp_browser__upload_file'),
            ).toBe(uploads);
            if (uploads) expect(prompt).toContain('Uploads: rendered before launch');
            // The fill assist without uploads never tells the run to upload.
            else if (skill === 'fill' && assist) expectNoUploadInstructions(prompt);
          }
          for (const mode of ['gmailDraft', 'gmailTo'] as const) {
            const prompt = (mode === 'gmailDraft' ? gmailDraftPrompt : gmailToPrompt)(DEFAULT_SKILLS_DIR, { ...context, runner: 'codex' });
            const s = spec('connect', { assist, linkedin, filesDir: dir, [mode]: true, prompt });
            expect(s.args.at(-1), `${mode}, assist=${assist}, linkedin=${linkedin}, files=${Boolean(dir)}`).not.toMatch(legacy);
            expect(browserTools(s.args)).toBeUndefined();
            expectNoUploadInstructions(s.args.at(-1) as string);
          }
        }
      }
    }
  });
});
