import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, VAULT_DIRS } from '@perfect-placement/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findClaudeMdInParents,
  findGitRoot,
  initVault,
  parseMd,
  readConfig,
  readMd,
  renderMd,
  resolvePpHome,
  vaultAbs,
  writeMd,
} from './vault.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pp-vault-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('vault', () => {
  it('resolves PP_HOME from arg, env, then default', () => {
    expect(resolvePpHome(dir, {})).toBe(dir);
    expect(resolvePpHome(undefined, { PP_HOME: dir })).toBe(dir);
    expect(resolvePpHome(undefined, {})).toBe(join(homedir(), '.perfect-placement'));
    expect(resolvePpHome('~/x', {})).toBe(join(homedir(), 'x'));
  });

  it('creates the tree and a default config without overwriting', () => {
    initVault(dir);
    for (const d of VAULT_DIRS) expect(() => vaultAbs(dir, d)).not.toThrow();
    expect(readConfig(dir)).toEqual(DEFAULT_CONFIG);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG, scout: { watchlist_share_max: 0.5 } }));
    initVault(dir);
    expect(readConfig(dir).scout.watchlist_share_max).toBe(0.5);
  });

  it('round-trips frontmatter in the fixtures format', () => {
    const text = renderMd({ id: 'acme_pm', type: 'role', key: 'x' }, '# Title\n\nBody');
    expect(text).toBe('---\nid: "acme_pm"\ntype: "role"\nkey: "x"\n---\n\n# Title\n\nBody\n');
    expect(parseMd(text)).toEqual({ frontmatter: { id: 'acme_pm', type: 'role', key: 'x' }, body: '# Title\n\nBody\n' });
    expect(parseMd('no frontmatter')).toEqual({ frontmatter: {}, body: 'no frontmatter' });
    expect(parseMd('---\nid: plain\n---\nx').frontmatter.id).toBe('plain');
  });

  it('writes markdown without clobbering and refuses path escapes', () => {
    expect(writeMd(dir, 'roles/a.md', { id: 'a', type: 'role' }, 'one')).toBe(true);
    expect(writeMd(dir, 'roles/a.md', { id: 'a', type: 'role' }, 'two')).toBe(false);
    expect(readMd(dir, 'roles/a.md').body).toBe('one\n');
    expect(() => vaultAbs(dir, '../x.md')).toThrow();
    expect(() => vaultAbs(dir, '/etc/x')).toThrow();
  });

  it('finds git roots and CLAUDE.md up the parent chain', () => {
    const deep = join(dir, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    expect(findGitRoot(deep)).toBeNull();
    expect(findClaudeMdInParents(deep)).toEqual([]);
    mkdirSync(join(dir, 'a', '.git'));
    writeFileSync(join(dir, 'CLAUDE.md'), '#');
    expect(findGitRoot(deep)).toBe(join(dir, 'a'));
    expect(findClaudeMdInParents(deep)).toEqual([join(dir, 'CLAUDE.md')]);
  });
});
