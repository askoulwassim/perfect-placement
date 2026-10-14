import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { SKILLS, type Skill } from '@perfect-placement/contracts';
import { FIXTURE_ROLE_IDS } from '@perfect-placement/fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ctxAt, type FixtureEngine, fakeLauncher, okOut, openFixtureEngine } from '../testing/index.js';
import {
  BUILTIN_WRITE_TOOLS,
  buildRunnerSpec,
  CHROME_PREFIX,
  CHROME_READ_TOOLS,
  CHROME_TAB_TOOLS,
  CHROME_WRITE_TOOLS,
  chromeDeniedTools,
  connectDeniedTools,
  cursorPermissions,
  DEFAULT_SKILLS_DIR,
  defaultMcpServer,
  deniedTools,
  deniedToolsError,
  FILL_ASSIST_LINE,
  FILL_ASSIST_TOOLS,
  fillLine,
  GMAIL_DENIED_TOOLS,
  GMAIL_DRAFT_TOOL,
  GMAIL_PREFIX,
  GMAIL_READ_TOOLS,
  GMAIL_WRITE_TOOLS,
  gmailDeniedTools,
  gmailDraftPrompt,
  gmailStepSection,
  MCP_SERVER_NAME,
  resolveRepoRoot,
  SKILL_ASSETS,
  SKILL_TOOLS,
  skillAllowedTools,
  skillPrompt,
  stableNodePath,
  tabsLine,
  uploadsLine,
  usesChrome,
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
    // #50: the MCP server gets the run id, so the ops it runs are linked to the run.
    expect(cfg).toEqual({
      mcpServers: {
        [MCP_SERVER_NAME]: { command: 'node', args: ['/x/mcp/dist/bin.js'], env: { PP_HOME: '/tmp/pp-home', PP_RUN_ID: 'rn_1' } },
      },
    });
    expect(s.args).toEqual(
      expect.arrayContaining(['--strict-mcp-config', '--allowedTools', 'mcp__pp,WebSearch,WebFetch', '--permission-prompts', 'none']),
    );
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
    // connect: pp pre-approved; #37: Gmail search + read (the connector loads, so no strict MCP config);
    // #79: create_draft allowed, every other Gmail write denied; #82: Chrome read + navigate tools allowed.
    expect(connect.args[connect.args.indexOf('--allowedTools') + 1]).toBe(
      ['mcp__pp', ...GMAIL_READ_TOOLS, GMAIL_DRAFT_TOOL, ...CHROME_READ_TOOLS].join(','),
    );
    expect(flag(connect.args, '--permission-mode')).toBe('dontAsk');
    expect(connect.args).not.toContain('--tools');
    expect(connect.args).not.toContain('--strict-mcp-config');
    const denied = (connect.args[connect.args.indexOf('--disallowedTools') + 1] as string).split(',');
    for (const t of [
      'send_message',
      'reply',
      'forward',
      'delete_draft',
      'update_draft',
      'trash_thread',
      'label_message',
      'mark_thread_spam',
    ])
      expect(denied).toContain(`mcp__claude_ai_Gmail__${t}`);
    expect(denied).not.toContain(GMAIL_DRAFT_TOOL);
  });

  it('connect (#82): Claude in Chrome on, read + navigate tools only, every acting Chrome tool and built-in write denied', () => {
    const { args } = spec('claude', 'connect');
    expect(args).toContain('--chrome');
    const allowed = flag(args, '--allowedTools')?.split(',') ?? [];
    const denied = flag(args, '--disallowedTools')?.split(',') ?? [];
    expect(allowed.filter((t) => t.startsWith(CHROME_PREFIX)).sort()).toEqual(
      ['find', 'get_page_text', 'navigate', 'read_page', 'tabs_context_mcp', 'tabs_create_mcp', 'tabs_close_mcp']
        .map((t) => `${CHROME_PREFIX}${t}`)
        .sort(),
    );
    for (const t of ['computer', 'form_input', 'javascript_tool', 'browser_batch', 'file_upload', 'upload_image', 'shortcuts_execute'])
      expect(denied).toContain(`${CHROME_PREFIX}${t}`);
    for (const t of BUILTIN_WRITE_TOOLS) expect(denied).toContain(t);
    expect(denied).toEqual(connectDeniedTools());
    for (const t of allowed) expect(denied).not.toContain(t);
    for (const t of [...CHROME_WRITE_TOOLS, ...BUILTIN_WRITE_TOOLS]) expect(allowed).not.toContain(t);

    // config.linkedin.mode not live: no Chrome at all, the acting tools still denied.
    const off = buildRunnerSpec({
      runner: { command: 'claude' },
      prompt: 'P',
      runId: 'rn_1',
      skill: 'connect',
      home: '/h',
      mcp,
      linkedin: false,
    });
    expect(off.args).not.toContain('--chrome');
    expect(flag(off.args, '--allowedTools')).toBe(['mcp__pp', ...GMAIL_READ_TOOLS, GMAIL_DRAFT_TOOL].join(','));
    expect(flag(off.args, '--disallowedTools')).toBe(connectDeniedTools().join(','));
    // No other skill but fill (#81) and voice (#76, LinkedIn posts) gets Chrome.
    for (const skill of SKILLS.filter((x) => x !== 'connect' && x !== 'fill' && x !== 'voice')) {
      expect(spec('claude', skill).args).not.toContain('--chrome');
      expect(skillAllowedTools(skill).some((t) => t.startsWith(CHROME_PREFIX))).toBe(false);
    }
  });

  it('voice (#76): sent Gmail read-only, LinkedIn posts via Chrome only when live; every Gmail write and acting tool denied', () => {
    const on = spec('claude', 'voice');
    expect(on.args).toContain('--chrome');
    expect(flag(on.args, '--allowedTools')?.split(',')).toEqual(['mcp__pp', ...GMAIL_READ_TOOLS, ...CHROME_READ_TOOLS]);
    expect(flag(on.args, '--tools')).toBe('');
    expect(on.args).not.toContain('--strict-mcp-config');
    expect(flag(on.args, '--permission-mode')).toBe('dontAsk');
    const denied = flag(on.args, '--disallowedTools')?.split(',') ?? [];
    for (const t of [...GMAIL_WRITE_TOOLS, ...BUILTIN_WRITE_TOOLS, `${CHROME_PREFIX}computer`, `${CHROME_PREFIX}form_input`])
      expect(denied).toContain(t);
    expect(denied).not.toContain(GMAIL_READ_TOOLS[0]);
    const off = buildRunnerSpec({
      runner: { command: 'claude' },
      prompt: 'P',
      runId: 'rn_1',
      skill: 'voice',
      home: '/h',
      mcp,
      linkedin: false,
    });
    expect(off.args).not.toContain('--chrome');
    expect(flag(off.args, '--allowedTools')).toBe(['mcp__pp', ...GMAIL_READ_TOOLS].join(','));
    expect(flag(off.args, '--disallowedTools')?.split(',')).toEqual(GMAIL_WRITE_TOOLS);
    expect(usesChrome('voice', false)).toBe(false);
    // The prompt states the sources and caps; LinkedIn off drops the Chrome tools from the Tools line.
    const p = skillPrompt(DEFAULT_SKILLS_DIR, { runId: 'rn_9', skill: 'voice', voice: { linkedin: true, max_pages: 5 } });
    expect(p).toContain('only messages the user sent');
    expect(p).toContain('at most 10 posts and 5 pages');
    expect(p).toContain('never apply the diff');
    const pOff = skillPrompt(DEFAULT_SKILLS_DIR, { runId: 'rn_9', skill: 'voice', voice: { linkedin: false, max_pages: 5 } });
    expect(pOff).toContain(`Tools: the pp MCP tools and ${GMAIL_READ_TOOLS.join(', ')}, nothing else.`);
    expect(pOff).toContain('LinkedIn: off for this run');
  });

  it('fill (#81): Claude in Chrome on, read + navigate tools only; form_input, typing, uploads, script and submit denied', () => {
    const { args } = spec('claude', 'fill');
    expect(args).toContain('--chrome');
    const allowed = flag(args, '--allowedTools')?.split(',') ?? [];
    const denied = flag(args, '--disallowedTools')?.split(',') ?? [];
    expect(allowed).toEqual(['mcp__pp', 'WebFetch', ...CHROME_READ_TOOLS]);
    // Built-ins narrowed to WebFetch; dontAsk denies anything not pre-approved.
    expect(flag(args, '--tools')).toBe('WebFetch');
    expect(flag(args, '--permission-mode')).toBe('dontAsk');
    // No click tool exists that cannot also type: `computer` is denied with every other acting tool.
    for (const t of ['form_input', 'computer', 'javascript_tool', 'file_upload', 'upload_image', 'browser_batch', 'shortcuts_execute'])
      expect(denied).toContain(`${CHROME_PREFIX}${t}`);
    for (const t of [...BUILTIN_WRITE_TOOLS, ...GMAIL_WRITE_TOOLS]) expect(denied).toContain(t);
    expect(denied).toEqual(chromeDeniedTools('fill'));
    for (const t of allowed) expect(denied).not.toContain(t);
    // config.linkedin never turns the portal read off.
    const li = buildRunnerSpec({
      runner: { command: 'claude' },
      prompt: 'P',
      runId: 'rn_1',
      skill: 'fill',
      home: '/h',
      mcp,
      linkedin: false,
    });
    expect(li.args).toContain('--chrome');
    expect(usesChrome('fill', false)).toBe(true);
    expect(usesChrome('connect', false)).toBe(false);
    // Codex and Cursor have no Chrome: WebFetch only.
    expect(cursorPermissions('fill').allow).toEqual(['Mcp(pp:*)', 'WebFetch(*)']);
  });

  it('fill with assist (#106): form_input + file_upload allowed; no click, key, script or batch tool', () => {
    const { args } = buildRunnerSpec({
      runner: { command: 'claude' },
      prompt: 'P',
      runId: 'rn_1',
      skill: 'fill',
      home: '/h',
      mcp,
      assist: true,
    });
    expect(args).toContain('--chrome');
    const allowed = flag(args, '--allowedTools')?.split(',') ?? [];
    const denied = flag(args, '--disallowedTools')?.split(',') ?? [];
    expect(allowed).toEqual(['mcp__pp', 'WebFetch', ...CHROME_READ_TOOLS, `${CHROME_PREFIX}form_input`, `${CHROME_PREFIX}file_upload`]);
    for (const t of FILL_ASSIST_TOOLS) expect(denied).not.toContain(t);
    // Nothing that can press Submit: clicks, keys (computer, shortcuts), script, batches, image uploads stay denied.
    for (const t of ['computer', 'javascript_tool', 'browser_batch', 'shortcuts_execute', 'upload_image', 'gif_creator'])
      expect(denied).toContain(`${CHROME_PREFIX}${t}`);
    for (const t of [...BUILTIN_WRITE_TOOLS, ...GMAIL_WRITE_TOOLS]) expect(denied).toContain(t);
    expect(denied).toEqual(chromeDeniedTools('fill', { assist: true }));
    expect(flag(args, '--permission-mode')).toBe('dontAsk');
    // Only fill can ever get them.
    for (const skill of SKILLS.filter((x) => x !== 'fill'))
      for (const t of FILL_ASSIST_TOOLS) {
        expect(skillAllowedTools(skill)).not.toContain(t);
        expect(flag(spec('claude', skill).args, '--allowedTools')?.split(',') ?? []).not.toContain(t);
      }
  });

  it('fill prompt with assist (#106): read, then upload and fill, stop before Submit, report with apply.fill_done', () => {
    const p = skillPrompt(DEFAULT_SKILLS_DIR, { runId: 'rn_9', skill: 'fill', roleId: 'r_1', assist: true });
    expect(p).toContain(fillLine(undefined, true));
    expect(p).toContain(FILL_ASSIST_LINE);
    expect(p).toContain('apply.render_documents');
    expect(p).toContain('apply.fill_done { role_id, filled, uploaded, skipped }');
    expect(p).toContain('never touch a Submit, Apply or Send control');
    expect(p).toContain(`Tools: the pp MCP tools and WebFetch, ${[...CHROME_READ_TOOLS, ...FILL_ASSIST_TOOLS].join(', ')}, nothing else.`);
    // Pasted questions + assist: answer those, then fill the portal.
    const pasted = fillLine('applications/r_1/questions.md', true);
    expect(pasted).toContain('do not read the portal for questions');
    expect(pasted).toContain(FILL_ASSIST_LINE);
    expect(fillLine()).not.toContain(FILL_ASSIST_LINE);
  });

  it("fill with assist (#123): --add-dir for that role's rendered-files folder only; nothing for other runs", () => {
    const dir = '/h/files/linear_product-lead-insights';
    const build = (skill: Skill, o: { assist?: boolean; runner?: 'claude' | 'codex' | 'cursor-agent' } = {}) =>
      buildRunnerSpec({
        runner: { command: o.runner ?? 'claude' },
        prompt: 'P',
        runId: 'rn_1',
        skill,
        home: '/h',
        mcp,
        ...(o.assist ? { assist: true } : {}),
        filesDir: dir,
      }).args;
    const args = build('fill', { assist: true });
    expect(args.filter((a) => a === '--add-dir')).toHaveLength(1);
    expect(flag(args, '--add-dir')).toBe(dir);
    // Nothing broader: not PP_HOME, not files/.
    for (const broad of ['/h', '/h/', '/h/files', '/h/files/']) expect(args).not.toContain(broad);
    // The next token is a flag, so the variadic --add-dir takes exactly one directory.
    expect(args[args.indexOf('--add-dir') + 2]?.startsWith('--')).toBe(true);
    // Fill without assist, every other skill, the Gmail steps, Codex and Cursor: no --add-dir.
    expect(build('fill')).not.toContain('--add-dir');
    for (const skill of SKILLS.filter((x) => x !== 'fill')) expect(build(skill, { assist: true })).not.toContain('--add-dir');
    expect(build('fill', { assist: true, runner: 'codex' })).not.toContain(dir);
    expect(build('fill', { assist: true, runner: 'cursor-agent' })).not.toContain(dir);
    expect(
      buildRunnerSpec({ runner: { command: 'claude' }, prompt: 'P', runId: 'rn_1', skill: 'fill', home: '/h', mcp, assist: true }).args,
    ).not.toContain('--add-dir');
    expect(() =>
      buildRunnerSpec({
        runner: { command: 'claude' },
        prompt: 'P',
        runId: 'rn_1',
        skill: 'fill',
        home: '/h',
        mcp,
        assist: true,
        filesDir: 'files/x',
      }),
    ).toThrow(/absolute/);
  });

  it('fill assist prompt (#123): uploads by absolute path, or skipped with the render error', () => {
    const uploads = {
      dir: '/h/files/r_1',
      files: [
        { doc: 'resume' as const, abs_path: '/h/files/r_1/resume.pdf' },
        { doc: 'cover_letter' as const, abs_path: '/h/files/r_1/cover_letter.pdf' },
      ],
    };
    const p = skillPrompt(DEFAULT_SKILLS_DIR, { runId: 'rn_9', skill: 'fill', roleId: 'r_1', assist: true, uploads });
    expect(p).toContain(uploadsLine(uploads));
    expect(uploadsLine(uploads)).toContain('resume: /h/files/r_1/resume.pdf, cover_letter: /h/files/r_1/cover_letter.pdf');
    expect(FILL_ASSIST_LINE).toContain('absolute path');
    // The skill (inlined in the prompt) uploads by absolute path too, never a vault-relative one.
    expect(p).toContain('`paths: ["<absolute path>"]`');
    expect(p).toContain('never a vault-relative `files/...` path');
    expect(FILL_ASSIST_LINE).not.toMatch(/using each file's abs_path/);
    const failed = uploadsLine({ error: 'no tailored resume yet' });
    expect(failed).toContain('Upload nothing');
    expect(failed).toContain('uploaded: []');
    expect(failed).toContain('reason: "render failed: no tailored resume yet"');
    // No uploads on file (a prompt built outside the queue): render, then upload the absolute abs_path.
    expect(uploadsLine()).toContain('abs_path (absolute)');
    // Without assist there is no Uploads line.
    expect(skillPrompt(DEFAULT_SKILLS_DIR, { runId: 'rn_9', skill: 'fill', roleId: 'r_1', uploads })).not.toContain('Uploads:');
  });

  it('fill prompt (#81): read the portal read-only, or answer the pasted questions', () => {
    const p = skillPrompt(DEFAULT_SKILLS_DIR, { runId: 'rn_9', skill: 'fill', roleId: 'r_1' });
    expect(p).toContain(fillLine());
    expect(p).toContain('Never click, type, fill a field, upload or submit.');
    expect(p).toContain('portal questions unreadable');
    expect(p).toContain(`Tools: the pp MCP tools and WebFetch, ${CHROME_READ_TOOLS.join(', ')}, nothing else.`);
    const pasted = skillPrompt(DEFAULT_SKILLS_DIR, {
      runId: 'rn_9',
      skill: 'fill',
      roleId: 'r_1',
      questions: 'applications/r_1/questions.md',
    });
    expect(pasted).toContain('vault.read { path: "applications/r_1/questions.md" }');
    expect(pasted).toContain('do not read the portal for questions');
    expect(pasted).not.toContain(fillLine());
    // Only fill gets the portal line.
    expect(skillPrompt(DEFAULT_SKILLS_DIR, { runId: 'rn_9', skill: 'tailor', roleId: 'r_1' })).not.toContain('Portal (read-only');
  });

  it('connect prompt (#82): states the LinkedIn caps and budget, or that LinkedIn is off', () => {
    const li = {
      mode: 'live' as const,
      driver: 'claude-in-chrome' as const,
      max_profiles_per_day: 40,
      max_pages_per_run: 6,
      max_mutual_expansions: 3,
      min_delay_s: 20,
      budget_left: 12,
    };
    const p = skillPrompt(DEFAULT_SKILLS_DIR, { runId: 'rn_9', skill: 'connect', roleId: 'r_1', linkedin: li });
    expect(p).toContain('at most 6 pages this run, 12 profiles left today (of 40), at most 3 mutual lists, wait 20 to 40 s');
    expect(p).toContain(CHROME_READ_TOOLS.join(', '));
    const off = skillPrompt(DEFAULT_SKILLS_DIR, { runId: 'rn_9', skill: 'connect', roleId: 'r_1', linkedin: { ...li, mode: 'off' } });
    expect(off).toContain('LinkedIn: off for this run');
    // The Tools line drops the Chrome tools (the SKILL.md below still documents them).
    expect(off).toContain(`Tools: the pp MCP tools and ${[...GMAIL_READ_TOOLS, GMAIL_DRAFT_TOOL].join(', ')}, nothing else.`);
  });

  it('codex: exec outside a git repo, pp tools pre-approved, no approval prompts', () => {
    const s = buildRunnerSpec({ runner: { command: 'codex' }, prompt: 'P', runId: 'rn_1', skill: 'tailor', home: '/h', mcp });
    expect(s.args[0]).toBe('exec');
    expect(s.args).toEqual(
      expect.arrayContaining([
        '--skip-git-repo-check',
        'mcp_servers.pp.command="node"',
        'mcp_servers.pp.args=["/x/mcp/dist/bin.js"]',
        'mcp_servers.pp.env.PP_HOME="/tmp/pp-home"',
        'mcp_servers.pp.env.PP_RUN_ID="rn_1"',
        'mcp_servers.pp.default_tools_approval_mode="approve"',
        'approval_policy="never"',
        'web_search="live"',
      ]),
    );
    expect(s.args.at(-1)).toContain('\n\nP');
  });

  it('codex scopes its approval default to pp and permits a stricter runner override', () => {
    const override = 'mcp_servers.pp.default_tools_approval_mode="prompt"';
    const s = buildRunnerSpec({
      runner: { command: 'codex', args: ['-c', override] },
      prompt: 'P',
      runId: 'rn_1',
      skill: 'score',
      home: '/h',
      mcp,
    });
    expect(s.args.filter((arg) => arg.includes('approval_mode='))).toEqual([
      'mcp_servers.pp.default_tools_approval_mode="approve"',
      override,
    ]);
    // Do not replace the user's per-tool overrides with a broad tools table.
    expect(s.args.some((arg) => arg.startsWith('mcp_servers.pp.tools'))).toBe(false);
    expect(s.args).toContain('approval_policy="never"');
    expect(s.files).toEqual([]);
  });

  it('codex maps the score skill web fetch to page retrieval without granting search queries', () => {
    const prompt = skillPrompt(DEFAULT_SKILLS_DIR, { runId: 'rn_1', skill: 'score' });
    const s = buildRunnerSpec({ runner: { command: 'codex' }, prompt, runId: 'rn_1', skill: 'score', home: '/h', mcp });
    const delivered = s.args.at(-1);
    expect(delivered).toContain('Tools: the pp MCP tools and web.run open, nothing else.');
    expect(delivered).toContain('`web.run open`: capture the full JD');
    expect(delivered).toContain('Its open action fetches a URL');
    expect(delivered).toContain('do not run web search queries');
    expect(delivered).toContain('If the built-in web tool is actually unavailable or a call is denied');
    expect(delivered).toContain('do not work around it');
    expect(delivered).toContain('never edit files or the database directly');
    expect(delivered).not.toMatch(/\bWebFetch\b|\bWebSearch\b/);
    expect(s.args).toContain('web_search="live"');
    expect(buildRunnerSpec({ runner: { command: 'claude' }, prompt, runId: 'rn_1', skill: 'score', home: '/h', mcp }).args[1]).toBe(prompt);
  });

  it('codex maps scout search and fetch in the skill and companion plan, but keeps ops-only skills unchanged', () => {
    const prompt = skillPrompt(DEFAULT_SKILLS_DIR, { runId: 'rn_1', skill: 'scout' });
    const s = buildRunnerSpec({ runner: { command: 'codex' }, prompt, runId: 'rn_1', skill: 'scout', home: '/h', mcp });
    expect(s.args.at(-1)).toContain('Tools: the pp MCP tools and web.run search, web.run open, nothing else.');
    expect(s.args.at(-1)).toContain('Web search queries and page retrieval are allowed');
    expect(s.args.at(-1)).toContain('# Scout plan');
    expect(s.args.at(-1)).not.toMatch(/\bWebFetch\b|\bWebSearch\b/);
    const learn = skillPrompt(DEFAULT_SKILLS_DIR, { runId: 'rn_2', skill: 'learn' });
    const opsOnly = buildRunnerSpec({ runner: { command: 'codex' }, prompt: learn, runId: 'rn_2', skill: 'learn', home: '/h', mcp });
    expect(opsOnly.args.at(-1)).toBe(learn);
    expect(opsOnly.args).toContain('web_search="disabled"');
  });

  it('cursor-agent: print mode, MCP config in a temp project dir, approvals off', () => {
    const s = buildRunnerSpec({ runner: { command: 'cursor-agent' }, prompt: 'P', runId: 'rn_1', skill: 'fill', home: '/h', mcp });
    expect(s.args).toEqual(['-p', 'P', '--output-format', 'text', '--trust', '--approve-mcps', '--force']);
    expect(s.cwd).toBeNull();
    expect(s.files[0]?.path).toBe('.cursor/mcp.json');
    expect(JSON.parse(s.files[0]?.content as string).mcpServers.pp).toMatchObject({ command: 'node', env: { PP_RUN_ID: 'rn_1' } });
    expect(s.files[1]?.path).toBe('.cursor/cli.json');
    expect(JSON.parse(s.files[1]?.content as string).permissions).toEqual({
      allow: ['Mcp(pp:*)', 'WebFetch(*)'],
      deny: ['Shell(*)', 'Write(**)'],
    });
  });

  it('the prompt is the skill file plus the run ids', () => {
    const p = skillPrompt(DEFAULT_SKILLS_DIR, { runId: 'rn_9', skill: 'research', roleId: 'acme_pm' });
    expect(p).toContain('run_id: rn_9');
    expect(p).toContain('role_id: acme_pm');
    expect(p).toContain('# Research');
    expect(p).toContain('runs.finish');
    expect(defaultMcpServer('/h').env).toEqual({ PP_HOME: '/h' });
  });

  it('the runner MCP server uses a stable node path, never a versioned Homebrew one (#33)', () => {
    const cellar = '/opt/homebrew/Cellar/node@22/22.23.3_1/bin/node';
    const opt = '/opt/homebrew/opt/node@22/bin/node';
    const node = stableNodePath({}, cellar, (p) => p === opt);
    expect(node).toBe(opt);
    expect(stableNodePath({ PP_NODE: '/l/node' }, cellar, () => true)).toBe('/l/node');
    expect(stableNodePath({ PP_NODE: '/gone' }, cellar, (p) => p === opt)).toBe(opt);
    const s = buildRunnerSpec({
      runner: { command: 'claude' },
      prompt: 'P',
      runId: 'rn_1',
      skill: 'scout',
      home: '/h',
      mcp: defaultMcpServer('/h', node),
    });
    expect(s.args.join(' ')).not.toContain('/Cellar/');
    expect(defaultMcpServer('/h').command).toBe(stableNodePath());
  });
});

