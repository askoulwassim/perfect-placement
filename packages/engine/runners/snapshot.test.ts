/**
 * Every runner's command line for every skill and mode, pinned (#160). A runner refactor must leave
 * this file byte-identical; a deliberate change regenerates it (`vitest -u`) and the diff shows what moved.
 * Long arguments (prompts, system prompts) are stored as a hash and length; paths that depend on the
 * machine (the checkout, the browser runtime cache) are normalized.
 */
import { createHash } from 'node:crypto';
import { DEFAULT_CONFIG, RUNNER_COMMANDS, type RunnerConfig, SKILLS, type Skill } from '@perfect-placement/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAskSpec } from '../ops/ask.js';
import { browserRuntime } from './browser/runtime.js';
import {
  type AssistUploads,
  buildRunnerSpec,
  DEFAULT_SKILLS_DIR,
  gmailDraftPrompt,
  gmailToPrompt,
  type McpServerSpec,
  type PromptContext,
  type RunnerCommand,
  resolveRepoRoot,
  skillPrompt,
} from './index.js';

const REPO = resolveRepoRoot();
const HOME = '/tmp/pp-snapshot-vault';
const MCP: McpServerSpec = { command: '/usr/bin/node', args: ['/opt/pp/packages/mcp/dist/bin.js'], env: { PP_HOME: HOME } };
const FILES_DIR = `${HOME}/files/synthetic-co_synthetic-role`;
const LONG = 1500;
const BROWSER_LOCATIONS = ['HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'CHROME_CONFIG_HOME', 'LOCALAPPDATA', 'APPDATA'];

let runtimeDir: string;
const normalize = (s: string) => s.replaceAll(runtimeDir, '<codex-runtime>').replaceAll(REPO, '<repo>');
const arg = (a: string) => {
  const n = normalize(a);
  return n.length > LONG ? `<sha256:${createHash('sha256').update(n).digest('hex').slice(0, 16)} len:${n.length}>` : n;
};
const shape = (s: { command: string; args: string[]; cwd: string | null; env: Record<string, string>; files: unknown }) => ({
  command: s.command,
  args: s.args.map(arg),
  cwd: s.cwd,
  env: s.env,
  files: JSON.parse(normalize(JSON.stringify(s.files))) as unknown,
});

interface Mode {
  name: string;
  skills: readonly Skill[];
  build: (skill: Skill, runId: string) => { prompt: string; extra: Partial<Parameters<typeof buildRunnerSpec>[0]> };
}

const li = DEFAULT_CONFIG.linkedin;
/** The runner whose names the prompts use (#159): the one whose command line is being built. */
let runner: RunnerCommand = 'claude';
const context = (skill: Skill, runId: string, over: Partial<PromptContext> = {}): PromptContext => ({
  runId,
  skill,
  runner,
  roleId: 'synthetic-co_synthetic-role',
  ...(skill === 'connect' ? { contactId: 'ct_synthetic', linkedin: { ...li, mode: 'live' as const, budget_left: 7 } } : {}),
  ...(skill === 'voice' ? { voice: { linkedin: true, max_pages: 5 } } : {}),
  ...over,
});
const uploads: AssistUploads = {
  dir: FILES_DIR,
  files: [
    { doc: 'resume', abs_path: `${FILES_DIR}/resume.pdf` },
    { doc: 'cover_letter', abs_path: `${FILES_DIR}/cover_letter.pdf` },
  ],
};
const ids = (runId: string) => ({
  runId,
  runner,
  outreachId: 'out_synthetic',
  roleId: 'synthetic-co_synthetic-role',
  contactId: 'ct_synthetic',
});

const MODES: Mode[] = [
  {
    name: 'default',
    skills: SKILLS,
    build: (skill, runId) => ({ prompt: skillPrompt(DEFAULT_SKILLS_DIR, context(skill, runId)), extra: {} }),
  },
  {
    name: 'linkedin-off',
    skills: ['connect', 'voice'],
    build: (skill, runId) => ({
      prompt: skillPrompt(
        DEFAULT_SKILLS_DIR,
        context(
          skill,
          runId,
          skill === 'connect' ? { linkedin: { ...li, mode: 'off', budget_left: 7 } } : { voice: { linkedin: false, max_pages: 5 } },
        ),
      ),
      extra: { linkedin: false },
    }),
  },
  {
    name: 'questions',
    skills: ['fill'],
    build: (skill, runId) => ({
      prompt: skillPrompt(DEFAULT_SKILLS_DIR, context(skill, runId, { questions: 'applications/q.md' })),
      extra: {},
    }),
  },
  {
    name: 'assist-rendered',
    skills: ['fill'],
    build: (skill, runId) => ({
      prompt: skillPrompt(DEFAULT_SKILLS_DIR, context(skill, runId, { assist: true, uploads })),
      extra: { assist: true, filesDir: FILES_DIR },
    }),
  },
  {
    name: 'assist-render-failed',
    skills: ['fill'],
    build: (skill, runId) => ({
      prompt: skillPrompt(DEFAULT_SKILLS_DIR, context(skill, runId, { assist: true, uploads: { error: 'synthetic render error' } })),
      extra: { assist: true },
    }),
  },
  {
    name: 'assist-unrendered',
    skills: ['fill'],
    build: (skill, runId) => ({
      prompt: skillPrompt(DEFAULT_SKILLS_DIR, context(skill, runId, { assist: true })),
      extra: { assist: true },
    }),
  },
  {
    name: 'gmail-draft',
    skills: ['connect'],
    build: (_s, runId) => ({ prompt: gmailDraftPrompt(DEFAULT_SKILLS_DIR, ids(runId)), extra: { gmailDraft: true } }),
  },
  {
    name: 'gmail-to',
    skills: ['connect'],
    build: (_s, runId) => ({ prompt: gmailToPrompt(DEFAULT_SKILLS_DIR, ids(runId)), extra: { gmailTo: true } }),
  },
];

beforeEach(() => {
  vi.stubEnv('HOME', '/tmp/pp-snapshot-user');
  vi.stubEnv('XDG_CACHE_HOME', '/tmp/pp-snapshot-cache');
  for (const key of BROWSER_LOCATIONS.slice(2)) vi.stubEnv(key, '');
  vi.stubEnv('PP_NODE', '');
  runtimeDir = browserRuntime({ repoRoot: REPO, env: process.env }).dir;
});
afterEach(() => vi.unstubAllEnvs());

describe('runner specs (#160)', () => {
  it('every runner, skill and mode builds the pinned command line', async () => {
    const specs: Record<string, unknown> = {};
    for (const command of RUNNER_COMMANDS)
      for (const mode of MODES)
        for (const skill of mode.skills) {
          const runId = 'rn_snapshot';
          runner = command;
          const { prompt, extra } = mode.build(skill, runId);
          const config: RunnerConfig = {
            command,
            ...(mode.name === 'default' && skill === 'scout' ? { args: ['--model', 'synthetic'] } : {}),
          };
          specs[`${command} ${skill} ${mode.name}`] = shape(
            buildRunnerSpec({ runner: config, skill, runId, home: HOME, mcp: MCP, prompt, ...extra }),
          );
        }
    await expect(`${JSON.stringify(specs, null, 2)}\n`).toMatchFileSnapshot('./__snapshots__/run-specs.json');
  });

  it('every runner builds the pinned Ask command line', async () => {
    const specs: Record<string, unknown> = {};
    for (const command of RUNNER_COMMANDS) {
      const base = { runner: { command } as RunnerConfig, message: 'Which roles fit?', home: HOME, mcp: MCP };
      specs[`${command} first`] = shape({ ...buildAskSpec(base) });
      specs[`${command} resumed`] = shape({
        ...buildAskSpec({
          ...base,
          runner: { command, args: ['--model', 'synthetic'] },
          sessionId: 'sess_synthetic',
          turns: [{ user: 'Hi', reply: 'Hello' }],
        }),
      });
    }
    await expect(`${JSON.stringify(specs, null, 2)}\n`).toMatchFileSnapshot('./__snapshots__/ask-specs.json');
  });
});
