import type { OpOutput } from '@perfect-placement/contracts';

/*
 * The filed answers (#81) ride in the answers file's frontmatter as one JSON line (`answers: [...]`), written and
 * read only by apply.fill (merge) and apply.resolve_claim (keep it in step with the body). The markdown body is
 * never parsed for them.
 */

export type FiledAnswer = OpOutput<'apply.fill'>['answers'][number];

const FIELD = 'answers: ';
const FRONTMATTER = /^---\n([\s\S]*?)\n---/;

/** The answers filed last time, or none. */
export function savedAnswers(md: string | null | undefined): FiledAnswer[] {
  const line = md
    ? FRONTMATTER.exec(md)?.[1]
        ?.split('\n')
        .find((l) => l.startsWith(FIELD))
    : undefined;
  if (!line) return [];
  try {
    const parsed = JSON.parse(line.slice(FIELD.length)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a): a is FiledAnswer =>
        !!a && typeof a === 'object' && typeof a.question === 'string' && typeof a.answer === 'string' && typeof a.kind === 'string',
    );
  } catch {
    return [];
  }
}

/** Apply a resolved claim (`remove`, or the replacement text) to the filed answer holding that line. */
export function resolveSavedLine(md: string, line: string, value: string | null): string {
  const m = FRONTMATTER.exec(md);
  if (!m) return md;
  const list = savedAnswers(md);
  if (!list.length) return md;
  const next = list.map((a) => {
    const lines = a.answer.split('\n');
    const at = lines.findIndex((l) => l.trim() === line.trim());
    if (at < 0) return a;
    if (value === null) lines.splice(at, 1);
    else lines[at] = value;
    // The user settled the claim: its flag goes; an answer left empty has no draft yet.
    const answer = lines.join('\n').trim();
    const { reason: _reason, ...rest } = a;
    return answer ? { ...rest, answer, needs_human: false } : { ...rest, answer, needs_human: true, reason: 'no draft yet' };
  });
  const head = (m[1] as string).split('\n').map((l) => (l.startsWith(FIELD) ? `${FIELD}${JSON.stringify(next)}` : l));
  return `---\n${head.join('\n')}\n---${md.slice(m[0].length)}`;
}
