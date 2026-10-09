import { numberWordsToDigits } from '@perfect-placement/contracts';
import { parseRoleHeading, stripMd } from './resume.js';

/*
 * Fact check (#38), the `checkDraft` pattern for tailored documents: the model writes, code refuses
 * what the sources do not support. Sources = the kept resume text + the confirmed Story.
 *
 * Claims found in a document, by kind:
 *  - years    "26 years", "10+ yrs", "two decades": the same "N years" must be in the sources
 *  - date     "Mar 2022": the same month and year must be in the sources
 *  - number / year   any other number ("120 teams", "30%", "$6M", "2019")
 *  - degree   MBA, PhD, BS / BA / MS / MA, Bachelor's, Master's (same family in the sources)
 *  - title / employer from a role heading ("Acme - Senior PM - 2019-2022"): hard
 *  - title / employer named in prose ("as Head of Data", "at Globex"): soft (heuristic), may also come
 *    from `context` (the target role, JD, dossier)
 * Hard claims the sources lack are errors; soft ones are for the user to check (needs-you).
 */

export type FactKind = 'years' | 'date' | 'number' | 'year' | 'degree' | 'title' | 'employer';

export interface FactClaim {
  kind: FactKind;
  claim: string;
  /** The document line the claim is on. */
  line: string;
  /** Hard claims block; soft ones are flagged for the user. */
  hard: boolean;
  /** Supported claims: the first source line that carries it. */
  source?: string;
}

export interface FactCheck {
  unsupported: FactClaim[];
  supported: FactClaim[];
}

