import type { AtsRef } from './detect.js';

/** Full JD as captured from an ATS public API (intake + freshness). */
export interface AtsPosting {
  ats: AtsRef['type'];
  jobId: string;
  title: string;
  location: string | null;
  /** Public posting URL. */
  url: string | null;
  applyUrl: string | null;
  postedAt: string | null;
  updatedAt: string | null;
  /** Workplace as the ATS states it (`remote`, `hybrid`, `onsite`), lowercased; null if absent. */
  workplace: string | null;
  /** JD as HTML (entities decoded) and as plain text. */
  html: string;
  text: string;
}

/**
 * One ATS lookup. `closed` only when the API proves the posting is gone while the board itself
 * is alive. Anything ambiguous (board missing, rate limit, 5xx, network) is `unknown` and falls
 * through to the page check.
 */
export type AtsCheck =
  | { state: 'open'; status: number; endpoint: string; posting: AtsPosting }
  | { state: 'closed'; status: number; endpoint: string; reason: string }
  | { state: 'unknown'; status: number; endpoint: string; reason: string };
