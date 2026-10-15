import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNNER_COMMANDS } from '@perfect-placement/contracts';
import { describe, expect, it } from 'vitest';
import { CLAUDE_TEXT } from './claude-tools.js';
import { DEFAULT_SKILLS_DIR, REPO_ROOT } from './mcp-server.js';
import { RUNNERS } from './registry.js';
import { placeholdersIn, renderText } from './text.js';

const skills = readdirSync(DEFAULT_SKILLS_DIR).filter((s) => !s.includes('.'));
const skillMd = (s: string) => readFileSync(join(DEFAULT_SKILLS_DIR, s, 'SKILL.md'), 'utf8');

describe('runner-neutral skills (#159)', () => {
  it('no SKILL.md names a runner, its tools or its mechanics', () => {
    const runnerSpecific =
      /mcp__claude|mcp__pp\b|claude\.ai|Claude Code|Claude in Chrome|\bCodex\b|\bCursor\b|WebSearch|WebFetch|web\.run|pp_browser|tabs_context_mcp|tabs_create_mcp|tabs_close_mcp|get_page_text|read_page|form_input|file_upload|fill_form|upload_file|take_snapshot|list_pages|new_page|--chrome|--add-dir|--disallowedTools|connector_unavailable/;
    for (const s of skills)
      for (const [i, line] of skillMd(s).split('\n').entries()) expect(line, `${s}/SKILL.md:${i + 1}`).not.toMatch(runnerSpecific);
  });

  it('every placeholder in every SKILL.md resolves for every runner, with and without uploads', () => {
    for (const s of skills)
      for (const command of RUNNER_COMMANDS)
        for (const uploadsOff of [false, true]) {
          const out = renderText(skillMd(s), RUNNERS[command].text, { runId: 'rn_1', uploadsOff });
          expect(out, `${s} for ${command}`).not.toMatch(/\{\{|\}\}/);
        }
  });

  it('every runner defines the same placeholders', () => {
    const keys = Object.keys(CLAUDE_TEXT).sort();
    for (const command of RUNNER_COMMANDS) expect(Object.keys(RUNNERS[command].text).sort(), command).toEqual(keys);
    for (const s of skills) for (const key of placeholdersIn(skillMd(s))) expect([...keys, 'run_id', 'uploads.off']).toContain(key);
  });

  it('an unknown placeholder or section fails instead of reaching an agent', () => {
    expect(() => renderText('{{browser.nmae}}', CLAUDE_TEXT)).toThrow('unknown placeholder');
    expect(() => renderText('{{#uploads.of}}x{{/uploads.of}}', CLAUDE_TEXT)).toThrow('unknown section');
    expect(() => renderText('{{run_id}}', CLAUDE_TEXT)).toThrow('needs a run id');
    expect(renderText('{{^uploads.off}}A{{/uploads.off}}{{#uploads.off}}B{{/uploads.off}}', CLAUDE_TEXT, { uploadsOff: true })).toBe('B');
  });

  it("Codex binds tools through its tables: no regex over the prompt's text", () => {
    for (const file of ['codex/index.ts', 'codex/connectors.ts', 'codex/text.ts']) {
      const source = readFileSync(join(REPO_ROOT, 'packages/engine/runners', file), 'utf8');
      expect(source, file).not.toMatch(/\.replace\(\s*\/|new RegExp\(/);
    }
  });
});