const spec = (runner: 'claude' | 'codex' | 'cursor-agent', skill: Skill) =>
  buildRunnerSpec({ runner: { command: runner }, prompt: 'P', runId: 'rn_1', skill, home: '/h', mcp });
const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

describe('per-skill tools (#20)', () => {
  const WEB: Skill[] = ['scout', 'research', 'freshness'];
  const FETCH: Skill[] = ['tailor', 'score'];
  const PP_ONLY: Skill[] = ['learn', 'onboard'];

  it('the allowlist covers every skill: web search + fetch for scout/research/freshness, fetch for JD/portal reads, pp only otherwise', () => {
    expect(Object.keys(SKILL_TOOLS).sort()).toEqual([...SKILLS].sort());
    for (const s of WEB) expect(skillAllowedTools(s)).toEqual(['mcp__pp', 'WebSearch', 'WebFetch']);
    for (const s of FETCH) expect(skillAllowedTools(s)).toEqual(['mcp__pp', 'WebFetch']);
    for (const s of PP_ONLY) expect(skillAllowedTools(s)).toEqual(['mcp__pp']);
    // #106: fill's full list includes the fill assist's form_input + file_upload; a run without assist drops them.
    expect(skillAllowedTools('fill')).toEqual(['mcp__pp', 'WebFetch', ...CHROME_READ_TOOLS, ...FILL_ASSIST_TOOLS]);
    expect(skillAllowedTools('fill', { assist: false })).toEqual(['mcp__pp', 'WebFetch', ...CHROME_READ_TOOLS]);
    expect(skillAllowedTools('inbox')).toEqual(['mcp__pp', ...GMAIL_READ_TOOLS]);
    expect(skillAllowedTools('connect')).toEqual(['mcp__pp', ...GMAIL_READ_TOOLS, GMAIL_DRAFT_TOOL, ...CHROME_READ_TOOLS]);
  });

  it('claude: each skill pre-approves exactly its tools, narrows built-ins to them, denies the rest (dontAsk)', () => {
    for (const skill of SKILLS) {
      if (skill === 'connect') continue;
      const { args } = spec('claude', skill);
      // #106: a fill run without assist (the default) gets fill's list minus the fill assist tools.
      expect(flag(args, '--allowedTools')).toBe(skillAllowedTools(skill, skill === 'fill' ? { assist: false } : {}).join(','));
      expect(flag(args, '--tools')).toBe(SKILL_TOOLS[skill].web.join(','));
      expect(flag(args, '--permission-mode')).toBe('dontAsk');
      expect(flag(args, '--permission-prompts')).toBe('none');
      // A skill with Gmail tools (inbox) loads the claude.ai connector: no strict MCP config, Gmail writes denied.
      // A Chrome skill (fill, #81) loads Claude in Chrome: no strict MCP config, acting tools and writes denied.
      const gmail = SKILL_TOOLS[skill].gmail.length > 0;
      const chrome = usesChrome(skill);
      expect(args.includes('--strict-mcp-config')).toBe(!gmail && !chrome);
      expect(flag(args, '--disallowedTools')).toBe(
        chrome ? chromeDeniedTools(skill).join(',') : gmail ? gmailDeniedTools(skill).join(',') : undefined,
      );
      for (const broad of ['Bash', 'Write', 'Edit', 'Read']) {
        expect(flag(args, '--allowedTools')?.split(',')).not.toContain(broad);
        expect(flag(args, '--tools')?.split(',')).not.toContain(broad);
      }
    }
    expect(flag(spec('claude', 'scout').args, '--allowedTools')).toBe('mcp__pp,WebSearch,WebFetch');
    expect(flag(spec('claude', 'inbox').args, '--tools')).toBe('');
  });

  it('inbox (#80): Gmail search + read pre-approved, the connector loads, every Gmail write denied', () => {
    const { args } = spec('claude', 'inbox');
    expect(flag(args, '--allowedTools')).toBe(['mcp__pp', ...GMAIL_READ_TOOLS].join(','));
    expect(args).not.toContain('--strict-mcp-config');
    expect(flag(args, '--permission-mode')).toBe('dontAsk');
    expect(flag(args, '--disallowedTools')?.split(',')).toEqual(GMAIL_WRITE_TOOLS);
    for (const t of [
      'send_message',
      'reply',
      'forward',
      'create_draft',
      'update_draft',
      'delete_draft',
      'trash_message',
      'mark_message_spam',
      'label_thread',
      'update_message_labels',
    ])
      expect(GMAIL_WRITE_TOOLS).toContain(`${GMAIL_PREFIX}${t}`);
  });

  it('codex: live web search for web skills, disabled otherwise; cursor: WebFetch only for web skills, never shell or writes', () => {
    for (const skill of SKILLS) {
      const web = SKILL_TOOLS[skill].web.length > 0;
      expect(spec('codex', skill).args).toContain(web ? 'web_search="live"' : 'web_search="disabled"');
      const perms = JSON.parse(spec('cursor-agent', skill).files[1]?.content as string).permissions;
      expect(perms).toEqual(cursorPermissions(skill));
      expect(perms.allow.includes('WebFetch(*)')).toBe(web);
      expect(perms.deny).toEqual(['Shell(*)', 'Write(**)']);
    }
  });
});

