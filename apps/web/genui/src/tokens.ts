/*
 * Token counting for measurement only (Node / tests). o200k_base is a proxy: Claude's tokenizer is not
 * public offline. Kept out of stream.ts so the browser demo does not ship 2 MB of BPE ranks.
 */
import { Tiktoken } from 'js-tiktoken/lite';
import o200k from 'js-tiktoken/ranks/o200k_base';

let enc: Tiktoken | undefined;
const encoder = () => {
  enc ??= new Tiktoken(o200k);
  return enc;
};

export const countTokens = (text: string): number => encoder().encode(text).length;

/** The text split at token boundaries (each piece is one token's text). */
export function tokenPieces(text: string): string[] {
  const e = encoder();
  return e.encode(text).map((t) => e.decode([t]));
}
