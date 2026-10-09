/*
 * Pure text helpers shared by the engine and the web UI (#38). No I/O.
 *
 * - `cleanDictation`: a dictated interview answer without the fillers ("um", "uh", "you know",
 *   repeated words). Meaning kept: it only removes, never rewrites. The raw text is kept for provenance.
 * - `numberWordsToDigits`: "ten years" -> "10 years", so stated facts compare as numbers.
 */

const FILLERS = `(?:u+h+m*|u+m+|e+r+m+|h+m+|m+h*m+|a+h+)`;

/** A dictated answer without fillers, stutters and doubled words. Returns trimmed text. */
export function cleanDictation(text: string): string {
  let s = ` ${text.replace(/\s+/g, ' ').trim()} `;
  // Bare fillers, with the comma or ellipsis that follows them.
  s = s.replace(new RegExp(String.raw`([\s,.;!?])${FILLERS}(?:[,.]{1,3}|\s*-+)?(?=\s)`, 'gi'), '$1');
  // Discourse fillers set off by commas, or opening a clause.
  s = s.replace(/,\s*(?:you know|i mean|like|basically|sort of|kind of)\s*,/gi, ',');
  s = s.replace(/(^\s*|[.!?]\s+|,\s+)(?:you know|i mean|so|well|basically|like|okay|ok),\s*/gi, '$1');
  s = s.replace(/(^\s*|[.!?]\s+)(?:so|well|okay|ok)\s+(?=\w)/gi, '$1');
  s = s.replace(/\s+(?:you know)(?=[\s.,!?])/gi, '');
  // Stutters and doubled words: "the the", "I I".
  s = s.replace(/\b(\w+)(?:\s+\1\b)+/gi, '$1');
  // Tidy punctuation and spacing.
  s = s
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/,(?:\s*,)+/g, ',')
    .replace(/([.!?]),/g, '$1')
    .replace(/^[\s,;:.]+/, '')
    .replace(/[\s,;:]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // Capitalize the first letter of each sentence.
  s = s.replace(/(^|[.!?]\s+)([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());
  return s;
}

const UNITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

const NUMBER_WORDS = new RegExp(
  String.raw`\b(?:(${Object.keys(TENS).join('|')})(?:[-\s](${Object.keys(UNITS).slice(1, 10).join('|')}))?|(${Object.keys(UNITS).join('|')}))\b`,
  'gi',
);

/** "Ten years" -> "10 years", "twenty-six" -> "26". Words above 99 are left alone. */
export function numberWordsToDigits(text: string): string {
  return text.replace(NUMBER_WORDS, (_m, tens?: string, unit?: string, single?: string) => {
    if (single) return String(UNITS[single.toLowerCase()]);
    return String((TENS[(tens ?? '').toLowerCase()] ?? 0) + (unit ? (UNITS[unit.toLowerCase()] ?? 0) : 0));
  });
}