/** The tools a SKILL.md's `## Tools` section declares (`- \`tool\`: why` bullets). */
function declaredTools(skillMd: string): string[] | null {
  const m = /^## Tools\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(skillMd);
  return m ? [...(m[1] as string).matchAll(/^- `([^`]+)`/gm)].map((x) => x[1] as string) : null;
}

describe('SKILL.md tools vs the allowlist (#79, #80)', () => {
  const read = (skill: Skill) => readFileSync(join(DEFAULT_SKILLS_DIR, skill, 'SKILL.md'), 'utf8');
  // The claude.ai Gmail connector's tools, read and write: a SKILL.md naming one by its short name counts too.
  const GMAIL_SHORT = new Set(
    [...GMAIL_WRITE_TOOLS, ...GMAIL_READ_TOOLS, `${GMAIL_PREFIX}get_draft`, `${GMAIL_PREFIX}list_drafts`, `${GMAIL_PREFIX}list_labels`].map(
      (t) => t.slice(GMAIL_PREFIX.length),
    ),
  );
  /** Read-only skills (voice too, #76): never granted a Gmail write (or any built-in write). */
  const READ_ONLY: Skill[] = SKILLS.filter((s) => s !== 'connect');

  it('every SKILL.md declares exactly its allowlist in a ## Tools section', () => {
    for (const skill of SKILLS) {
      const declared = declaredTools(read(skill));
      expect(declared, `${skill}: SKILL.md has no ## Tools section`).not.toBeNull();
      expect(declared, `${skill}: SKILL.md ## Tools vs SKILL_TOOLS`).toEqual(skillAllowedTools(skill));
    }
  });

  it('every tool a SKILL.md tells the agent to call is granted to its skill', () => {
    for (const skill of SKILLS) {
      const md = read(skill);
      const allowed = new Set(skillAllowedTools(skill));
      // Full MCP tool names anywhere (mcp__pp__<op> is covered by mcp__pp).
      for (const [name] of md.matchAll(/\bmcp__[A-Za-z0-9_-]+/g))
        if (!name.startsWith(`mcp__${MCP_SERVER_NAME}`)) expect(allowed, `${skill}: ${name}`).toContain(name);
      // Gmail connector short names in backticks, and made-up Gmail tool names (gmail_search_messages, #80).
      for (const [, name] of md.matchAll(/`([a-z_]+)`/g)) {
        if (GMAIL_SHORT.has(name as string)) expect(allowed, `${skill}: \`${name}\``).toContain(`${GMAIL_PREFIX}${name}`);
        expect(name, `${skill}: not a real Gmail tool`).not.toMatch(/^gmail_(search|read|get|list|send|create)/);
      }
    }
  });

  it('read-only skills are granted no write tool; connect gets create_draft and no other Gmail write', () => {
    const writes = new Set(GMAIL_WRITE_TOOLS);
    for (const skill of READ_ONLY) {
      for (const t of skillAllowedTools(skill)) {
        expect(writes.has(t), `${skill}: ${t}`).toBe(false);
        expect(['Bash', 'Write', 'Edit', 'NotebookEdit']).not.toContain(t);
      }
      if (SKILL_TOOLS[skill].gmail.length) {
        const denied = flag(spec('claude', skill).args, '--disallowedTools')?.split(',') ?? [];
        for (const t of GMAIL_WRITE_TOOLS) expect(denied, `${skill}: ${t} not denied`).toContain(t);
      }
    }
    expect(skillAllowedTools('connect').filter((t) => writes.has(t))).toEqual([GMAIL_DRAFT_TOOL]);
    expect(GMAIL_DENIED_TOOLS).toEqual(gmailDeniedTools('connect'));
  });

  it('the inbox prompt names its Gmail tools', () => {
    const p = skillPrompt(DEFAULT_SKILLS_DIR, { runId: 'rn_9', skill: 'inbox' });
    expect(p).toContain(`Tools: the pp MCP tools and ${GMAIL_READ_TOOLS.join(', ')}, nothing else.`);
  });
});

