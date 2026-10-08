import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProfileComponentKey } from '@perfect-placement/contracts';
import type { CalibrationChoice } from './calibration.js';
import type { Draft } from './questions.js';

/*
 * Onboarding session storage.
 * SHIM for Wave 2: migration 001 has no table for in-progress onboarding. Contract request
 * (CONTRACT_CHANGES, lane E): an `onboard_session` table. Until then: in-memory (tests)
 * or one JSON file at `$PP_HOME/onboarding.json` (next to config.json, not parsed markdown).
 */

export type OnboardStep = 'resume' | 'interview' | 'calibrate' | 'confirm' | 'done';
export type FillSource = 'resume' | 'interview' | 'profile';

export interface OnboardSession {
  id: string;
  started_at: string;
  updated_at: string;
  step: OnboardStep;
  /** Components being (re-)interviewed; null = full onboarding. */
  scope: ProfileComponentKey[] | null;
  draft: Draft;
  /** Where each component's data came from, for confidence. */
  sources: Partial<Record<ProfileComponentKey, FillSource[]>>;
  answered: string[];
  calibration: { sample_ids: string[]; choices: Record<string, CalibrationChoice> };
  version_id: string | null;
}

export interface OnboardStore {
  load(): OnboardSession | null;
  save(s: OnboardSession): void;
}

export function createMemoryOnboardStore(): OnboardStore {
  let s: OnboardSession | null = null;
  return {
    load: () => (s ? (JSON.parse(JSON.stringify(s)) as OnboardSession) : null),
    save: (next) => {
      s = JSON.parse(JSON.stringify(next)) as OnboardSession;
    },
  };
}

export const ONBOARD_FILE = 'onboarding.json';

export function createFileOnboardStore(vaultDir: string): OnboardStore {
  const file = join(vaultDir, ONBOARD_FILE);
  return {
    load: () => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as OnboardSession) : null),
    save: (s) => {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
      renameSync(tmp, file);
    },
  };
}
