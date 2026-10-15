import { RUNNER_COMMANDS } from '@perfect-placement/contracts';
import { describe, expect, it } from 'vitest';
import { RUNNERS } from './registry.js';

describe('runner registry (#160)', () => {
  it('every configurable runner has exactly one binding, under its own command', () => {
    expect(Object.keys(RUNNERS).sort()).toEqual([...RUNNER_COMMANDS].sort());
    for (const command of RUNNER_COMMANDS) expect(RUNNERS[command].command).toBe(command);
  });

  it('only Claude reports denied tools; only Codex keeps job environment', () => {
    expect(RUNNER_COMMANDS.filter((c) => RUNNERS[c].deniedTools)).toEqual(['claude']);
    expect(RUNNER_COMMANDS.filter((c) => RUNNERS[c].jobEnv)).toEqual(['codex']);
  });
});
