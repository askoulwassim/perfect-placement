import type { OnboardSession as OnboardSessionRow, ProfileComponentKey } from '@perfect-placement/contracts';
import type { Repos } from '../db/repo.js';
import type { CalibrationChoice } from './calibration.js';
import type { Draft } from './questions.js';

/*
 * Onboarding session storage: the `onboard_session` table (migration 002), through lane A's
 * repositories. The latest session is the one `onboard.state` resumes.
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

const toRow = (s: OnboardSession): OnboardSessionRow => ({
  id: s.id,
  started_at: s.started_at,
  updated_at: s.updated_at,
  step: s.step,
  scope_json: s.scope,
  draft_json: s.draft as Record<string, unknown>,
  sources_json: s.sources as Record<string, unknown>,
  answered_json: s.answered,
  calibration_json: s.calibration as unknown as Record<string, unknown>,
  version_id: s.version_id,
});

const fromRow = (r: OnboardSessionRow): OnboardSession => ({
  id: r.id,
  started_at: r.started_at,
  updated_at: r.updated_at,
  step: r.step,
  scope: (r.scope_json as ProfileComponentKey[] | null) ?? null,
  draft: r.draft_json as Draft,
  sources: r.sources_json as OnboardSession['sources'],
  answered: r.answered_json,
  calibration: { sample_ids: [], choices: {}, ...(r.calibration_json as Partial<OnboardSession['calibration']>) },
  version_id: r.version_id,
});

export function createDbOnboardStore(R: Repos): OnboardStore {
  return {
    load() {
      const row = R.onboard_session.select('1 ORDER BY started_at DESC, id DESC LIMIT 1')[0];
      return row ? fromRow(row) : null;
    },
    save(s) {
      const row = toRow(s);
      if (R.onboard_session.has(s.id)) R.onboard_session.update(s.id, row);
      else R.onboard_session.insert(row);
    },
  };
}