export interface FactOptions {
  /**
   * The target role, JD and dossier: a title or employer named in prose may come from here (a cover
   * letter names the company it applies to). Never a source for years, dates or degrees.
   */
  context?: string;
  /** Plain numbers may also come from `context` (cover letters quote the JD). Default false. */
  numbersFromContext?: boolean;
  /** Role headings ("Company - Title - Dates") are hard claims. Default true. */
  headings?: boolean;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DATE_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(?:\d{1,2},?\s+)?((?:19|20)\d{2})\b/gi;
const YEARS_RE = /(?<![\w.])(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/gi;
const DECADES_RE = /\bdecades?\b/i;
const NUMBER_RE = /(?<![A-Za-z0-9_.,])\d+(?:[.,]\d+)*/g;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[\w.+-]+@[\w-]+\.[\w.]+\b|\b(?:linkedin|github)\.com\/\S+/gi;

const DEGREES: Array<[RegExp, string]> = [
  [/\bMBA\b/g, 'mba'],
  [/\b(?:Ph\.?\s?D\b\.?|Doctorate|doctorate|Doctor of)/g, 'doctorate'],
  [
    /\b(?:Bachelor(?:'s|s)?|bachelor(?:'s|s)?|B\.\s?[AS]\.|BSc\b|BEng\b|BBA\b|B\.Sc\.?|B\.Eng\.?|(?:BS|BA)(?=[\s,]+(?:in|of|degree)\b|,))/g,
    'bachelor',
  ],
  [
    /\b(?:Master(?:'s|s)\b|master(?:'s|s)\b|Master\s+(?:of|in)\b|M\.\s?[AS]\.|MSc\b|MEng\b|M\.Sc\.?|M\.Eng\.?|(?:MS|MA)(?=[\s,]+(?:in|of|degree)\b))/g,
    'master',
  ],
];
/** A claim of this degree family is supported by any of these in the sources. */
const DEGREE_OK: Record<string, string[]> = { mba: ['mba'], master: ['master', 'mba'], bachelor: ['bachelor'], doctorate: ['doctorate'] };

/** Lowercase, markdown and URLs out, dashes and quotes unified, spaces collapsed. */
export function normFact(s: string): string {
  return stripMd(s)
    .replace(URL_RE, ' ')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const normNumber = (n: string) => (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(n) ? n.replace(/,/g, '') : n);
const numbersOf = (s: string) => [...s.replace(URL_RE, ' ').matchAll(NUMBER_RE)].map((m) => normNumber(m[0]));
const datesOf = (s: string) =>
  [...s.matchAll(DATE_RE)].map((m) => `${MONTHS.find((x) => (m[1] ?? '').toLowerCase().startsWith(x)) ?? m[1]} ${m[2]}`);
const yearsOf = (s: string) => [...numberWordsToDigits(s).matchAll(YEARS_RE)].map((m) => Number(m[1]));
const degreesOf = (s: string) => DEGREES.flatMap(([re, key]) => [...s.matchAll(re)].map((m) => ({ key, text: m[0].trim() })));

const TITLE_NOUN = `(?:Manager|Engineer|Director|Scientist|Analyst|Designer|Architect|Consultant|Officer|President|Founder|Co-?[Ff]ounder|Lead|Owner|Strategist|Researcher)`;
const TITLE_RE = new RegExp(
  String.raw`\b(?:(?:Head|VP|SVP|EVP|Vice President|Director|Chief)\s+of\s+[A-Z][\w&/-]*(?:\s+[A-Z][\w&/-]*){0,2}|(?:[A-Z][\w&/.-]*\s+){0,4}${TITLE_NOUN})\b`,
  'g',
);
/** Capitalized words that open a sentence or clause, not a title. */
const LEAD_WORDS = new Set(
  'a an the as at in on of for my our your their his her i we while when former then now currently also and or with to from by led most recently previously today'.split(
    ' ',
  ),
);
const EMPLOYER_RE = /\b(?:at|joined)\s+((?:[A-Z][\w&.'-]+)(?:\s+(?:[A-Z][\w&.'-]+|&))*)/g;
const NOT_EMPLOYERS = new Set(
  'i ai ml llm api apis sql python scale speed pace the a an this that my our your one both each every least most first last'.split(' '),
);

function trimLead(claim: string): string {
  const words = claim.split(/\s+/);
  while (words.length > 1 && LEAD_WORDS.has((words[0] ?? '').toLowerCase())) words.shift();
  return words.join(' ');
}

/** Lines of a confirmed Story to check against: its text values, years only when stated or confirmed. */
export function storySourceText(story: Record<string, unknown> | null | undefined): string {
  if (!story) return '';
  const skip = new Set([
    'criterion_weights',
    'criteria',
    'dictated',
    'years',
    'years_basis',
    'source_path',
    'source_file',
    'extracted_by',
    'open_questions',
  ]);
  const out: string[] = [];
  const walk = (v: unknown, key?: string) => {
    if (key && skip.has(key)) return;
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      // A role reads as its heading line, so a tailored heading can cite it.
      if (typeof o.company === 'string' && typeof o.title === 'string')
        out.push(`${o.company} - ${o.title}${typeof o.dates === 'string' ? ` - ${o.dates}` : ''}`);
      for (const [k, x] of Object.entries(o)) walk(x, k);
    }
  };
  walk(story);
  const basis = story.years_basis;
  if (typeof story.years === 'number' && (basis === 'stated' || basis === 'confirmed')) out.push(`${story.years} years of experience`);
  return out.join('\n');
}

interface Src {
  lines: Array<{ raw: string; n: string }>;
  text: string;
  numbers: Set<string>;
  dates: Set<string>;
  years: Set<number>;
  degrees: Set<string>;
  decades: boolean;
}

function indexSources(texts: readonly string[]): Src {
  const lines = texts
    .flatMap((t) => t.split(/\r?\n/))
    .map((raw) => ({ raw: raw.trim(), n: normFact(raw) }))
    .filter((l) => l.n);
  const all = texts.join('\n');
  return {
    lines,
    text: lines.map((l) => l.n).join('\n'),
    numbers: new Set(numbersOf(all)),
    dates: new Set(datesOf(all)),
    years: new Set(yearsOf(all)),
    degrees: new Set(degreesOf(all).map((d) => d.key)),
    decades: DECADES_RE.test(all),
  };
}

function cite(src: Src, test: (n: string) => boolean, raw = false): string | undefined {
  return src.lines.find((l) => test(raw ? l.raw : l.n))?.raw;
}

const hasWord = (hay: string, needle: string) => {
  const n = normFact(needle);
  if (!n) return true;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`).test(hay);
};

/** Check every factual claim in `doc` against `sources`. */
export function checkFacts(doc: string, sources: string | readonly string[], opts: FactOptions = {}): FactCheck {
  const src = indexSources(typeof sources === 'string' ? [sources] : sources);
  const ctx = opts.context ? indexSources([opts.context]) : null;
  const headings = opts.headings ?? true;
  const supported: FactClaim[] = [];
  const unsupported: FactClaim[] = [];
  const seen = new Set<string>();
  const add = (c: FactClaim, ok: boolean, source?: string) => {
    const k = `${c.kind}:${c.claim.toLowerCase()}`;
    if (seen.has(k)) return;
    seen.add(k);
    if (ok) supported.push({ ...c, ...(source ? { source } : {}) });
    else unsupported.push(c);
  };

  const body = doc.replace(/^---\n[\s\S]*?\n---\n?/, '');
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^\|?\s*:?-{3,}/.test(line)) continue;
    let rest = stripMd(line.replace(/^#{1,6}\s+/, '').replace(/^(?:[-*+•]|\d+[.)])\s+/, '')).replace(URL_RE, ' ');

    // Role heading: "Company - Title - Dates" on a heading or bold line.
    const isHeading = /^#{1,6}\s/.test(line) || /^\*\*[^*]+\*\*/.test(line);
    const role = headings && isHeading ? parseRoleHeading(line.replace(/^#{1,6}\s+/, '')) : null;
    if (role?.dates) {
      add(
        { kind: 'employer', claim: role.company, line, hard: true },
        hasWord(src.text, role.company),
        cite(src, (n) => hasWord(n, role.company)),
      );
      add(
        { kind: 'title', claim: role.title, line, hard: true },
        hasWord(src.text, role.title),
        cite(src, (n) => hasWord(n, role.title)),
      );
    }

    // Years of experience ("26 years", "ten years", "two decades").
    const digits = numberWordsToDigits(rest);
    for (const m of digits.matchAll(YEARS_RE)) {
      const n = Number(m[1]);
      add(
        { kind: 'years', claim: m[0].trim(), line, hard: true },
        src.years.has(n),
        cite(src, (l) => yearsOf(l).includes(n)),
      );
    }
    if (DECADES_RE.test(rest)) {
      const claim = /\b(?:\w+\s+)?decades?\b/i.exec(rest)?.[0] ?? 'decades';
      add(
        { kind: 'years', claim, line, hard: true },
        src.decades,
        cite(src, (l) => DECADES_RE.test(l)),
      );
    }
    rest = rest.replace(/(?<![\w.])(?:\d{1,2}|[a-z]+(?:-[a-z]+)?)\s*\+?\s*(?:years?|yrs?)\b|\b(?:\w+\s+)?decades?\b/gi, ' ');

    // Month + year dates.
    for (const d of datesOf(rest))
      add(
        { kind: 'date', claim: d, line, hard: true },
        src.dates.has(d),
        cite(src, (l) => datesOf(l).includes(d)),
      );
    rest = rest.replace(DATE_RE, ' ');

    // Degrees.
    for (const d of degreesOf(rest)) {
      const ok = DEGREE_OK[d.key] ?? [d.key];
      add(
        { kind: 'degree', claim: d.text, line, hard: true },
        ok.some((k) => src.degrees.has(k)),
        cite(src, (l) => degreesOf(l).some((x) => ok.includes(x.key)), true),
      );
    }

    // Every other number (years like 2019 included).
    for (const n of numbersOf(rest)) {
      const kind: FactKind = /^(19|20)\d{2}$/.test(n) ? 'year' : 'number';
      const ok = src.numbers.has(n) || (kind === 'number' && !!opts.numbersFromContext && !!ctx?.numbers.has(n));
      add(
        { kind, claim: n, line, hard: true },
        ok,
        cite(src, (l) => numbersOf(l).includes(n)),
      );
    }

    // Titles and employers named in prose (soft).
    if (!role?.dates) {
      for (const m of stripMd(line.replace(/^#{1,6}\s+/, '')).matchAll(TITLE_RE)) {
        const claim = trimLead(m[0].trim());
        if (!new RegExp(`${TITLE_NOUN}$|^(?:Head|VP|SVP|EVP|Vice President|Director|Chief)\\s+of\\b`).test(claim)) continue;
        if (claim.split(/\s+/).length < 2) continue;
        const ok = hasWord(src.text, claim) || (!!ctx && hasWord(ctx.text, claim));
        add(
          { kind: 'title', claim, line, hard: false },
          ok,
          cite(src, (n) => hasWord(n, claim)),
        );
      }
    }
    for (const m of stripMd(line).matchAll(EMPLOYER_RE)) {
      const claim = (m[1] ?? '').replace(/\s+(?:&|of)$/, '').trim();
      if (claim.length < 2 || NOT_EMPLOYERS.has(claim.toLowerCase())) continue;
      if (MONTHS.some((x) => claim.toLowerCase().startsWith(x)) && claim.length <= 9) continue;
      const ok = hasWord(src.text, claim) || (!!ctx && hasWord(ctx.text, claim));
      add(
        { kind: 'employer', claim, line, hard: false },
        ok,
        cite(src, (n) => hasWord(n, claim)),
      );
    }
  }
  return { unsupported, supported };
}

/** The phrase is in the text (normalized, whole words). */
export function inSource(text: string, phrase: string): boolean {
  return hasWord(normFact(text), phrase);
}

/** One line per claim: `"26 years" (years)`. */
export function describeClaims(claims: readonly FactClaim[]): string {
  return claims.map((c) => `"${c.claim}" (${c.kind})`).join(', ');
}
