import type { Route } from '../router';

/*
 * First-visit cues (wave1-decisions #27): one spotlight per screen on its primary action, with a
 * one to three word label. Shown once; the ids seen live in the vault (`config.ui.cues_seen`).
 */

export const CUES = {
  now: 'Review here',
  'needs-you': 'Accept or change',
  river: 'Scout roles',
  role: 'Next stage',
  people: 'Pick a path',
  outreach: 'Draft to Gmail',
  you: 'Your profile',
  settings: 'Tune policy',
  ask: 'Ask anything',
} as const;
export type CueId = keyof typeof CUES;
export const CUE_IDS = Object.keys(CUES) as CueId[];

/** Where the spotlight lands: Ask's input, or the screen's one primary button. */
export const CUE_TARGET: Record<CueId, string> = Object.fromEntries(
  CUE_IDS.map((id) => [id, id === 'ask' ? '.ask input' : '.btn--primary']),
) as Record<CueId, string>;

/** The cue for what is on screen (`shown`: the screen actually rendered), or null (Onboarding). */
export function cueFor(shown: Route['screen'] | null, askOpen: boolean): CueId | null {
  if (askOpen) return 'ask';
  if (!shown || shown === 'onboarding') return null;
  return shown === 'outreach-draft' ? 'outreach' : shown;
}

/** The cue still to show, if any: known seen list and not in it. */
export function pendingCue(id: CueId | null, seen: readonly string[] | null): CueId | null {
  return id && seen && !seen.includes(id) ? id : null;
}
