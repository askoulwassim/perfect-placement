import { type ProfileComponentKey, vaultPath } from '@perfect-placement/contracts';

/*
 * Long-form markdown for asset components (Story, Voice) at `profile/<key>.md`.
 * Frontmatter carries the component id + type (vault rule). The db stays canonical;
 * this file is for reading and for writing skills to quote from. Never parsed back.
 * Written through runOp's staged vault (ProfileDeps.vault).
 */

export const MD_COMPONENTS: readonly ProfileComponentKey[] = ['story', 'voice'];

const TITLES: Record<string, string> = { story: 'Story', voice: 'Voice' };

function list(items: unknown): string {
  return Array.isArray(items) ? items.map((i) => `- ${typeof i === 'string' ? i : JSON.stringify(i)}`).join('\n') : '';
}

export function renderComponentMd(key: ProfileComponentKey, id: string, data: Record<string, unknown>): string {
  const out: string[] = ['---', `id: "${id}"`, 'type: "profile_component"', `key: "${key}"`, '---', '', `# ${TITLES[key] ?? key}`, ''];
  const push = (h: string, body: string) => {
    if (body.trim()) out.push(`## ${h}`, '', body.trim(), '');
  };
  if (key === 'story') {
    if (typeof data.headline === 'string') out.push(`**${data.headline}**`, '');
    if (typeof data.summary === 'string') out.push(data.summary, '');
    push('Wins', list(data.wins));
    if (Array.isArray(data.roles)) {
      push(
        'Experience',
        (data.roles as Array<Record<string, unknown>>)
          .map((r) =>
            [
              `### ${r.company} - ${r.title}${r.dates ? ` - ${r.dates}` : ''}`,
              typeof r.summary === 'string' ? r.summary : '',
              list(r.bullets),
            ]
              .filter(Boolean)
              .join('\n\n'),
          )
          .join('\n\n'),
      );
    }
    if (Array.isArray(data.stories)) {
      push(
        'Stories',
        (data.stories as Array<Record<string, unknown>>)
          .map((s) =>
            [
              `### ${s.title}`,
              Array.isArray(s.themes) && s.themes.length ? `Themes: ${(s.themes as string[]).join(', ')}` : '',
              ...(['situation', 'task', 'action', 'result'] as const).filter((k) => s[k]).map((k) => `- ${k[0]?.toUpperCase()}: ${s[k]}`),
            ]
              .filter(Boolean)
              .join('\n'),
          )
          .join('\n\n'),
      );
    }
    push('Skills', list(data.skills));
    push('Education', list(data.education));
  } else if (key === 'voice') {
    if (typeof data.positioning === 'string') push('Positioning', data.positioning);
    if (typeof data.style === 'string') push('Style', data.style);
    push('Rules', list(data.rules));
    push('Differentiators', list(data.differentiators));
    if (data.standard_answers && typeof data.standard_answers === 'object') {
      push(
        'Standard answers',
        Object.entries(data.standard_answers as Record<string, string>)
          .map(([q, a]) => `- **${q}:** ${a}`)
          .join('\n'),
      );
    }
    push('Samples', list(data.samples));
  }
  if (Array.isArray(data.v1_sections)) {
    push(
      'Imported from v1',
      (data.v1_sections as Array<{ source: string; heading: string; text: string }>)
        .map((s) => `### ${s.heading || s.source}\n\n${s.text}`)
        .join('\n\n'),
    );
  }
  return `${out.join('\n').trimEnd()}\n`;
}

export const componentMdPath = (key: ProfileComponentKey) => vaultPath.profileComponent(key);
