import {
  BOARD_TYPES,
  type BoardCache,
  type BoardListing,
  type BoardRef,
  type BoardType,
  cachedListBoard,
  type FetchLike,
} from '../integrations/ats/index.js';

/*
 * Find a company's ATS board (#28, #32). The company row's `ats_type` + `ats_board` first; otherwise
 * probe Greenhouse, Lever and Ashby with the company slug (and its hyphen-free form). One request per
 * probe, memoised per op call.
 */

export interface CompanyHint {
  slug: string;
  ats_type?: string | null;
  ats_board?: string | null;
}

export type BoardFound = Extract<BoardListing, { state: 'ok' }>;

export interface BoardSearch {
  found: BoardFound | null;
  /** Every probe that ended in a transport error (rate limit, 5xx, network): "not found" is then unproven. */
  errors: string[];
}

const isBoardType = (t: string | null | undefined): t is BoardType => !!t && (BOARD_TYPES as readonly string[]).includes(t);

export function boardCandidates(c: CompanyHint): BoardRef[] {
  const refs: BoardRef[] = [];
  const add = (type: BoardType, board: string | null | undefined) => {
    if (!board) return;
    if (!refs.some((r) => r.type === type && r.board.toLowerCase() === board.toLowerCase())) refs.push({ type, board });
  };
  if (isBoardType(c.ats_type) && c.ats_board) add(c.ats_type, c.ats_board);
  // A known ATS that is not one of ours (Workday, custom) is not probed.
  if (c.ats_type && !['unknown', 'other', ...BOARD_TYPES].includes(c.ats_type)) return refs;
  const names = [c.ats_board, c.slug, c.slug.replace(/-/g, '')].filter((n): n is string => !!n);
  for (const type of BOARD_TYPES) for (const n of names) add(type, n);
  return refs;
}

export async function findBoard(c: CompanyHint, fetchFn: FetchLike, cache: BoardCache): Promise<BoardSearch> {
  const errors: string[] = [];
  for (const ref of boardCandidates(c)) {
    const res = await cachedListBoard(cache, ref, fetchFn);
    if (res.state === 'ok') return { found: res, errors };
    if (res.state === 'error') errors.push(`${ref.type}:${ref.board} ${res.reason}`);
  }
  return { found: null, errors };
}
