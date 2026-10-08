import type { AskFn } from './AskPanel.js';
import { routeAsk } from './replies.js';
import { type StreamOptions, scriptedStream } from './stream.js';

/** Scripted Ask backend: routes the question to a recorded reply and streams it. Wave 2 swaps in the live agent. */
export const scriptedAsk =
  (opts: Omit<StreamOptions, 'signal'> = {}): AskFn =>
  (query, signal) =>
    scriptedStream(routeAsk(query).openui, { ...opts, signal });
