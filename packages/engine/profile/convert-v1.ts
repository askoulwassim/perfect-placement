import { CRITERIA, type Criterion, PROFILE_COMPONENT_KEYS, type ProfileComponentKey } from '@perfect-placement/contracts';
import {
  CRITERION_OWNER,
  NEUTRAL_WEIGHTS,
  normalizeWeights,
  parseComponentData,
  type V1Section,
  weightsByComponent,
} from './components.js';
import { renderComponentMd } from './markdown.js';
import { parseResumeHeuristic, stripMd } from './resume.js';

/*
 * v1 profile converter: v1 01_Profile/*.md + 00_System/rubric.{json,md} -> the 11 v2 components.
 * Lane A calls `convertV1Profile` during `pp migrate` and writes the result as profile v1.
 *
 * Guarantee: nothing is dropped. Every markdown section is kept verbatim in its routed
 * component's `v1_sections` (Story/Voice also land in profile/<key>.md), structured fields
 * are extracted on top, and `verifyCoverage` checks every non-empty source line and every
 * rubric.json leaf is present in the output. Built against the v1 files' SHAPE only; the
 * repo's tests use synthetic inputs.
 */

export interface V1Inputs {
  perfect_role?: string;
  rubric_json?: string;
  rubric_md?: string;
  positioning?: string;
  application_defaults?: string;
  stories?: string;
  resume_master?: string;
}
export type V1Source = keyof V1Inputs;

/** v1 file names, relative to the v1 repo root. */
export const V1_FILES: Record<V1Source, string> = {
  perfect_role: '01_Profile/perfect_role.md',
  rubric_json: '00_System/rubric.json',
  rubric_md: '00_System/rubric.md',
  positioning: '01_Profile/positioning.md',
  application_defaults: '01_Profile/application_defaults.md',
  stories: '01_Profile/stories.md',
  resume_master: '01_Profile/resume_master.md',
};

export interface MappingEntry {
  source: V1Source;
  /** Heading path for markdown, JSON path for rubric.json. */
  locator: string;
  /** Destinations, e.g. `terms.comp_floor`, `craft.v1_sections`, `config.scoring.green_min`. */
  to: string[];
  note?: string;
}

export interface ConvertedComponent {
  key: ProfileComponentKey;
  confidence: number;
  weight: number | null;
  data_json: Record<string, unknown>;
  /** Long-form markdown body for Story/Voice (frontmatter id is filled by the writer). */
  markdown: string | null;
}

export interface V1Conversion {
  components: Record<ProfileComponentKey, ConvertedComponent>;
  /** profile_version.reason for the imported version. */
  version_reason: string;
  /** Values that belong in config.json, not the profile. */
  config: { scoring?: { green_min?: number; yellow_min?: number } };
  /** Metadata about the v1 files themselves (not profile content). */
  provenance: Record<string, unknown>;
  report: MappingEntry[];
  /** Where v2 rules change v1 behavior (decisions.md). */
  behavior_changes: string[];
  /** Things a human should confirm. */
  questions: string[];
}

// ---------------------------------------------------------------------------
// Markdown structure
// ---------------------------------------------------------------------------

export interface MdSection {
  heading: string;
  level: number;
  path: string[];
  lines: string[];
}

export function parseSections(md: string): MdSection[] {
  const out: MdSection[] = [{ heading: '', level: 0, path: [], lines: [] }];
  const stack: Array<{ level: number; heading: string }> = [];
  let fence = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fence = !fence;
    const h = fence ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = h[1]?.length ?? 1;
      const heading = (h[2] ?? '').trim();
      while (stack.length && (stack.at(-1)?.level ?? 0) >= level) stack.pop();
      stack.push({ level, heading });
      out.push({ heading, level, path: stack.map((s) => s.heading), lines: [] });
      continue;
    }
    out.at(-1)?.lines.push(line);
  }
  return out.filter((s) => s.heading || s.lines.some((l) => l.trim()));
}

export interface Bullet {
  label?: string;
  text: string;
  raw: string;
}

/** List items (with indented continuation lines). `**Label:** text` and `**Label** - text` split out. */
export function parseBullets(lines: string[]): Bullet[] {
  const out: Bullet[] = [];
  for (const line of lines) {
    const m = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (m) {
      out.push(splitLabel(m[1] ?? '', line));
      continue;
    }
    const last = out.at(-1);
    if (last && /^\s{2,}\S/.test(line)) {
      last.text = `${last.text} ${line.trim()}`;
      last.raw = `${last.raw}\n${line}`;
    }
  }
  return out;
}

function splitLabel(s: string, raw: string): Bullet {
  const m = /^\*\*(.+?)\*\*\s*[:.]?\s*(?:[—–-]\s*)?(.*)$/.exec(s.trim());
  if (m?.[1]) {
    const label = m[1].replace(/:$/, '').trim();
    return { label, text: stripMd(m[2] ?? ''), raw };
  }
  return { text: stripMd(s), raw };
}

