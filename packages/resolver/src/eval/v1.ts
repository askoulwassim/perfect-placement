import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CRITERIA, INBOX_CLASSES } from '@perfect-placement/contracts';
import type { EvalCase } from './harness.js';
import { criterionQuestion, INBOX_QUESTION } from './synthetic.js';

/*
 * v1 loaders (READ-ONLY). Point at a v1 `02_Pipeline/` folder. Nothing here writes, and nothing
 * loaded from v1 may be committed: callers must write reports outside the repo.
 *
 * Score cases: latest record per role in data/scores.json (C1..C9), state = the role markdown with
 * score lines and score-driver sections stripped so the label does not leak.
 * Inbox cases: "Moved" lines in runs/*inbox*.md (id: class). v1 kept no email bodies, so the state
 * is the dated note in the role markdown that describes the email, with its heading removed.
 * This is a weak proxy; a faithful inbox replay needs the Gmail bodies (read-only, Wave 2).
 */

interface V1ScoreRecord {
  id: string;
  scored?: string;
  criteria?: Record<string, number>;
}

const STATUS_DIRS = ['inbox', 'active', 'on-deck', 'draft-ready', 'applied', 'interviews', 'offers', 'archive'];

/** Map role id -> markdown path. Filenames are `<date>_<company>_<role>.md`; ids are `company-role`. */
export function indexRoleFiles(pipelineDir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of STATUS_DIRS) {
    const dir = join(pipelineDir, d);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const id = f
        .replace(/\.md$/, '')
        .replace(/^\d{4}-\d{2}-\d{2}_/, '')
        .replace(/_/g, '-');
      out.set(id, join(dir, f));
      out.set(f.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}_/, ''), join(dir, f));
    }
  }
  return out;
}

const LEAKY_LINE = /(fit score|\bband\b|score drivers|\bscored?\b.*\d|\(\d\)|\bpriority\b|🟢|🟡|🔴)/i;
const LEAKY_SECTION = /^#{1,6}\s*(score drivers|why it fits|log|application|\d{4}-\d{2}-\d{2})/i;

/** Strip lines and sections that would reveal the score, band or later funnel history. */
export function scrubRoleMarkdown(md: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of md.split('\n')) {
    if (/^#{1,6}\s/.test(line)) skipping = LEAKY_SECTION.test(line);
    if (skipping || LEAKY_LINE.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

/** Pull criterion anchors from a v1 rubric.md table row: | n | **Name** | weight | 1 | 3 | 5 |. */
export function rubricInstructions(rubricMd: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!rubricMd) return out;
  for (const line of rubricMd.split('\n')) {
    const m = /^\|\s*(\d)\s*\|\s*\*\*(.+?)\*\*\s*\|\s*\d+\s*\|(.+?)\|(.+?)\|(.+?)\|/.exec(line);
    if (!m) continue;
    out[`c${m[1]}`] = `Rate "${m[2]}" for this role, 1 to 5. 1: ${m[3]?.trim()}. 3: ${m[4]?.trim()}. 5: ${m[5]?.trim()}.`;
  }
  return out;
}

export function loadV1ScoreCases(pipelineDir: string, rubricMd?: string): EvalCase[] {
  const raw = JSON.parse(readFileSync(join(pipelineDir, 'data', 'scores.json'), 'utf8')) as { scores?: V1ScoreRecord[] } | V1ScoreRecord[];
  const records = Array.isArray(raw) ? raw : (raw.scores ?? []);
  const latest = new Map<string, V1ScoreRecord>();
  for (const r of records) {
    const prev = latest.get(r.id);
    if (!prev || (r.scored ?? '') >= (prev.scored ?? '')) latest.set(r.id, r);
  }
  const files = indexRoleFiles(pipelineDir);
  const instr = rubricInstructions(rubricMd);
  const cases: EvalCase[] = [];
  for (const r of latest.values()) {
    const path = files.get(r.id);
    if (!path || !r.criteria) continue;
    const state = scrubRoleMarkdown(readFileSync(path, 'utf8'));
    if (state.length < 40) continue;
    for (const c of CRITERIA) {
      const v = r.criteria[c.toUpperCase()] ?? r.criteria[c];
      if (typeof v !== 'number') continue;
      cases.push({
        id: `v1-score-${r.id}-${c}`,
        source: 'v1_score',
        kind: 'roles.criterion',
        impact: 'low',
        group: `v1-score-${r.id}`,
        state,
        question: criterionQuestion(c, instr[c]),
        expected: v,
      });
    }
  }
  return cases;
}

const CLASS_ALIASES: Record<string, string> = {
  confirmation: 'confirmation',
  'interview-request': 'interview_request',
  interview: 'interview_request',
  offer: 'offer',
  rejection: 'rejection',
};

const CLASS_HEADING: Record<string, RegExp> = {
  confirmation: /confirm/i,
  interview_request: /interview/i,
  offer: /offer/i,
  rejection: /reject/i,
};

/** The body (no heading) of the first dated section whose heading names the class. */
export function emailNote(md: string, cls: string): string | undefined {
  const re = CLASS_HEADING[cls];
  if (!re) return undefined;
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!/^#{1,6}\s/.test(line) || !re.test(line)) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && !/^#{1,6}\s/.test(lines[j] as string); j++) body.push(lines[j] as string);
    const text = body.join('\n').trim();
    if (text) return text;
  }
  return undefined;
}

export function loadV1InboxCases(pipelineDir: string): EvalCase[] {
  const runsDir = join(pipelineDir, 'runs');
  if (!existsSync(runsDir)) return [];
  const files = indexRoleFiles(pipelineDir);
  const cases: EvalCase[] = [];
  const seen = new Set<string>();
  for (const f of readdirSync(runsDir).filter((x) => /inbox/i.test(x) && x.endsWith('.md'))) {
    const md = readFileSync(join(runsDir, f), 'utf8');
    for (const m of md.matchAll(/^-\s+([\w.-]+):\s+([a-z_-]+)\b/gim)) {
      const id = m[1] as string;
      const cls = CLASS_ALIASES[(m[2] as string).toLowerCase()];
      if (!cls || !(INBOX_CLASSES as readonly string[]).includes(cls) || seen.has(`${id}:${cls}`)) continue;
      const path = files.get(id) ?? files.get(id.replace(/_/g, '-'));
      const note = path ? emailNote(readFileSync(path, 'utf8'), cls) : undefined;
      if (!note) continue;
      seen.add(`${id}:${cls}`);
      cases.push({
        id: `v1-inbox-${id}-${cls}`,
        source: 'v1_inbox',
        kind: 'inbox.classify',
        impact: 'medium',
        state: note,
        question: INBOX_QUESTION,
        expected: cls,
      });
    }
  }
  return cases;
}