describe('skill assets in the prompt (#20)', () => {
  it('scout: the prompt inlines SKILL.md and plan.md read from the repo, and names its web tools', () => {
    const p = skillPrompt(DEFAULT_SKILLS_DIR, { runId: 'rn_9', skill: 'scout' });
    const skillMd = readFileSync(join(DEFAULT_SKILLS_DIR, 'scout', 'SKILL.md'), 'utf8').trim();
    const plan = readFileSync(join(DEFAULT_SKILLS_DIR, 'scout', 'plan.md'), 'utf8').trim();
    expect(p).toContain(skillMd);
    expect(p).toContain(plan);
    expect(p).toContain(join(DEFAULT_SKILLS_DIR, 'scout', 'plan.md'));
    expect(p).toContain('WebSearch, WebFetch');
    expect(p).toContain('never look for them with vault.read');
    expect(p).toMatch(/tool denied: <tool>/);
    expect(p).not.toContain('(not found at');
  });

  it('every skill prompt has its SKILL.md and listed assets (none missing)', () => {
    for (const skill of SKILLS) {
      const p = skillPrompt(DEFAULT_SKILLS_DIR, { runId: 'rn_1', skill });
      expect(p).not.toContain('not found at');
      for (const a of SKILL_ASSETS[skill] ?? []) expect(existsSync(join(DEFAULT_SKILLS_DIR, skill, a))).toBe(true);
    }
  });

  it('the repo root resolves from the source and the dist location of the engine', () => {
    const root = resolveRepoRoot();
    expect(existsSync(join(root, 'skills', 'scout', 'plan.md'))).toBe(true);
    expect(DEFAULT_SKILLS_DIR).toBe(join(root, 'skills'));
    expect(resolveRepoRoot(join(root, 'packages', 'engine', 'dist', 'ops'))).toBe(root);
    expect(resolveRepoRoot(join(root, 'packages', 'engine', 'ops'))).toBe(root);
  });

  it('no skill reads repo files through vault.read; every companion file is inlined or a human runbook', () => {
    for (const skill of readdirSync(DEFAULT_SKILLS_DIR)) {
      const files = readdirSync(join(DEFAULT_SKILLS_DIR, skill));
      for (const f of files) {
        const text = readFileSync(join(DEFAULT_SKILLS_DIR, skill, f), 'utf8');
        for (const line of text.split('\n').filter((l) => /vault[._]read/.test(l)))
          expect(line, `${skill}/${f}`).toMatch(/never look for|never in the vault|not in the vault|kept resume/i);
      }
      const companions = files.filter((f) => f !== 'SKILL.md' && f !== 'RUNBOOK.md');
      expect(companions, skill).toEqual([...(SKILL_ASSETS[skill as Skill] ?? [])]);
    }
  });
});