/** Pipe tables -> header + rows (separator rows skipped). */
export function parseTable(lines: string[]): { header: string[]; rows: string[][] } | null {
  const rows = lines
    .filter((l) => /^\s*\|.*\|\s*$/.test(l))
    .map((l) =>
      l
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim()),
    )
    .filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c)));
  if (!rows.length) return null;
  return { header: rows[0] ?? [], rows: rows.slice(1) };
}

function sectionText(s: MdSection): string {
  return s.lines.join('\n').trim();
}

function firstParagraph(lines: string[]): string {
  return stripMd(
    lines
      .map((l) => l.replace(/^\s*>\s?/, ''))
      .join('\n')
      .trim()
      .split(/\n\s*\n/)[0] ?? '',
  )
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** Keyword routes for a labeled bullet / free text, first match wins. */
const KEYWORD_ROUTES: Array<[RegExp, ProfileComponentKey]> = [
  [/dealbreaker|hard no|auto-pass/i, 'dealbreakers'],
  [/\bremote\b|hybrid|onsite|on-site|relocat|in-office|location|travel/i, 'work_mode'],
  [/\bcomp\b|salary|\bbase\b|equity|bonus|\$\d/i, 'terms'],
  [/\bfde\b|forward deployed|role shape|primary|adjacent|ic-depth|director-level|building\/deciding/i, 'craft'],
  [/facing|external|revenue|customer/i, 'craft'],
  [/team|founder|leader|layer|decision/i, 'team'],
  [/stage|startup|series|company|companies/i, 'company'],
  [/domain|industr|space|infra|dev-tools|frontier|data fundamentals/i, 'domain'],
  [/growth|ceiling|learning|trajectory/i, 'growth'],
  [/voice|writing|pitch|positioning/i, 'voice'],
  [/network|warm|intro|referral/i, 'network'],
];

export function routeText(text: string, fallback: ProfileComponentKey): ProfileComponentKey {
  return KEYWORD_ROUTES.find(([re]) => re.test(text))?.[1] ?? fallback;
}

/** Get `obj[key]`, initializing it to `init` when absent. */
function ensure(obj: Record<string, unknown>, key: string, init: unknown): unknown {
  if (obj[key] === undefined) obj[key] = init;
  return obj[key];
}

type Draft = Record<ProfileComponentKey, Record<string, unknown>>;

class Builder {
  readonly draft = Object.fromEntries(PROFILE_COMPONENT_KEYS.map((k) => [k, {}])) as Draft;
  readonly report: MappingEntry[] = [];
  readonly behavior: string[] = [];
  readonly questions: string[] = [];
  readonly config: V1Conversion['config'] = {};
  readonly provenance: Record<string, unknown> = {};

  keep(key: ProfileComponentKey, source: V1Source, s: MdSection): string {
    const list = ensure(this.draft[key], 'v1_sections', []) as V1Section[];
    list.push({ source: V1_FILES[source], heading: s.path.join(' > ') || '(preamble)', text: sectionText(s) });
    return `${key}.v1_sections`;
  }
  push(key: ProfileComponentKey, field: string, ...items: unknown[]): string {
    const arr = ensure(this.draft[key], field, []) as unknown[];
    for (const i of items) if (!arr.some((x) => JSON.stringify(x) === JSON.stringify(i))) arr.push(i);
    return `${key}.${field}`;
  }
  set(key: ProfileComponentKey, field: string, value: unknown): string {
    if (value !== undefined && value !== '' && this.draft[key][field] === undefined) this.draft[key][field] = value;
    return `${key}.${field}`;
  }
  map(source: V1Source, locator: string, to: string[], note?: string) {
    this.report.push({ source, locator, to: [...new Set(to)], ...(note ? { note } : {}) });
  }
}

const loc = (s: MdSection) => s.path.join(' > ') || '(preamble)';
const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function money(s: string): number[] {
  const out: number[] = [];
  for (const m of s.matchAll(/\$\s?(\d{2,3}(?:[.,]\d+)?)\s*(?:[–-]\s*\$?(\d{2,3}(?:[.,]\d+)?))?\s*[kK]/g)) {
    out.push(Math.round(Number((m[1] ?? '').replace(',', '.')) * 1000));
    if (m[2]) out.push(Math.round(Number(m[2].replace(',', '.')) * 1000));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-file converters
// ---------------------------------------------------------------------------

function convertPerfectRole(b: Builder, md: string) {
  for (const s of parseSections(md)) {
    const h = s.heading.toLowerCase();
    const to: string[] = [];
    const bl = parseBullets(s.lines);
    let primary: ProfileComponentKey = 'craft';
    if (!s.heading || s.level === 1) primary = 'craft';
    else if (/one-line target|target definition/.test(h)) {
      primary = 'craft';
      to.push(b.set('craft', 'target', firstParagraph(s.lines)));
    } else if (/role shape/.test(h)) {
      primary = 'craft';
      for (const x of bl) {
        const lab = (x.label ?? '').toLowerCase();
        if (/primary/.test(lab)) {
          if (/product manag/i.test(x.text)) to.push(b.push('craft', 'functions', 'PM'));
          to.push(b.push('craft', 'notes', `Primary: ${x.text}`));
        } else if (/adjacent/.test(lab)) {
          const list = x.text.split(/[;,]|\bpossibly\b/)[0] ?? x.text;
          to.push(
            b.push(
              'craft',
              'adjacent',
              ...list
                .split('/')
                .map((t) => t.replace(/roles?|focused|-/gi, ' ').trim())
                .filter(Boolean),
            ),
          );
          to.push(b.push('craft', 'notes', `Adjacent: ${x.text}`));
        } else if (/forward deployed|fde/.test(lab)) {
          to.push(b.push('craft', /not sold|explore|curious/i.test(x.text) ? 'explore' : 'adjacent', 'FDE'));
          to.push(b.push('craft', 'notes', `${x.label}: ${x.text}`));
        } else to.push(b.push(routeText(`${x.label ?? ''} ${x.text}`, 'craft'), 'notes', x.label ? `${x.label}: ${x.text}` : x.text));
      }
    } else if (/hard constraint/.test(h)) {
      primary = 'work_mode';
      const t = bl.map((x) => `${x.label ?? ''} ${x.text}`).join(' ');
      if (/\bremote\b/i.test(t)) to.push(b.set('work_mode', 'modes', ['remote']));
      if (/not open to[^.]*relocat/i.test(t)) to.push(b.set('work_mode', 'relocation', 'no'));
      for (const x of bl) to.push(b.push('work_mode', 'notes', x.label ? `${x.label}: ${x.text}` : x.text));
    } else if (/dealbreaker/.test(h)) {
      primary = 'dealbreakers';
      for (const x of bl) to.push(b.push('dealbreakers', 'hard_nos', x.label ? `${x.label}: ${x.text}` : x.text));
    } else if (/still open|open question|ask me/.test(h)) {
      primary = 'craft';
      for (const x of bl) to.push(b.push(routeText(x.text, 'craft'), 'open_questions', x.text));
    } else if (/target company/.test(h)) {
      primary = 'company';
      for (const x of bl) to.push(b.push('company', 'notes', x.text));
    } else if (/target space/.test(h)) {
      primary = 'domain';
      const body = s.lines.join(' ');
      const ranked = (b.draft.domain.ranked as string[] | undefined) ?? [];
      const pull =
        /pull\s*=\s*\*\*(.+?)\*\*/i.exec(body)?.[1] ?? (ranked.length ? undefined : /sweet spot\s*=\s*\*\*(.+?)\*\*/i.exec(body)?.[1]);
      if (pull) to.push(b.push('domain', 'ranked', ...pull.split(/\s*\/\s*/).map((x) => x.replace(/\s+companies$/i, '').trim())));
      const refs = /companies[^:]*:\s*([^.(]+)/i.exec(stripMd(body))?.[1];
      if (refs)
        to.push(
          b.push(
            'company',
            'reference_companies',
            ...refs
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean),
          ),
        );
      to.push(b.push('domain', 'notes', firstParagraph(s.lines)));
    } else {
      // "What excites me", "Calibration confirmed" and anything else: route bullet by bullet.
      primary = /excite/.test(h) ? 'domain' : 'craft';
      for (const x of bl) to.push(...routeLabeled(b, x));
    }
    to.push(b.keep(primary, 'perfect_role', s));
    b.map('perfect_role', loc(s), to);
  }
}

/** Calibration-style `**Label:** text` bullets, with structured extraction where the shape is clear. */
function routeLabeled(b: Builder, x: Bullet): string[] {
  const to: string[] = [];
  const lab = (x.label ?? '').toLowerCase();
  const all = `${x.label ?? ''} ${x.text}`;
  const key = routeText(x.label ?? x.text, routeText(x.text, 'craft'));
  const note = x.label ? `${x.label}: ${x.text}` : x.text;
  if (/facing/.test(lab)) {
    if (/external/i.test(x.text)) to.push(b.set('craft', 'facing', 'external'));
    to.push(b.push('craft', 'notes', note));
  } else if (/^comp/.test(lab) || (key === 'terms' && money(all).length)) {
    const m = money(x.text);
    const floorM = /floor[^$]*(\$\s?\d+[^;,.]*[kK])/i.exec(x.text)?.[1];
    const targetM = /target[^$]*(\$\s?\d+\s*(?:[–-]\s*\d+)?\s*[kK])/i.exec(x.text)?.[1];
    if (floorM) to.push(b.set('terms', 'comp_floor', money(floorM)[0]));
    if (targetM) {
      const t = money(targetM);
      to.push(b.set('terms', 'comp_target', t[0]));
      if (t[1]) to.push(b.set('terms', 'comp_target_max', t[1]));
    }
    if (m.length) to.push(b.set('terms', 'currency', 'USD'));
    to.push(b.push('terms', 'notes', note));
  } else if (/^stage/.test(lab)) {
    if (/stage-agnostic|any stage/i.test(x.text)) to.push(b.set('company', 'stages', ['any']));
    to.push(b.push('company', 'notes', note));
    if (/pull\s*=/i.test(x.raw)) {
      const pull = /pull\s*=\s*\*\*(.+?)\*\*/i.exec(x.raw)?.[1];
      if (pull) to.push(b.push('domain', 'ranked', ...pull.split(/\s*\/\s*/).map((t) => t.trim())));
    }
  } else if (/^remote/.test(lab)) {
    if (/remote default|remote-first|remote only/i.test(x.text)) to.push(b.set('work_mode', 'modes', ['remote']));
    to.push(b.push('work_mode', 'notes', note));
  } else if (/fde|forward deployed/.test(lab)) {
    to.push(b.push('craft', 'explore', 'FDE'));
    to.push(b.push('craft', 'notes', note));
  } else if (/role shape/.test(lab)) {
    if (/pm-core|product manag/i.test(x.text)) to.push(b.push('craft', 'functions', 'PM'));
    to.push(b.push('craft', 'notes', note));
  } else {
    to.push(b.push(key, 'notes', note));
  }
  return to;
}

function convertRubricJson(b: Builder, raw: string) {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    b.questions.push('rubric.json is not valid JSON; kept verbatim in provenance.');
    b.provenance.rubric_json_raw = raw;
    b.map('rubric_json', '$', ['provenance.rubric_json_raw'], 'invalid JSON');
    return;
  }
  const seen = new Set<string>();
  const m = (path: string, to: string[], note?: string) => {
    seen.add(path);
    b.map('rubric_json', path, to, note);
  };

  for (const k of ['version', 'updated', 'note'] as const) {
    if (k in j) {
      b.provenance[`rubric_${k}`] = j[k];
      m(k, [`provenance.rubric_${k}`], k === 'note' ? 'describes the v1 file itself, not a preference' : undefined);
    }
  }
  const weights = (j.weights ?? {}) as Record<string, number>;
  const w: Record<Criterion, number> = { ...NEUTRAL_WEIGHTS };
  for (const [ck, v] of Object.entries(weights)) {
    const c = ck.toLowerCase() as Criterion;
    if (!CRITERIA.includes(c)) {
      b.provenance[`rubric_weight_${ck}`] = v;
      m(`weights.${ck}`, [`provenance.rubric_weight_${ck}`], 'unknown criterion');
      continue;
    }
    w[c] = v;
    m(`weights.${ck}`, [`${CRITERION_OWNER[c]}.criterion_weights.${c}`, `${CRITERION_OWNER[c]}.weight`]);
  }
  if (Object.keys(weights).length) {
    const total = Object.values(weights).reduce((s, v) => s + v, 0);
    if (total !== 100) b.questions.push(`rubric.json weights sum to ${total}, normalized to 100.`);
    const byComp = weightsByComponent(normalizeWeights(w));
    for (const key of PROFILE_COMPONENT_KEYS) {
      if (Object.keys(byComp[key].criterion_weights).length) b.draft[key].criterion_weights = byComp[key].criterion_weights;
    }
  }
  const criteria = (j.criteria ?? {}) as Record<string, string>;
  for (const [ck, label] of Object.entries(criteria)) {
    const c = ck.toLowerCase() as Criterion;
    const owner = CRITERIA.includes(c) ? CRITERION_OWNER[c] : 'craft';
    upsertCriterion(b, c, { label });
    m(`criteria.${ck}`, [`${owner}.criteria[${c}].label`]);
  }
  const bands = (j.bands ?? {}) as Record<string, number>;
  for (const [bk, v] of Object.entries(bands)) {
    b.config.scoring ??= {};
    (b.config.scoring as Record<string, number>)[bk] = v;
    m(`bands.${bk}`, [`config.scoring.${bk}`], 'scoring config, not a profile component');
  }
  if (typeof j.decision_rule === 'string') {
    m(
      'decision_rule',
      [b.push('dealbreakers', 'notes', `v1 decision rule: ${j.decision_rule}`)],
      'v2 adds held (company cap); lane F owns the rule',
    );
  }
  const db = (j.dealbreakers ?? {}) as Record<string, unknown>;
  for (const [dk, v] of Object.entries(db)) {
    const p = `dealbreakers.${dk}`;
    if (dk === 'remote_required_unless_dream_co') {
      const to = [
        b.set('work_mode', 'modes', v ? ['remote'] : undefined),
        b.push('dealbreakers', 'rules', { text: 'Not remote', auto_archive: Boolean(v) }),
        b.push('dealbreakers', 'hard_nos', 'not remote'),
      ];
      b.behavior.push(
        'v1 let dream companies bypass the remote dealbreaker. v2 removes the bypass (decisions.md #5): dream companies get a capped affinity nudge (max +5) instead, so non-remote roles at dream companies now archive.',
      );
      m(p, to, 'dream-company bypass removed in v2');
    } else if (dk === 'comp_floor' && typeof v === 'number') {
      m(p, [b.set('terms', 'comp_floor', v), b.set('terms', 'currency', 'USD')]);
    } else if (dk === 'comp_heavy_penalty_below' && typeof v === 'number') {
      m(p, [b.set('terms', 'comp_penalty_below', v)]);
    } else {
      m(p, [b.push('dealbreakers', 'notes', `${dk}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)]);
    }
  }
  const dream = (j.dream_companies ?? []) as string[];
  if (dream.length) {
    const to = [b.push('company', 'dream_companies', ...dream)];
    const aff = ensure(b.draft.company, 'affinity', {}) as Record<string, number>;
    for (const d of dream) aff[slugify(d)] = 3;
    to.push('company.affinity');
    m('dream_companies', to, 'affinity +3 each (capped nudge; confirm)');
    b.questions.push(
      `Dream companies (${dream.join(', ')}) now give a capped affinity nudge. Default +3 each; pick a value from -5 to +5.`,
    );
  }
  for (const k of Object.keys(j)) {
    if (['version', 'updated', 'note', 'weights', 'criteria', 'bands', 'decision_rule', 'dealbreakers', 'dream_companies'].includes(k))
      continue;
    b.provenance[`rubric_${k}`] = j[k];
    m(k, [`provenance.rubric_${k}`], 'unrecognized key, kept as provenance');
  }
  void seen;
}

function upsertCriterion(b: Builder, c: Criterion, patch: { label?: string; weight?: number; anchors?: Record<string, string> }) {
  if (!CRITERIA.includes(c)) return;
  const owner = CRITERION_OWNER[c];
  const list = ensure(b.draft[owner], 'criteria', []) as Array<{
    id: Criterion;
    label: string;
    weight?: number;
    anchors?: Record<string, string>;
  }>;
  let item = list.find((x) => x.id === c);
  if (!item) {
    item = { id: c, label: patch.label ?? c };
    list.push(item);
  }
  if (patch.label && (item.label === c || !item.label)) item.label = patch.label;
  if (patch.weight != null) item.weight = patch.weight;
  if (patch.anchors) item.anchors = { ...(item.anchors ?? {}), ...patch.anchors };
}

function convertRubricMd(b: Builder, md: string) {
  for (const s of parseSections(md)) {
    const h = s.heading.toLowerCase();
    const to: string[] = [];
    let primary: ProfileComponentKey = 'dealbreakers';
    const bl = parseBullets(s.lines);
    if (/how scoring works|band/.test(h)) {
      primary = 'dealbreakers';
      to.push('config.scoring (bands; see rubric.json)');
    } else if (/dream/.test(h)) {
      primary = 'company';
      for (const x of bl) {
        const name = (x.label ?? x.text).split(/\s[(—–-]/)[0]?.trim() ?? '';
        if (!name || /^_|add more/i.test(name)) continue;
        to.push(b.push('company', 'dream_companies', name));
        to.push(b.push('company', 'notes', `Dream company: ${x.label ? `${x.label} ${x.text}` : x.text}`));
      }
    } else if (/dealbreaker/.test(h)) {
      primary = 'dealbreakers';
      for (const x of bl) {
        const text = x.label ? `${x.label} ${x.text}` : x.text;
        to.push(b.push('dealbreakers', 'rules', { text }));
      }
    } else if (/criteria|weights/.test(h)) {
      primary = 'craft';
      const t = parseTable(s.lines);
      for (const row of t?.rows ?? []) {
        const n = Number(row[0]);
        const c = `c${n}` as Criterion;
        if (!CRITERIA.includes(c)) continue;
        const anchors: Record<string, string> = {};
        (t?.header ?? []).forEach((hd, i) => {
          const k = /^\s*(\d)\b/.exec(stripMd(hd))?.[1];
          if (k && i > 2 && row[i]) anchors[k] = stripMd(row[i] ?? '');
        });
        upsertCriterion(b, c, { label: stripMd(row[1] ?? ''), weight: Number(row[2]), anchors });
        to.push(`${CRITERION_OWNER[c]}.criteria[${c}]`);
        const jw = (b.draft[CRITERION_OWNER[c]].criterion_weights as Record<string, number> | undefined)?.[c];
        if (jw != null && Number(row[2]) !== jw)
          b.questions.push(`${c.toUpperCase()} weight differs: rubric.md ${row[2]} vs rubric.json (normalized) ${jw}. Using rubric.json.`);
      }
    } else if (/calibration/.test(h)) {
      primary = 'craft';
      for (const x of bl) to.push(...routeLabeled(b, x));
    } else if (/change ?log/.test(h)) {
      primary = 'company';
    } else if (!s.heading || s.level === 1) {
      primary = 'dealbreakers';
    } else {
      primary = routeText(s.heading, 'dealbreakers');
    }
    to.push(b.keep(primary, 'rubric_md', s));
    b.map('rubric_md', loc(s), to);
  }
}

function convertPositioning(b: Builder, md: string) {
  for (const s of parseSections(md)) {
    const h = s.heading.toLowerCase();
    const to: string[] = [];
    let primary: ProfileComponentKey = 'voice';
    const bl = parseBullets(s.lines);
    if (/core positioning/.test(h)) to.push(b.set('voice', 'positioning', firstParagraph(s.lines)));
    else if (/differentiator/.test(h))
      to.push(b.push('voice', 'differentiators', ...bl.map((x) => (x.label ? `${x.label}: ${x.text}` : x.text))));
    else if (/proof/.test(h)) {
      for (const row of parseTable(s.lines)?.rows ?? [])
        to.push(b.push('voice', 'proof_points', { claim: stripMd(row[0] ?? ''), evidence: stripMd(row[1] ?? '') }));
    } else if (/gap|strengthen/.test(h)) {
      primary = 'story';
      to.push(b.push('story', 'gaps', ...bl.map((x) => x.text)));
    } else if (/pitch/.test(h)) {
      const p = ensure(b.draft.voice, 'pitches', {}) as Record<string, string>;
      for (const x of bl) if (x.label) p[x.label] = x.text.replace(/^"|"$/g, '');
      to.push('voice.pitches');
    }
    to.push(b.keep(primary, 'positioning', s));
    b.map('positioning', loc(s), to);
  }
}

function convertDefaults(b: Builder, md: string) {
  for (const s of parseSections(md)) {
    const to: string[] = [];
    const answers = ensure(b.draft.voice, 'standard_answers', {}) as Record<string, string>;
    for (const x of parseBullets(s.lines)) {
      if (!x.label) continue;
      answers[x.label] = x.text;
      to.push(`voice.standard_answers["${x.label}"]`);
      if (/^location/i.test(x.label)) {
        const place = x.text.split('.')[0]?.trim();
        if (place) to.push(b.set('work_mode', 'home_location', place));
      }
      if (/^relocation/i.test(x.label)) to.push(b.push('work_mode', 'notes', `Relocation answer: ${x.text}`));
    }
    to.push(b.keep('voice', 'application_defaults', s));
    b.map('application_defaults', loc(s), to);
  }
}

function convertStories(b: Builder, md: string) {
  for (const s of parseSections(md)) {
    const to: string[] = [];
    const story = /^story\s*\d+\s*[—–:-]\s*(.+?)(?:\s*\(([^)]+)\))?\s*$/i.exec(s.heading);
    if (story) {
      const item: Record<string, unknown> = { title: (story[1] ?? '').trim(), themes: [] };
      if (story[2]) item.status = story[2].trim();
      const themes = /\*\*Themes:\*\*\s*(.+)$/im.exec(s.lines.join('\n'))?.[1];
      if (themes)
        item.themes = themes
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
      const extra: string[] = [];
      for (const x of parseBullets(s.lines)) {
        const k = (x.label ?? '').toLowerCase();
        const field = ({ s: 'situation', t: 'task', a: 'action', r: 'result', confirm: 'confirm' } as Record<string, string>)[k];
        if (field) item[field] = x.text;
        else extra.push(x.label ? `${x.label}: ${x.text}` : x.text);
      }
      if (extra.length) item.notes = extra;
      to.push(b.push('story', 'stories', item));
    } else if (/tell me about yourself/i.test(s.heading)) {
      to.push(b.set('story', 'arc', stripMd(sectionText(s))));
    } else if (/questions to ask/i.test(s.heading)) {
      to.push(b.push('story', 'questions_to_ask', ...parseBullets(s.lines).map((x) => x.text)));
    }
    to.push(b.keep('story', 'stories', s));
    b.map('stories', loc(s), to);
  }
}

function convertResume(b: Builder, md: string, now: Date) {
  const parsed = parseResumeHeuristic(md, now);
  const contact = /\*\*Contact:\*\*\s*(.+)$/im.exec(md)?.[1];
  if (contact) {
    const c: Record<string, string> = {};
    for (const part of contact.split(/\s*[•|]\s*/)) {
      const p = part.trim();
      if (/@/.test(p)) c.email = p;
      else if (/linkedin/i.test(p)) c.linkedin = p;
      else if (/github/i.test(p)) c.github = p;
      else if (/\d{3}.*\d{4}/.test(p)) c.phone = p;
      else if (p) c[`other_${Object.keys(c).length}`] = p;
    }
    b.draft.story.contact = c;
  }
  for (const [k, v] of Object.entries(parsed.story)) b.set('story', k, v);
  for (const [k, v] of Object.entries(parsed.craft)) {
    if (k === 'functions') b.push('craft', 'functions', ...(v as string[]));
    else b.set('craft', k, v);
  }
  for (const s of parseSections(md)) {
    const to = [b.keep('story', 'resume_master', s)];
    if (/experience/i.test(s.path[1] ?? s.heading) || s.level >= 3) to.unshift('story.roles');
    if (/^profile/i.test(s.heading)) to.unshift('story.summary');
    if (/skill/i.test(s.heading)) to.unshift('story.skills');
    if (/education/i.test(s.heading)) to.unshift('story.education');
    if (!s.heading || s.level === 1) to.unshift('story.headline', 'story.contact', 'craft.level', 'craft.functions');
    b.map('resume_master', loc(s), to);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const BASE_CONFIDENCE: Record<ProfileComponentKey, number> = {
  story: 0.8,
  craft: 0.7,
  domain: 0.6,
  work_mode: 0.8,
  terms: 0.7,
  company: 0.5,
  team: 0.5,
  growth: 0.4,
  dealbreakers: 0.8,
  voice: 0.6,
  network: 0.1,
};

export function convertV1Profile(inputs: V1Inputs, now: Date = new Date()): V1Conversion {
  const b = new Builder();
  // rubric.json first: it is the machine standard; markdown fills gaps.
  if (inputs.rubric_json) convertRubricJson(b, inputs.rubric_json);
  if (inputs.perfect_role) convertPerfectRole(b, inputs.perfect_role);
  if (inputs.rubric_md) convertRubricMd(b, inputs.rubric_md);
  if (inputs.positioning) convertPositioning(b, inputs.positioning);
  if (inputs.application_defaults) convertDefaults(b, inputs.application_defaults);
  if (inputs.stories) convertStories(b, inputs.stories);
  if (inputs.resume_master) convertResume(b, inputs.resume_master, now);

  if (!inputs.rubric_json) {
    const byComp = weightsByComponent(NEUTRAL_WEIGHTS);
    for (const key of PROFILE_COMPONENT_KEYS)
      if (Object.keys(byComp[key].criterion_weights).length) b.draft[key].criterion_weights = byComp[key].criterion_weights;
  }
  // Every dream company should also be in affinity (rubric.md may list more than rubric.json).
  const dream = (b.draft.company.dream_companies ?? []) as string[];
  if (dream.length) {
    const aff = ensure(b.draft.company, 'affinity', {}) as Record<string, number>;
    for (const d of dream) aff[slugify(d)] ??= 3;
  }
  if (!b.draft.network.warm_companies) b.questions.push('Network is empty in v1: it fills from LinkedIn (lane H) or a quick re-interview.');
  if (!b.draft.growth.scope_ceiling) b.questions.push('Growth has no stated scope ceiling: re-interview Growth (2 questions).');
  if (!b.draft.terms.equity) b.questions.push('Equity appetite is only in prose (Terms notes): set low / medium / high.');

  const components = {} as Record<ProfileComponentKey, ConvertedComponent>;
  const weights = weightsByComponent(
    normalizeWeights(
      Object.fromEntries(
        CRITERIA.map((c) => [
          c,
          (b.draft[CRITERION_OWNER[c]].criterion_weights as Record<string, number> | undefined)?.[c] ?? NEUTRAL_WEIGHTS[c],
        ]),
      ) as Record<Criterion, number>,
    ),
  );
  for (const key of PROFILE_COMPONENT_KEYS) {
    const data = parseComponentData(key, b.draft[key]);
    const filled =
      Object.keys(data).some((k) => !['v1_sections', 'criterion_weights', 'criteria', 'hard_nos'].includes(k)) ||
      (key === 'dealbreakers' && (data.hard_nos as string[]).length > 0);
    let confidence = filled ? BASE_CONFIDENCE[key] : 0.1;
    if (Array.isArray(data.open_questions) && data.open_questions.length) confidence -= 0.1;
    components[key] = {
      key,
      confidence: Math.max(0, Math.round(confidence * 100) / 100),
      weight: weights[key].weight,
      data_json: data,
      markdown: key === 'story' || key === 'voice' ? renderComponentMd(key, '<id>', data).replace(/^---[\s\S]*?---\n/, '') : null,
    };
  }
  const rv = b.provenance.rubric_version
    ? ` (rubric ${String(b.provenance.rubric_version)}${b.provenance.rubric_updated ? `, ${String(b.provenance.rubric_updated)}` : ''})`
    : '';
  return {
    components,
    version_reason: `v1 import${rv}`,
    config: b.config,
    provenance: b.provenance,
    report: b.report,
    behavior_changes: b.behavior,
    questions: b.questions,
  };
}

// ---------------------------------------------------------------------------
// Coverage check ("nothing dropped") + report
// ---------------------------------------------------------------------------

function norm(s: string): string {
  return stripMd(s)
    .replace(/^\s*(?:[-*+>]|\d+\.|#{1,6})\s+/, '')
    .replace(/[*_`>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (typeof v === 'number' || typeof v === 'boolean') out.push(String(v));
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      strings(x, out);
    }
  return out;
}

export interface CoverageResult {
  ok: boolean;
  files: Array<{ source: V1Source; lines: number; covered: number; missing: string[] }>;
}

/** Every non-empty source line (and every rubric.json leaf path) must be present in the output. */
export function verifyCoverage(inputs: V1Inputs, conv: V1Conversion): CoverageResult {
  const hay = norm(strings([conv.components, conv.config, conv.provenance, conv.version_reason]).join('\n'));
  const files: CoverageResult['files'] = [];
  for (const [source, text] of Object.entries(inputs) as Array<[V1Source, string | undefined]>) {
    if (!text) continue;
    if (source === 'rubric_json') {
      let j: unknown;
      try {
        j = JSON.parse(text);
      } catch {
        files.push({
          source,
          lines: 1,
          covered: conv.provenance.rubric_json_raw ? 1 : 0,
          missing: conv.provenance.rubric_json_raw ? [] : ['$'],
        });
        continue;
      }
      const leaves: string[] = [];
      const walk = (v: unknown, p: string) => {
        if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
        else leaves.push(p);
      };
      walk(j, '');
      const mapped = new Set(conv.report.filter((r) => r.source === 'rubric_json').map((r) => r.locator));
      const missing = leaves.filter((l) => !mapped.has(l));
      files.push({ source, lines: leaves.length, covered: leaves.length - missing.length, missing });
      continue;
    }
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^-{3,}$/.test(l) && !/^\|?(\s*:?-{2,}:?\s*\|)+\s*:?-*:?\s*\|?$/.test(l));
    const missing = lines.filter((l) => {
      const n = norm(l);
      return n.length > 0 && !hay.includes(n);
    });
    files.push({ source, lines: lines.length, covered: lines.length - missing.length, missing });
  }
  return { ok: files.every((f) => f.missing.length === 0), files };
}

/** Human-readable mapping report. Contains source headings only unless `withValues`. */
export function renderConversionReport(conv: V1Conversion, coverage: CoverageResult, withValues = false): string {
  const out: string[] = ['# v1 profile conversion report', ''];
  out.push('## Coverage', '', '| Source | Lines / leaves | Covered | Missing |', '| --- | --- | --- | --- |');
  for (const f of coverage.files) out.push(`| ${V1_FILES[f.source]} | ${f.lines} | ${f.covered} | ${f.missing.length} |`);
  out.push('', coverage.ok ? '**Nothing dropped.**' : '**Some content was not found in the output (listed below).**', '');
  for (const f of coverage.files)
    if (f.missing.length) out.push(`### Missing from ${V1_FILES[f.source]}`, '', ...f.missing.map((m) => `- ${m}`), '');
  out.push('## What mapped where', '');
  for (const src of Object.keys(V1_FILES) as V1Source[]) {
    const rows = conv.report.filter((r) => r.source === src);
    if (!rows.length) continue;
    out.push(`### ${V1_FILES[src]}`, '', '| Source | Destination | Note |', '| --- | --- | --- |');
    for (const r of rows) out.push(`| ${r.locator.replace(/\|/g, '/')} | ${r.to.join(', ')} | ${r.note ?? ''} |`);
    out.push('');
  }
  out.push(
    '## Components',
    '',
    '| Component | Confidence | Weight | Structured fields | v1 sections kept |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const key of PROFILE_COMPONENT_KEYS) {
    const c = conv.components[key];
    const fields = Object.keys(c.data_json).filter((k) => k !== 'v1_sections');
    out.push(
      `| ${key} | ${c.confidence} | ${c.weight ?? ''} | ${fields.join(', ')} | ${((c.data_json.v1_sections as unknown[]) ?? []).length} |`,
    );
  }
  out.push(
    '',
    '## Behavior changes in v2',
    '',
    ...(conv.behavior_changes.length ? conv.behavior_changes.map((x) => `- ${x}`) : ['- none']),
    '',
  );
  out.push('## Questions', '', ...(conv.questions.length ? conv.questions.map((x) => `- ${x}`) : ['- none']), '');
  out.push(`## Version`, '', `reason: ${conv.version_reason}`, '', `config: \`${JSON.stringify(conv.config)}\``, '');
  if (withValues) {
    out.push('## Structured values', '');
    for (const key of PROFILE_COMPONENT_KEYS) {
      const { v1_sections: _drop, ...rest } = conv.components[key].data_json;
      out.push(`### ${key}`, '', '```json', JSON.stringify(rest, null, 2), '```', '');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}
