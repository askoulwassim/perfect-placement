import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURE_SEED_SQL, FIXTURE_VAULT_DIR, roles } from '@perfect-placement/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { doctor } from './doctor.js';
import { loadSeededVault } from './index.js';

let tmp: string;
let home: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pp-doctor-'));
  home = join(tmp, 'home');
  loadSeededVault(home, { vaultDir: FIXTURE_VAULT_DIR, seedSql: FIXTURE_SEED_SQL }).close();
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const failed = (r: ReturnType<typeof doctor>) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe('system.doctor', () => {
  it('is green on the fixtures', () => {
    const r = doctor({ home, cwd: tmp });
    expect(failed(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(Object.values(r.counts).reduce((a, b) => a + b, 0)).toBe(roles.length);
    for (const s of new Set(roles.map((x) => x.status))) expect(r.counts[s]).toBe(roles.filter((x) => x.status === s).length);
  });

  it('flags a missing md_path and an orphan file', () => {
    const role = roles[0];
    unlinkSync(join(home, role?.md_path as string));
    writeFileSync(join(home, 'roles', 'stray.md'), '---\nid: "stray"\ntype: "role"\n---\n\nx\n');
    const r = doctor({ home, cwd: tmp });
    expect(failed(r).sort()).toEqual(['md_paths_exist', 'no_orphan_files']);
  });

  it('flags a frontmatter id mismatch', () => {
    const role = roles[0];
    writeFileSync(join(home, role?.md_path as string), '---\nid: "someone-else"\ntype: "role"\n---\n\nx\n');
    expect(failed(doctor({ home, cwd: tmp }))).toEqual(['md_frontmatter']);
  });

  it('flags CLAUDE.md in the parent chain and a PP_HOME inside git', () => {
    const work = join(tmp, 'work', 'deeper');
    mkdirSync(work, { recursive: true });
    writeFileSync(join(tmp, 'work', 'CLAUDE.md'), '#');
    mkdirSync(join(home, '.git'));
    const r = doctor({ home, cwd: work });
    expect(failed(r).sort()).toEqual(['no_claude_md', 'pp_home_not_in_git']);
  });

  it('reports a missing db and invalid config without throwing', () => {
    const empty = join(tmp, 'empty');
    mkdirSync(empty);
    writeFileSync(join(empty, 'config.json'), '{"policy":1}');
    const r = doctor({ home: empty, cwd: tmp });
    expect(r.ok).toBe(false);
    expect(failed(r).sort()).toEqual(['config', 'db_exists']);
  });
});
