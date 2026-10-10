/*
 * Resume -> Story + Craft drafts.
 *
 * Judgment belongs to a model: the headless `onboard` run extracts the facts verbatim (onboard.extract),
 * or an injected `ProfileLlm.parseResume`. This heuristic parser is only the instant preview shown
 * while that runs (and what tests use). It never invents and never infers a number: every value is
 * copied from the text. Years of experience only when the resume states it (`years_basis: 'stated'`),
 * or from the role dates (`'from dates'`), which the interview asks the user to confirm (#38).
 */
import { numberWordsToDigits } from '@perfect-placement/contracts';

export interface ResumeDraft {
  story: Record<string, unknown>;
  craft: Record<string, unknown>;
}

interface Section {
  heading: string;
  level: number;
  lines: string[];
}

const SECTION_WORDS =
  /^(experience|work experience|work history|employment|professional experience|skills|skills & toolkit|toolkit|education|education & continuous learning|summary|profile|about|recognition|awards|projects)\b/i;

function splitSections(text: string): Section[] {
  const out: Section[] = [{ heading: '', level: 0, lines: [] }];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const md = /^(#{1,6})\s+(.*)$/.exec(line);
    if (md) {
      out.push({ heading: (md[2] ?? '').trim(), level: md[1]?.length ?? 1, lines: [] });
      continue;
    }
    const bare = line.trim();
    if (bare && bare.length < 48 && (SECTION_WORDS.test(bare) || (/^[A-Z][A-Z &/]+$/.test(bare) && bare.length > 3))) {
      out.push({ heading: bare, level: 2, lines: [] });
      continue;
    }
    out.at(-1)?.lines.push(line);
  }
  return out;
}

export function stripMd(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}

export function bullets(lines: string[]): string[] {
  return lines
    .map((l) => /^\s*(?:[-*+•]|\d+\.)\s+(.*)$/.exec(l)?.[1])
    .filter((b): b is string => !!b)
    .map(stripMd);
}

function paragraph(lines: string[]): string {
  return lines
    .filter((l) => l.trim() && !/^\s*(?:[-*+•]|\d+\.)\s+/.test(l) && !l.trim().startsWith('>'))
    .map(stripMd)
    .join(' ')
    .trim();
}

const DASH = /\s+[—–|]\s+|\s+-\s+/;

/** "Company — Title — Dates" (any of em/en dash, pipe, spaced hyphen). */
export function parseRoleHeading(h: string): { company: string; title: string; dates?: string } | null {
  const parts = stripMd(h)
    .split(DASH)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const datesIdx = parts.findIndex((p) => /(19|20)\d{2}|present/i.test(p));
  const dates = datesIdx >= 0 ? parts[datesIdx] : undefined;
  const rest = parts.filter((_, i) => i !== datesIdx);
  if (rest.length < 2) return null;
  return { company: rest[0] ?? '', title: rest.slice(1).join(' - '), ...(dates ? { dates } : {}) };
}

const FUNCTION_PATTERNS: Array<[RegExp, string]> = [
  [/technical program manag|\bTPM\b/i, 'TPM'],
  [/product manag|\bPM\b|product lead|head of product|product leader|chief product|\bCPO\b|product owner/i, 'PM'],
  [/forward[- ]deployed|\bFDE\b/i, 'FDE'],
  [/data scien/i, 'Data Science'],
  [/engineer|developer/i, 'Engineering'],
  [/founder/i, 'Founder'],
  // #74: not only product people.
  [/account executive|\bsales\b|\bBDR\b|\bSDR\b/i, 'Sales'],
  [/account manag/i, 'Account Management'],
  [/business development|partnerships/i, 'Business Development'],
  [/marketing/i, 'Marketing'],
  [/designer/i, 'Design'],
  [/customer success/i, 'Customer Success'],
];

const LEVELS: Array<[RegExp, string]> = [
  [/\b(vp|vice president)\b/i, 'vp'],
  [/\bhead of\b/i, 'head'],
  [/\bdirector\b/i, 'director'],
  [/\bgroup\b/i, 'group'],
  [/\bprincipal\b/i, 'principal'],
  [/\bstaff\b/i, 'staff'],
  [/\b(senior|sr\.?)\b/i, 'senior'],
  [/\blead\b/i, 'lead'],
];

