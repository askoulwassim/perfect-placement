import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_ROLE_IDS } from '@perfect-placement/fixtures';
import { describe, expect, it } from 'vitest';
import { ctxAt, okOut, openFixtureEngine } from '../../testing/index.js';
import { CODEX_BROWSER_READ_TOOLS } from './connectors.js';

describe('Codex fill assist dispatch', () => {
  it.each(['rendered', 'failed'] as const)(
    'launches after %s document rendering with matching grants and instructions',
    async (outcome) => {
      const e = openFixtureEngine({ config: { runner: { command: 'codex' } } });
      try {
        const role_id = FIXTURE_ROLE_IDS.linearDraft;
        const dir = join(e.home, 'files', role_id);
        if (outcome === 'failed') {
          const row = e.db.prepare('SELECT package_paths_json FROM application WHERE role_id = ?').get(role_id) as {
            package_paths_json: string;
          };
          // Remove only the synthetic fixture's tailored document to exercise the real render error.
          rmSync(join(e.home, JSON.parse(row.package_paths_json).resume as string));
        }
        const run = okOut(await e.runOp('runs.start', { skill: 'fill', role_id, assist: true }, ctxAt('human'))).run;
        expect(e.launcher.specs).toHaveLength(1);
        const spec = e.launcher.specs[0];
        expect(spec?.command).toBe('codex');
        const args = spec?.args ?? [];
        const setting = (prefix: string) => {
          const value = args.find((arg) => arg.startsWith(prefix)) as string;
          return JSON.parse(value.slice(value.indexOf('=') + 1)) as string[];
        };
        const browserArgs = setting('mcp_servers.pp_browser.args=');
        const granted = setting('mcp_servers.pp_browser.enabled_tools=');
        const prompt = args.at(-1) as string;
        expect(prompt).toContain('fill_form takes elements:');
        expect(prompt).toContain('Leave the filled, run-owned portal page open');
        expect(prompt).toContain('Never submit an application');
        expect(okOut(await e.runOp('runs.get', { run_id: run.id }, ctxAt('human'))).run.status).toBe('running');

        if (outcome === 'rendered') {
          expect(okOut(await e.runOp('runs.get', { run_id: run.id }, ctxAt('human'))).log_md).toContain('apply.render_documents');
          expect(granted).toEqual([...CODEX_BROWSER_READ_TOOLS, 'fill_form', 'upload_file']);
          expect(browserArgs[browserArgs.indexOf('--files-dir') + 1]).toBe(dir);
          expect(prompt).toContain('Uploads: rendered before launch');
          expect(prompt).toContain('Do not render them again');
          for (const doc of ['resume', 'cover_letter']) {
            const path = join(dir, `${doc}.pdf`);
            expect(existsSync(path)).toBe(true);
            expect(prompt).toContain(`${doc}: ${path}`);
          }
        } else {
          expect(granted).toEqual([...CODEX_BROWSER_READ_TOOLS, 'fill_form']);
          expect(browserArgs).not.toContain('--files-dir');
          expect(existsSync(dir)).toBe(false);
          expect(prompt).not.toContain('upload_file');
          expect(prompt).not.toContain('Uploads: call apply.render_documents');
          expect(prompt).not.toContain('3. Upload:');
          expect(prompt).toContain('Upload nothing and do not call apply.render_documents; fill the answer fields');
          expect(prompt).toContain('uploaded: []');
          const reason = `render failed: ${role_id}: no tailored resume yet (Tailor first)`;
          for (const label of ['Resume', 'Cover letter']) expect(prompt).toContain(`{ label: "${label}", reason: "${reason}" }`);
        }
      } finally {
        e.cleanup();
      }
    },
  );
});
