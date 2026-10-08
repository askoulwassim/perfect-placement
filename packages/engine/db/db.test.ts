import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listMigrations, MIGRATIONS_DIR } from './index.js';

describe('migrations', () => {
  it('are discoverable and start at 001', () => {
    expect(existsSync(MIGRATIONS_DIR)).toBe(true);
    expect(listMigrations()[0]).toBe('001_init.sql');
  });
});