export function parseResumeHeuristic(text: string, now: Date = new Date()): ResumeDraft {
  const sections = splitSections(text);
  const story: Record<string, unknown> = {};
  const craft: Record<string, unknown> = {};

  const titleLine = /\*\*Title:\*\*\s*(.+)$/im.exec(text)?.[1];
  const h1 = sections.find((s) => s.level === 1)?.heading;
  const headline = titleLine ? stripMd(titleLine) : undefined;
  if (headline) story.headline = headline;
  else if (h1) story.headline = stripMd(h1.split(DASH).slice(1).join(' ') || h1);

  const summarySec = sections.find((s) => /^(profile|summary|about)\b/i.test(s.heading));
  if (summarySec) {
    const p = paragraph(summarySec.lines);
    if (p) story.summary = p;
  }

  const roles: Array<{ company: string; title: string; dates?: string; summary?: string; bullets: string[] }> = [];
  for (const s of sections) {
    const r = s.heading ? parseRoleHeading(s.heading) : null;
    if (!r || (s.level < 3 && !r.dates)) continue;
    const summary = paragraph(s.lines);
    roles.push({ ...r, ...(summary ? { summary } : {}), bullets: bullets(s.lines) });
  }
  if (roles.length) story.roles = roles;

  const wins = roles.flatMap((r) => r.bullets).filter((b) => /\d/.test(b));
  if (wins.length) story.wins = wins.slice(0, 8);

  const listOf = (re: RegExp) => {
    const sec = sections.find((s) => re.test(s.heading));
    if (!sec) return undefined;
    const b = bullets(sec.lines);
    return b.length ? b : sec.lines.map(stripMd).filter(Boolean);
  };
  const skills = listOf(/skill|toolkit/i);
  if (skills) story.skills = skills;
  const education = listOf(/education/i);
  if (education) story.education = education;

  const stated = statedYears(text);
  const fromDates = stated === null ? yearsFromDates(roles, now) : null;
  if (stated !== null) {
    story.years = stated;
    story.years_basis = 'stated';
  } else if (fromDates !== null) {
    story.years = fromDates;
    story.years_basis = 'from dates';
  }
  const contact = parseContact(text);
  if (Object.keys(contact).length) story.contact = contact;
  story.extracted_by = 'preview';

  const titles = [headline ?? '', ...roles.map((r) => r.title)].filter(Boolean);
  const functions = [...new Set(titles.flatMap((t) => FUNCTION_PATTERNS.filter(([re]) => re.test(t)).map(([, f]) => f)))];
  if (functions.length) craft.functions = functions;
  const top = titles[0] ?? '';
  const level = LEVELS.find(([re]) => re.test(top))?.[1];
  if (level) craft.level = level;
  if (/player[- ]coach/i.test(text)) craft.mode = 'either';
  else if (level && ['vp', 'head', 'director', 'group'].includes(level)) craft.mode = 'lead';
  else if (level) craft.mode = 'ic';

  return { story, craft };
}

/**
 * Years of experience the resume states ("10+ years of experience", "Ten years across ..."), or null.
 * Only a number directly followed by "years" counts; nothing is computed.
 */
export function statedYears(text: string): number | null {
  const m = /\b(\d{1,2})\s*\+?\s*(?:years?|yrs?)\s+(?:of|in|across|leading|building|shipping|working|as|experience)\b/i.exec(
    numberWordsToDigits(text),
  );
  return m ? Number(m[1]) : null;
}

const YEAR = /\b(19[5-9]\d|20\d{2})\b/g;
const PRESENT = /\b(present|current|now|today)\b/i;

/**
 * Years spanned by the explicit role dates: first start year to the last end year (or now for "Present").
 * Null when no role has a date. A derivation, so the interview asks the user to confirm it.
 */
export function yearsFromDates(roles: ReadonlyArray<{ dates?: string }>, now: Date = new Date()): number | null {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const r of roles) {
    const ys = [...(r.dates ?? '').matchAll(YEAR)].map((m) => Number(m[1]));
    if (!ys.length) continue;
    starts.push(Math.min(...ys));
    ends.push(PRESENT.test(r.dates ?? '') ? now.getUTCFullYear() : Math.max(...ys));
  }
  if (!starts.length) return null;
  return Math.max(0, Math.max(...ends) - Math.min(...starts));
}