describe('fail loudly when a tool is denied (#20)', () => {
  const denialJson = JSON.stringify({
    type: 'result',
    subtype: 'success',
    permission_denials: [{ tool_name: 'WebSearch', tool_use_id: 't1', tool_input: { query: 'x' } }],
  });

  it('parses Claude Code permission_denials and names the tool and the fix', () => {
    expect(deniedTools(`noise\n${denialJson}\n`)).toEqual(['WebSearch']);
    expect(deniedTools('{"permission_denials":[]}')).toEqual([]);
    const granted = deniedToolsError('scout', ['WebSearch']);
    expect(granted).toContain('tool denied: WebSearch');
    expect(granted).toContain('permissions.deny');
    const notGranted = deniedToolsError('inbox', ['WebSearch']);
    expect(notGranted).toContain('SKILL_TOOLS');
    expect(notGranted).toContain('config.runner.args');
  });

  it('a runner that exits with the run still open finishes it as error with the denied tool in summary_json.error', async () => {
    const launcher = fakeLauncher(undefined, { result: { code: 0, output: denialJson, logFile: '/tmp/pp-runs/x.log' } });
    e = openFixtureEngine({ services: { launcher } });
    const run = okOut(await e.runOp('runs.start', { skill: 'scout' }, ctxAt('human'))).run;
    await Promise.all(launcher.exited);
    await vi.waitFor(async () => {
      const row = okOut(await e.runOp('runs.get', { run_id: run.id }, ctxAt('human')));
      expect(row.run.status).toBe('error');
    });
    const row = okOut(await e.runOp('runs.get', { run_id: run.id }, ctxAt('human')));
    expect(row.run.summary_json).toMatchObject({ denied_tools: ['WebSearch'], runner_log: '/tmp/pp-runs/x.log' });
    expect(String(row.run.summary_json.error)).toMatch(/^tool denied: WebSearch .*Fix:/);
    expect(row.log_md).toContain('tool denied: WebSearch');
  });

  it('a run the agent already finished is left alone; a silent exit still fails an open run', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const launcher = fakeLauncher(undefined, { result: { code: 0, output: '{}' }, exitAfter: gate });
    e = openFixtureEngine({ services: { launcher } });
    const done = okOut(await e.runOp('runs.start', { skill: 'scout' }, ctxAt('human'))).run;
    okOut(await e.runOp('runs.finish', { run_id: done.id, status: 'ok', summary: { added: 2 } }, ctxAt('agent')));
    const open = okOut(await e.runOp('runs.start', { skill: 'inbox' }, ctxAt('human'))).run;
    release();
    await Promise.all(launcher.exited);
    await vi.waitFor(async () => {
      expect(okOut(await e.runOp('runs.get', { run_id: open.id }, ctxAt('human'))).run.status).toBe('error');
    });
    expect(okOut(await e.runOp('runs.get', { run_id: done.id }, ctxAt('human'))).run).toMatchObject({ status: 'ok' });
    const failed = okOut(await e.runOp('runs.get', { run_id: open.id }, ctxAt('human'))).run;
    expect(failed.summary_json.error).toBe('runner claude exited (code 0) without calling runs.finish');
  });
});

