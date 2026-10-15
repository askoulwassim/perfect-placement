import { DEFAULT_CONFIG, SKILLS, type Skill } from '@perfect-placement/contracts';
import { describe, expect, it } from 'vitest';
import { BROWSER_READ_TOOLS, buildRunnerSpec, DEFAULT_SKILLS_DIR, gmailDraftPrompt, gmailToPrompt, skillPrompt } from './index.js';

const mcp = { command: '/opt/node/bin/node', args: ['/x/mcp/dist/bin.js'], env: { PP_HOME: '/tmp/pp-home' } };
const context = { runId: 'rn_1', roleId: 'r_1', contactId: 'ct_1', outreachId: 'out_1', runner: 'cursor-agent' as const };
const filesDir = '/tmp/pp-home/files/r_1';

function spec(skill: Skill, opts: { assist?: boolean; linkedin?: boolean; filesDir?: string } = {}) {
  const prompt = skillPrompt(DEFAULT_SKILLS_DIR, {
    ...context,
    skill,
    assist: opts.assist,
    ...(opts.filesDir
      ? {
          uploads: {
            dir: opts.filesDir,
            files: [
              { doc: 'resume' as const, abs_path: `${opts.filesDir}/resume.pdf` },
              { doc: 'cover_letter' as const, abs_path: `${opts.filesDir}/cover_letter.pdf` },
            ],
          },
        }
      : {}),
    linkedin: { ...DEFAULT_CONFIG.linkedin, mode: opts.linkedin === false ? 'off' : 'live', budget_left: 5 },
    voice: { linkedin: opts.linkedin !== false, max_pages: 5 },
  });
  return buildRunnerSpec({ runner: { command: 'cursor-agent' }, prompt, runId: 'rn_1', skill, home: '/tmp/pp-home', mcp, ...opts });
}

const files = (s: ReturnType<typeof spec>) => ({
  servers: JSON.parse(s.files[0]?.content as string).mcpServers as Record<string, { args: string[]; env: Record<string, string> }>,
  permissions: JSON.parse(s.files[1]?.content as string).permissions as { allow: string[]; deny: string[] },
  prompt: s.args[1] as string,
});
const policyOf = (args: string[]) =>
  JSON.parse(args[args.indexOf('--policy') + 1] as string) as { tools: string[]; uploads: string[]; sites: string[] };

describe('Cursor on the PP browser adapter (#161)', () => {
  it('gives browser skills pp_browser with the run policy, and allows exactly its tools', () => {
    for (const skill of SKILLS) {
      const { servers, permissions } = files(spec(skill));
      const browser = ['fill', 'connect', 'voice'].includes(skill);
      expect(Boolean(servers.pp_browser), skill).toBe(browser);
      const allowed = permissions.allow.filter((a) => a.startsWith('Mcp(pp_browser:'));
      expect(allowed, skill).toEqual(browser ? BROWSER_READ_TOOLS.map((t) => `Mcp(pp_browser:${t})`) : []);
      expect(permissions.deny).toEqual(['Shell(*)', 'Write(**)']);
    }
    const assist = files(spec('fill', { assist: true, filesDir }));
    const policy = policyOf(assist.servers.pp_browser?.args ?? []);
    expect(policy.tools).toEqual([...BROWSER_READ_TOOLS, 'fill_form', 'upload_file']);
    expect(policy.uploads).toEqual([`${filesDir}/resume.pdf`, `${filesDir}/cover_letter.pdf`]);
    expect(assist.permissions.allow.filter((a) => a.startsWith('Mcp(pp_browser:'))).toEqual(
      policy.tools.map((t) => `Mcp(pp_browser:${t})`),
    );
    expect(assist.prompt).toContain(`Allowed tools: ${policy.tools.join(', ')}.`);
    expect(assist.prompt).toContain('run pp setup --runner cursor-agent');
    expect(Object.keys(assist.servers.pp_browser?.env ?? {})).toContain('HOME');
    expect(files(spec('connect', { linkedin: false })).servers.pp_browser).toBeUndefined();
    expect(policyOf(files(spec('connect')).servers.pp_browser?.args ?? []).sites).toEqual(['linkedin.com']);
  });

  it('sweeps every skill and mode: no Claude tool or retry rule, and upload instructions only when it may upload', () => {
    const legacy =
      /mcp__claude|Claude in Chrome|tabs_context_mcp|form_input|file_upload|error_code: "connector_unavailable"|engine retries/;
    for (const assist of [false, true])
      for (const linkedin of [false, true])
        for (const dir of [undefined, filesDir])
          for (const skill of SKILLS) {
            const s = spec(skill, { assist, linkedin, filesDir: dir });
            const { prompt, servers } = files(s);
            const where = `${skill}, assist=${assist}, linkedin=${linkedin}, files=${Boolean(dir)}`;
            expect(prompt, where).not.toMatch(legacy);
            const uploads = skill === 'fill' && assist && Boolean(dir);
            const tools = prompt.split('\n').find((line) => line.startsWith('Tools:'));
            expect(tools?.includes('upload_file') ?? false, where).toBe(uploads);
            if (servers.pp_browser) expect(policyOf(servers.pp_browser.args).uploads.length > 0, where).toBe(uploads);
            if (skill === 'fill' && assist && !uploads) expect(prompt, where).not.toMatch(/^3\. Upload:|Upload these absolute paths/m);
          }
    for (const prompt of [gmailDraftPrompt(DEFAULT_SKILLS_DIR, context), gmailToPrompt(DEFAULT_SKILLS_DIR, context)]) {
      expect(prompt).not.toMatch(legacy);
      expect(prompt).toContain('## Cursor tool bindings');
      expect(prompt).toContain('No browser is granted for this run');
    }
  });
});