// ------------------------------------------------------------------ identity (#124)

/** Lines of the resume header: everything before the first section heading or role line, at most 8. */
function headerLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const md = /^(#{1,6})\s+(.*)$/.exec(line);
    if (md && (md[1]?.length ?? 1) > 1) break;
    if (!md && line.length < 48 && SECTION_WORDS.test(line)) break;
    out.push(md ? (md[2] ?? '') : line);
    if (out.length >= 8) break;
  }
  return out;
}

const NAME_WORD =
  /^(?:[A-Z][a-z'’-]*\.?|[A-Z][a-z]*[A-Z][a-z'’-]+|(?:de|da|del|della|der|di|du|la|le|van|von|bin|al|y|dos|das)|(?:Jr|Sr)\.?|II|III|IV)$/;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/;
const LINKEDIN_RE = /\b(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[\w-]+\/?/i;
const PHONE_RE = /(?<![\w/])\+?\(?\d[\d .()-]{8,18}\d(?![\w/])/g;
/** "Springfield, IL", "Austin, TX 78701", "Lyon, France", "New York, NY". */
const CITY_RE = /^([A-Z][A-Za-z'’.-]*(?: [A-Z][A-Za-z'’.-]*){0,3}), ([A-Z]{2}(?: \d{5})?|[A-Z][a-z]+(?: [A-Z][a-z]+){0,2})$/;

/** Words that make "Staff Engineer, Payments" a title, not a "City, Region". */
const JOB_WORDS =
  /\b(engineer|engineering|manager|director|lead|product|designer|analyst|scientist|head|officer|president|founder|consultant|developer|architect|specialist|executive|sales|marketing|data|platform|platforms|remote|hybrid)\b/i;

/** A plain name line: 2 to 5 capitalized words, no digits or symbols ("Alex J. Rivera", "Ana de la Cruz"). */
export function nameOf(line: string): string | null {
  const s = stripMd(line).trim();
  if (!s || s.length > 60 || /[\d@/:|•·]/.test(s) || SECTION_WORDS.test(s)) return null;
  const words = s.split(/\s+/);
  if (words.length < 2 || words.length > 5 || !/^[A-Z]/.test(words[0] ?? '') || !words.every((w) => NAME_WORD.test(w))) return null;
  return s;
}

/** A phone number: 10 to 15 digits, not a year range or a date. */
function phoneOf(line: string): string | null {
  for (const m of line.matchAll(PHONE_RE)) {
    const v = m[0].trim().replace(/[.-]$/, '');
    const digits = v.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) continue;
    if (/\b(19|20)\d{2}\s*[-–]\s*(19|20)\d{2}\b/.test(v)) continue;
    return v;
  }
  return null;
}

/**
 * Identity from the resume header (#124), copied as written; only where the pattern is reliable: the name
 * line (the first header line, or the part of a "# Name - Title" heading before the dash), an email, a
 * phone of 10 to 15 digits, a LinkedIn URL, and a "City, ST" / "City, Country" segment of a contact line.
 * Never a preferred name (the interview asks it). The onboard agent's extraction replaces it.
 */
export function parseContact(text: string): Record<string, string> {
  const lines = headerLines(text);
  const out: Record<string, string> = {};
  const first = lines[0];
  if (first) {
    const name = nameOf(first.split(DASH)[0] ?? '');
    if (name) out.full_name = name;
  }
  for (const line of lines) {
    const plain = stripMd(line);
    const email = EMAIL_RE.exec(plain)?.[0];
    const linkedin = LINKEDIN_RE.exec(plain)?.[0];
    const phone = phoneOf(plain);
    if (email) out.email ??= email;
    if (linkedin) out.linkedin ??= linkedin;
    if (phone) out.phone ??= phone;
    // A city only on a contact line (an email, phone, link or separators), so a title line is never one.
    if (!out.city && (email || phone || linkedin || /[|•·]/.test(plain))) {
      const parts = plain
        .split(/\s*[|•·]\s*|\s+[—–]\s+|\s+-\s+/)
        .map((p) => p.trim())
        .filter(Boolean);
      const city = parts.find((p) => CITY_RE.test(p) && !EMAIL_RE.test(p) && !JOB_WORDS.test(p));
      if (city) out.city = city;
    }
  }
  return out;
}
