import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Synthetic v1 repo writer lives with the importer (engine/db/testing); import from source.
import { writeSyntheticV1 } from '../../../engine/db/testing/synthetic-v1.js';
import { doctorCommand } from './doctor.js';
import { migrateCommand, parseFlags } from './migrate.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pp-cli-'));
  writeSyntheticV1(join(tmp, 'v1'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: {} }, out, err };
};

describe('pp migrate / pp doctor', () => {
  it('parses flags', () => {
    expect(parseFlags(['--from', 'a', '--dry-run', '--home=b'], ['dry-run'])).toEqual({ from: 'a', 'dry-run': true, home: 'b' });
  });

  it('requires --from', () => {
    const c = capture();
    expect(migrateCommand([], c.io)).toBe(1);
    expect(c.err.join()).toMatch(/--from/);
  });

  it('migrates, reruns as a no-op, and doctor is green', () => {
    const home = join(tmp, 'home');
    const c = capture();
    expect(migrateCommand(['--from', join(tmp, 'v1'), '--home', home], c.io)).toBe(0);
    expect(c.out.join('\n')).toMatch(/\(match\)/);
    const again = capture();
    expect(migrateCommand(['--from', join(tmp, 'v1'), '--home', home, '--json'], again.io)).toBe(0);
    expect(JSON.parse(again.out.join('\n')).filesWritten).toBe(0);
    const d = capture();
    expect(doctorCommand(['--home', home], d.io, tmp)).toBe(0);
    expect(d.out.some((l) => l.startsWith('FAIL'))).toBe(false);
  });

  it('doctor exits 1 on an empty home', () => {
    const d = capture();
    expect(doctorCommand(['--home', join(tmp, 'nope'), '--json'], d.io, tmp)).toBe(1);
    expect(JSON.parse(d.out.join('\n')).ok).toBe(false);
  });
});
