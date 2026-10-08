/*
 * Scripted stream: replays a recorded reply in token-sized pieces, like a model would emit it.
 * No API key needed. Tests pass tokenPieces (exact o200k boundaries); the browser demo uses the cheap splitter.
 */

/** Rough token-sized pieces: words, punctuation runs and whitespace, capped at 4 chars. */
export const roughPieces = (text: string): string[] => text.match(/\s+|[A-Za-z]{1,4}|\d{1,3}|[^\sA-Za-z\d]/g) ?? [];

export interface StreamOptions {
  /** Output speed. Infinity = no delay (tests). */
  tokensPerSecond?: number;
  /** Tokens per emitted chunk (providers usually send a few at a time). */
  chunkTokens?: number;
  /** Delay before the first chunk, ms (time to first token). */
  firstTokenMs?: number;
  split?: (text: string) => string[];
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function* scriptedStream(text: string, opts: StreamOptions = {}): AsyncGenerator<string> {
  const { tokensPerSecond = Number.POSITIVE_INFINITY, chunkTokens = 3, firstTokenMs = 0, split = roughPieces } = opts;
  const pieces = split(text);
  if (firstTokenMs > 0) await sleep(firstTokenMs);
  for (let i = 0; i < pieces.length; i += chunkTokens) {
    if (opts.signal?.aborted) return;
    yield pieces.slice(i, i + chunkTokens).join('');
    if (Number.isFinite(tokensPerSecond)) await sleep((1000 * chunkTokens) / tokensPerSecond);
    else await Promise.resolve();
  }
}
