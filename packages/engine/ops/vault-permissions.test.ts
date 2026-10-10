import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILE, DB_FILE, DEFAULT_CONFIG } from '@perfect-placement/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { openEngine } from './index.js';

const mode = (p: string) => statSync(p).mode & 0o777;
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'pp-perm-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('vault permissions', () => {
  it('a new vault is owner-only: folders 0700, config.json and pp.db 0600', () => {
    const home = join(temp(), 'vault');
    const e = openEngine({ home });
    e.close();
    expect(mode(home)).toBe(0o700);
    expect(mode(join(home, 'roles'))).toBe(0o700);
    expect(mode(join(home, CONFIG_FILE))).toBe(0o600);
    expect(mode(join(home, DB_FILE))).toBe(0o600);
  });

  it('an existing vault keeps its permissions', () => {
    const home = join(temp(), 'vault');
    mkdirSync(home);
    chmodSync(home, 0o755);
    writeFileSync(join(home, CONFIG_FILE), `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    chmodSync(join(home, CONFIG_FILE), 0o644);
    const e = openEngine({ home });
    e.close();
    expect(mode(home)).toBe(0o755);
    expect(mode(join(home, CONFIG_FILE))).toBe(0o644);
  });
});