describe('runs.start', () => {
  it('commits the run, then launches the configured runner once', async () => {
    e = openFixtureEngine({ config: { runner: { command: 'codex' } } });
    const run = okOut(await e.runOp('runs.start', { skill: 'tailor', role_id: 'linear_product-lead-insights' }, ctxAt('human'))).run;
    // Queued in the transaction, launched by the dispatcher after commit (#30).
    expect(run.status).toBe('queued');
    expect(okOut(await e.runOp('runs.get', { run_id: run.id }, ctxAt('human'))).run.status).toBe('running');
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
    // #37: To comes from outreach.get's `to`, never the unconfirmed guess.
    expect(p).toContain('`to.email`');
    expect(p).toContain('never use `to.guess`');
    // #132: no address at all: create nothing (never a Gmail draft without To).
    expect(p).toContain('skipped: "no email"');
    expect(gmailStepSection('# x\n\n## Gmail draft step\n\nA\n\n## Never\n\nB')).toBe('## Gmail draft step\n\nA');
  });

  it('runs.start { skill: connect, outreach_id } launches the Gmail run with role + contact from the outreach (fake launcher)', async () => {
    e = openFixtureEngine();
    e.db
      .prepare("UPDATE contact SET email = 'maya@linear.example', email_source = 'gmail', email_confidence = 1 WHERE id = 'ct_0001'")
      .run();
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

  it('runs.start { skill: connect, role_id } (#82): Chrome on when config.linkedin.mode is live, off otherwise (fake launcher)', async () => {
    e = openFixtureEngine();
    okOut(await e.runOp('runs.start', { skill: 'connect', role_id: 'linear_product-lead-insights' }, ctxAt('human')));
    const live = e.launcher.specs[0];
    expect(live?.args).toContain('--chrome');
    expect(flag(live?.args ?? [], '--allowedTools')).toContain(`${CHROME_PREFIX}navigate`);
    expect(live?.args[1]).toContain('profiles left today (of 40)');
    e.cleanup();
    e = openFixtureEngine({ config: { linkedin: { mode: 'off' } } });
    okOut(await e.runOp('runs.start', { skill: 'connect', role_id: 'linear_product-lead-insights' }, ctxAt('human')));
    const off = e.launcher.specs[0];
    expect(off?.args).not.toContain('--chrome');
    expect(flag(off?.args ?? [], '--allowedTools')).not.toContain(CHROME_PREFIX);
    expect(off?.args[1]).toContain('LinkedIn: off for this run');
  });

  it('runs.start { skill: fill, assist } (#106): the fill assist run gets form_input + file_upload and the assist prompt (fake launcher)', async () => {
    e = openFixtureEngine({ config: { runs: { max_concurrent: 1 } } });
    const role_id = 'linear_product-lead-insights';
    // A research run holds the only slot, so the fill run waits queued.
    okOut(await e.runOp('runs.start', { skill: 'research', role_id: 'vercel_principal-pm-data' }, ctxAt('human')));
    const plain = okOut(await e.runOp('runs.start', { skill: 'fill', role_id }, ctxAt('human'))).run;
    expect(plain.status).toBe('queued');
    expect(plain.summary_json.assist).toBeUndefined();
    // Open and fill on the queued plain run turns its assist on (same run, deduped).
    const asked = okOut(await e.runOp('runs.start', { skill: 'fill', role_id, assist: true }, ctxAt('human')));
    expect(asked).toMatchObject({ deduped: true, run: { id: plain.id, summary_json: { assist: true } } });
    const research = e.launcher.specs.length;
    const first = (okOut(await e.runOp('runs.list', {}, ctxAt('human'))).items.find((r) => r.op === 'research') as { id: string }).id;
    okOut(await e.runOp('runs.finish', { run_id: first, status: 'ok' }, ctxAt('agent')));
    await new Promise((r) => setTimeout(r, 0));
    const spec = e.launcher.specs[research];
    expect(spec?.args).toContain('--chrome');
    expect(flag(spec?.args ?? [], '--allowedTools')?.split(',')).toEqual(expect.arrayContaining(FILL_ASSIST_TOOLS));
    expect(spec?.args[1]).toContain(FILL_ASSIST_LINE);
    // assist is for fill, with a role.
    expect(await e.runOp('runs.start', { skill: 'tailor', role_id, assist: true }, ctxAt('human'))).toMatchObject({
      code: 'invalid_input',
    });
    expect(await e.runOp('runs.start', { skill: 'fill', assist: true }, ctxAt('human'))).toMatchObject({ code: 'invalid_input' });
  });

  it("runs.start { skill: fill, assist } (#123): renders the PDFs first, adds only that role's folder, names absolute paths", async () => {
    e = openFixtureEngine();
    const role_id = FIXTURE_ROLE_IDS.linearDraft;
    const run = okOut(await e.runOp('runs.start', { skill: 'fill', role_id, assist: true }, ctxAt('human'))).run;
    expect(e.launcher.specs).toHaveLength(1);
    const args = e.launcher.specs[0]?.args ?? [];
    const dir = flag(args, '--add-dir') as string;
    expect(isAbsolute(dir)).toBe(true);
    expect(dir).toBe(join(e.home, 'files', role_id));
    // The folder exists at launch (rendered first) and holds the PDFs.
    expect(statSync(dir).isDirectory()).toBe(true);
    for (const f of ['resume.pdf', 'cover_letter.pdf']) expect(existsSync(join(dir, f))).toBe(true);
    expect(args.filter((a) => a === '--add-dir')).toHaveLength(1);
    expect(args).not.toContain(e.home);
    expect(args).not.toContain(join(e.home, 'files'));
    const prompt = args[1] as string;
    expect(prompt).toContain(`resume: ${join(dir, 'resume.pdf')}`);
    expect(prompt).toContain(`cover_letter: ${join(dir, 'cover_letter.pdf')}`);
    // The render is logged on the run.
    expect(okOut(await e.runOp('runs.get', { run_id: run.id }, ctxAt('human'))).log_md).toContain('apply.render_documents');
  });

  it('runs.start { skill: fill, assist } (#123): a failed render launches without --add-dir and reports uploads as skipped', async () => {
    e = openFixtureEngine();
    const role_id = FIXTURE_ROLE_IDS.linearDraft;
    const row = e.db.prepare('SELECT package_paths_json FROM application WHERE role_id = ?').get(role_id) as { package_paths_json: string };
    rmSync(join(e.home, JSON.parse(row.package_paths_json).resume as string));
    okOut(await e.runOp('runs.start', { skill: 'fill', role_id, assist: true }, ctxAt('human')));
    const args = e.launcher.specs[0]?.args ?? [];
    expect(args).not.toContain('--add-dir');
    expect(existsSync(join(e.home, 'files', role_id))).toBe(false);
    const prompt = args[1] as string;
    expect(prompt).toContain('Rendering the PDFs failed before launch');
    expect(prompt).toMatch(/reason: "render failed: [^"]*no tailored resume/);
  });

  it('runs.start { skill: fill } without assist stays read-only (fake launcher)', async () => {
    e = openFixtureEngine();
    okOut(await e.runOp('runs.start', { skill: 'fill', role_id: 'linear_product-lead-insights' }, ctxAt('human')));
    const spec = e.launcher.specs[0];
    for (const t of FILL_ASSIST_TOOLS) {
      expect(flag(spec?.args ?? [], '--allowedTools')?.split(',')).not.toContain(t);
      expect(flag(spec?.args ?? [], '--disallowedTools')?.split(',')).toContain(t);
    }
    expect(spec?.args[1]).not.toContain(FILL_ASSIST_LINE);
    // #123: no --add-dir and nothing rendered for a read-only fill run.
    expect(spec?.args).not.toContain('--add-dir');
    expect(existsSync(join(e.home, 'files', 'linear_product-lead-insights'))).toBe(false);
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
    // #132: a recipient with no address at all gets no Gmail draft step (never a draft without To).
    const none = await e.runOp('runs.start', { skill: 'connect', outreach_id: 'or_0001' }, ctxAt('human'));
    expect(none).toMatchObject({ code: 'conflict' });
    expect((none as { message: string }).message).toContain('has no email');
    e.db
      .prepare("UPDATE contact SET email = 'maya@linear.example', email_source = 'gmail', email_confidence = 1 WHERE id = 'ct_0001'")
      .run();
    okOut(await e.runOp('outreach.to_gmail', { outreach_id: 'or_0001', gmail_draft_id: 'r-1' }, ctxAt('human')));
    expect(await e.runOp('runs.start', { skill: 'connect', outreach_id: 'or_0001' }, ctxAt('human'))).toMatchObject({ code: 'conflict' });
    expect(e.launcher.specs).toHaveLength(0);
  });
});

describe('Chrome tabs (#107)', () => {
  const CHROME: Skill[] = ['connect', 'fill', 'voice'];

  it('connect, fill and voice may see, create and close tabs; no other skill gets a tab tool', () => {
    expect(CHROME_TAB_TOOLS).toEqual(['tabs_context_mcp', 'tabs_create_mcp', 'tabs_close_mcp'].map((t) => `${CHROME_PREFIX}${t}`));
    for (const skill of SKILLS) {
      const allowed = skillAllowedTools(skill);
      for (const t of CHROME_TAB_TOOLS) expect(allowed.includes(t), `${skill}: ${t}`).toBe(CHROME.includes(skill));
      if (CHROME.includes(skill)) {
        const args = spec('claude', skill).args;
        const claude = flag(args, '--allowedTools')?.split(',') ?? [];
        for (const t of CHROME_TAB_TOOLS) expect(claude).toContain(t);
        expect(flag(args, '--disallowedTools')?.split(',') ?? []).not.toContain(`${CHROME_PREFIX}tabs_close_mcp`);
      }
    }
  });

  it('the prompt of a Chrome run says: reuse the session tab, close only its own tabs, report them', () => {
    const fill = skillPrompt(DEFAULT_SKILLS_DIR, { runId: 'rn_9', skill: 'fill', roleId: 'r_1' });
    expect(fill).toContain(tabsLine(false));
    expect(tabsLine(false)).toContain('reuse the tab this session created');
    expect(tabsLine(false)).toContain('left_open: []');
    const assist = skillPrompt(DEFAULT_SKILLS_DIR, { runId: 'rn_9', skill: 'fill', roleId: 'r_1', assist: true });
    expect(assist).toContain(tabsLine(true));
    expect(tabsLine(true)).toContain('leave the portal tab open');
    // No Chrome this run, no tabs line.
    expect(skillPrompt(DEFAULT_SKILLS_DIR, { runId: 'rn_9', skill: 'inbox' })).not.toContain('Chrome tabs:');
    const off = skillPrompt(DEFAULT_SKILLS_DIR, { runId: 'rn_9', skill: 'voice', voice: { linkedin: false, max_pages: 5 } });
    expect(off).not.toContain('Chrome tabs:');
    const on = skillPrompt(DEFAULT_SKILLS_DIR, { runId: 'rn_9', skill: 'voice', voice: { linkedin: true, max_pages: 5 } });
    expect(on).toContain(tabsLine(false));
  });

  const human = ctxAt('human');
  const startRun = async (input: Record<string, unknown>) => okOut(await e.runOp('runs.start', input, human)).run;
  const finish = (run_id: string, extra: Record<string, unknown>) =>
    e.runOp('runs.finish', { run_id, status: 'ok', ...extra }, ctxAt('agent'));

  it('runs.finish stores the tabs in the summary and lists them in the run log', async () => {
    e = openFixtureEngine();
    const run = await startRun({ skill: 'connect', role_id: FIXTURE_ROLE_IDS.stripeOnDeck });
    const out = okOut(await finish(run.id, { tabs: { opened: [11, 12], closed: [11, 12] } }));
    expect(out.run.summary_json.tabs).toEqual({ opened: [11, 12], closed: [11, 12], left_open: [] });
    const got = okOut(await e.runOp('runs.get', { run_id: run.id }, human));
    expect(got.run.summary_json.tabs).toEqual({ opened: [11, 12], closed: [11, 12], left_open: [] });
    expect(got.log_md).toContain('Tabs: opened 11, 12; closed 11, 12');
    // Reported inside summary works too.
    const v = await startRun({ skill: 'voice' });
    const o2 = okOut(await finish(v.id, { summary: { samples: 0, tabs: { opened: [3], closed: [3] } } }));
    expect(o2.run.summary_json.tabs).toEqual({ opened: [3], closed: [3], left_open: [] });
  });

  it("refuses tabs from a non-Chrome run, closing a tab it did not use, or leaving one open outside the fill assist's portal", async () => {
    e = openFixtureEngine();
    const inbox = await startRun({ skill: 'inbox' });
    expect((await finish(inbox.id, { tabs: { opened: [1], closed: [1] } })).status).toBe('error');
    const c = await startRun({ skill: 'connect', role_id: FIXTURE_ROLE_IDS.stripeOnDeck });
    // A tab the run did not report as used (the user's): refused.
    expect((await finish(c.id, { tabs: { opened: [1], closed: [1, 99] } })).status).toBe('error');
    // A connect run never leaves a tab open.
    expect((await finish(c.id, { tabs: { opened: [1], left_open: [1], portal: 1 } })).status).toBe('error');
    // A fill run without assist neither.
    const f = await startRun({ skill: 'fill', role_id: FIXTURE_ROLE_IDS.vercelDraft });
    expect((await finish(f.id, { tabs: { opened: [5], left_open: [5], portal: 5 } })).status).toBe('error');
    okOut(await finish(c.id, { tabs: { opened: [1], closed: [1] } }));
    okOut(await finish(f.id, { tabs: { opened: [5], closed: [5] } }));
  });

  it('the fill assist may leave its portal tab open, and only that one', async () => {
    e = openFixtureEngine();
    const run = await startRun({ skill: 'fill', role_id: FIXTURE_ROLE_IDS.linearDraft, assist: true });
    expect(run.summary_json.assist).toBe(true);
    // Two tabs left open, or a left-open tab that is not the portal: refused.
    expect((await finish(run.id, { tabs: { opened: [7, 8], left_open: [7, 8], portal: 7 } })).status).toBe('error');
    expect((await finish(run.id, { tabs: { opened: [7, 8], closed: [7], left_open: [8], portal: 7 } })).status).toBe('error');
    expect((await finish(run.id, { tabs: { opened: [7], left_open: [7] } })).status).toBe('error');
    const out = okOut(await finish(run.id, { tabs: { opened: [7, 8], closed: [8], left_open: [7], portal: 7 } }));
    expect(out.run.summary_json.tabs).toEqual({ opened: [7, 8], closed: [8], left_open: [7], portal: 7 });
    expect(okOut(await e.runOp('runs.get', { run_id: run.id }, human)).log_md).toContain('left open 7 (portal)');
  });
});
