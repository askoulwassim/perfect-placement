import { type ApplicationDefaults, EEO_DEFAULT, type OpInput, type OpOutput, vaultPath } from '@perfect-placement/contracts';
import { checkFacts } from '../../profile/facts.js';
import { getComponents, getCurrentVersion } from '../../profile/versions.js';
import { OpError } from '../errors.js';
import { defineHandler, type HandlerContext } from '../runtime.js';
import { renderMarkdown } from '../vault.js';
import { type DocClaim, factSources, queueFactChecks, readBody, roleContext } from './claims.js';
import { getCompany, getRole, laterStage, upsertApplication } from './shared.js';

/*
 * apply.fill (#42): the model classifies each portal question and drafts the written answers; this code
 * fills standard answers from the saved Application defaults, lists identity and upload fields as portal
 * fills, fact-checks the written answers, and flags only what needs the user, each with a reason.
 */

type FillIn = OpInput<'apply.fill'>['answers'][number];
type Filled = OpOutput<'apply.fill'>['answers'][number];
type Data = Record<string, unknown>;

interface Saved {
  story: Data;
  terms: Data;
  workMode: Data;
  defaults: ApplicationDefaults;
  resumeText: string;
}

function savedProfile(h: HandlerContext): Saved {
  const v = getCurrentVersion(h.repos);
  const comps = v ? getComponents(h.repos, v.id) : [];
  const data = (k: string) => (comps.find((c) => c.key === k)?.data_json ?? {}) as Data;
  const story = data('story');
  const terms = data('terms');
  const resumePath = typeof story.source_path === 'string' ? story.source_path : null;
  return {
    story,
    terms,
    workMode: data('work_mode'),
    defaults: (terms.application_defaults ?? {}) as ApplicationDefaults,
    resumeText: readBody(h, resumePath) ?? '',
  };
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []);

// ------------------------------------------------------------------ portal fills

const CONTACT_RE: Record<string, RegExp> = {
  email: /\b[\w.+-]+@[\w-]+\.[\w.]+\b/,
  phone: /(?<![\w])\+?\d[\d .()-]{7,}\d(?![\w])/,
  linkedin: /\b(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[\w-]+\/?/i,
  github: /\b(?:https?:\/\/)?(?:www\.)?github\.com\/[\w-]+\/?/i,
};

/** A portal-fill value from the profile: Story contact first, then the kept resume text. */
function autofillValue(field: string, s: Saved, paths: Record<string, string>): string | null {
  const contact = (s.story.contact ?? {}) as Record<string, unknown>;
  if (field === 'resume' || field === 'cover_letter') return paths[field] ?? null;
  if (field === 'name') {
    const heading = /^#\s+(.+)$/m.exec(s.resumeText)?.[1]?.split(/\s+[-–—|]\s+/)[0] ?? null;
    return str(s.story.name) ?? str(contact.name) ?? str(heading);
  }
  const saved = str(contact[field]);
  if (saved) return saved;
  const re = CONTACT_RE[field];
  return re ? (re.exec(s.resumeText)?.[0]?.trim() ?? null) : null;
}

// ------------------------------------------------------------------ standard answers

const COUNTRY_ALIASES: Record<string, string> = {
  us: 'united states',
  usa: 'united states',
  'u.s.': 'united states',
  'u.s.a.': 'united states',
  america: 'united states',
  'united states of america': 'united states',
  uk: 'united kingdom',
  'u.k.': 'united kingdom',
  britain: 'united kingdom',
  'great britain': 'united kingdom',
  england: 'united kingdom',
};
const countryKey = (c: string) => {
  const k = c
    .trim()
    .toLowerCase()
    .replace(/^the\s+/, '');
  return COUNTRY_ALIASES[k] ?? k;
};

const yes = (v: string | null) => !!v && /^(yes|y|true)\b/i.test(v);
const no = (v: string | null) => !!v && /^(no|n|false)\b/i.test(v);

function money(n: number, currency: string) {
  const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '';
  return `${sym}${n.toLocaleString('en-US')}${sym ? '' : ` ${currency}`}`;
}

const questionKey = (q: string) =>
  q
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

/** The saved answer to a standard question, or why there is none (the needs-you reason). */
export function standardAnswer(field: string, a: Pick<FillIn, 'question' | 'country'>, s: Saved): { answer: string } | { reason: string } {
  const d = s.defaults;
  const country = a.country?.trim() || null;
  switch (field) {
    case 'sponsorship': {
      const v = str(d.sponsorship);
      if (!v) return { reason: 'no saved answer for visa sponsorship' };
      return { answer: no(v) ? 'No, I will not require visa sponsorship.' : yes(v) ? 'Yes, I will require visa sponsorship.' : v };
    }
    case 'work_authorization': {
      const countries = list(d.authorized_countries);
      if (!country) {
        if (!countries.length) return { reason: 'no saved work authorization' };
        return { answer: `I am authorized to work in ${countries.join(', ')}.` };
      }
      const hit = countries.find((c) => countryKey(c) === countryKey(country));
      if (hit) return { answer: `Yes, I am authorized to work in ${hit}.` };
      return { reason: `no saved work authorization for ${country}` };
    }
    case 'relocation': {
      const v = str(d.relocation) ?? str(s.workMode.relocation);
      const to = country ? ` to ${country}` : '';
      if (!v) return { reason: `no saved answer for relocation${to}` };
      if (yes(v)) return { answer: `Yes, I am open to relocating${to}.` };
      if (no(v)) return { answer: `No, I am not looking to relocate${to}.` };
      return { reason: `relocation${to} is case by case (${v})` };
    }
    case 'notice_period':
    case 'start_date': {
      const v = str(d.notice_period);
      if (!v) return { reason: 'no saved notice period' };
      if (/^(none|0|immediately|now)\b/i.test(v))
        return { answer: field === 'start_date' ? 'I can start immediately.' : 'No notice period.' };
      return { answer: field === 'start_date' ? `I can start ${v} after an offer.` : `${v[0]?.toUpperCase()}${v.slice(1)}.` };
    }
    case 'comp_expectation': {
      const v = str(d.comp_expectation);
      if (v) return { answer: v };
      const target = typeof s.terms.comp_target === 'number' ? s.terms.comp_target : null;
      if (!target) return { reason: 'no saved comp expectation' };
      const cur = str(s.terms.currency) ?? 'USD';
      const max = typeof s.terms.comp_target_max === 'number' && s.terms.comp_target_max > target ? s.terms.comp_target_max : null;
      return { answer: `${money(target, cur)}${max ? ` to ${money(max, cur)}` : ''} base, open to discussing the full package.` };
    }
    case 'in_office': {
      const v = str(d.in_office);
      if (v) {
        if (/^0\b|remote/i.test(v)) return { answer: 'I am looking for fully remote work.' };
        return { answer: /day/i.test(v) ? v : `I can be in the office ${v} days a week.` };
      }
      const modes = list(s.workMode.modes);
      if (modes.length === 1 && modes[0] === 'remote') return { answer: 'I am looking for fully remote work.' };
      return { reason: 'no saved answer for office days' };
    }
    case 'location': {
      const v = str(s.workMode.home_location) ?? list(s.workMode.locations)[0] ?? null;
      return v ? { answer: v } : { reason: 'no saved location' };
    }
    case 'eeo': {
      const v = str(d.eeo) ?? EEO_DEFAULT;
      return /^ask\b/i.test(v) ? { reason: 'you answer demographic questions yourself' } : { answer: v };
    }
    default: {
      const answers = d.answers ?? {};
      const v = str(answers[field]) ?? str(answers[questionKey(a.question)]);
      return v ? { answer: v } : { reason: 'no saved answer for this question' };
    }
  }
}

// ------------------------------------------------------------------ the op

const GROUP_ORDER: Record<Filled['kind'], number> = { written: 0, standard: 1, autofill: 2 };

function answersMarkdown(portalUrl: string | undefined, filed: Filled[]): string {
  const needs = filed.filter((a) => a.needs_human);
  const written = filed.filter((a) => !a.needs_human && a.kind === 'written');
  const standard = filed.filter((a) => !a.needs_human && a.kind === 'standard');
  const fills = filed.filter((a) => a.kind === 'autofill');
  const out = [
    '# Application answers',
    '',
    portalUrl ? `Portal: ${portalUrl}` : 'Portal: not recorded',
    `Needs you: ${needs.length} · Written: ${written.length} · Standard: ${standard.length} · Portal fills: ${fills.length}`,
  ];
  const group = (title: string, items: Filled[]) => {
    if (!items.length) return;
    out.push('', `## ${title}`);
    for (const a of items) {
      out.push('', `### ${a.question}`);
      if (a.needs_human && a.reason) out.push('', `> ${a.reason}`);
      out.push('', a.answer.trim() || '_No answer yet._');
    }
  };
  group('Needs you', needs);
  group('Written', written);
  group('Standard', standard);
  if (fills.length) {
    out.push('', '## Portal fills', '');
    for (const a of fills) out.push(`- ${a.question}: ${a.answer || 'not saved'}`);
  }
  return out.join('\n');
}

export const applyFill = defineHandler('apply.fill', {
  async run(input, h) {
    const role = getRole(h.db, input.role_id);
    if (role.status !== 'draft-ready') throw new OpError('conflict', `${role.id}: fill needs a draft-ready role (is ${role.status})`);
    const company = getCompany(h.db, role.company_id);
    const app = upsertApplication(h, role.id, {});
    const paths = (app.package_paths_json ?? {}) as Record<string, string>;
    const saved = savedProfile(h);
    const { texts } = factSources(h);
    const context = roleContext(h, role, company);
    const floor = h.config.policy.second_opinion;

    let checked = 0;
    const claims: DocClaim[] = [];
    const filed: Filled[] = input.answers.map((a): Filled => {
      const base = { question: a.question, kind: a.kind, ...(a.field ? { field: a.field } : {}) };
      if (a.kind === 'autofill') {
        // The portal fills these from the profile; never an answer for review.
        const value = autofillValue(a.field ?? 'other', saved, paths) ?? (a.answer.trim() || '');
        return { ...base, answer: value, needs_human: false };
      }
      if (a.kind === 'standard') {
        const r = standardAnswer(a.field ?? 'other', a, saved);
        if ('answer' in r) return { ...base, answer: r.answer, needs_human: false };
        return { ...base, answer: a.answer.trim(), needs_human: true, reason: r.reason };
      }
      // Written: grounded in Story + CONTEXT, fact-checked like the cover letter.
      const reasons: string[] = [];
      if (a.needs_human && a.reason) reasons.push(a.reason.trim());
      if (!a.answer.trim() && !reasons.length) reasons.push('no draft yet');
      if (a.confidence !== undefined && a.confidence < floor) reasons.push(`low confidence (${a.confidence.toFixed(2)})`);
      if (a.answer.trim()) {
        const fc = checkFacts(a.answer, texts, { context, numbersFromContext: true, headings: false });
        checked += fc.supported.length + fc.unsupported.length;
        if (fc.unsupported.length) {
          const [first] = fc.unsupported;
          const more = fc.unsupported.length > 1 ? ` (+${fc.unsupported.length - 1} more)` : '';
          reasons.push(`"${first?.claim}" is not in your Story${more}`);
          claims.push(...fc.unsupported.map((c) => ({ ...c, doc: 'answers' as const })));
        }
      }
      return reasons.length
        ? { ...base, answer: a.answer.trim(), needs_human: true, reason: reasons.join('; ') }
        : { ...base, answer: a.answer.trim(), needs_human: false };
    });
    // Needs you first, then written, standard, portal fills (stable inside each group).
    const ordered = filed
      .map((a, i) => ({ a, i }))
      .sort((x, y) => Number(y.a.needs_human) - Number(x.a.needs_human) || GROUP_ORDER[x.a.kind] - GROUP_ORDER[y.a.kind] || x.i - y.i)
      .map((x) => x.a);

    const path = vaultPath.application(role.id, 'answers');
    h.vault.write(
      path,
      renderMarkdown({ id: `${app.id}-answers`, type: 'application_answers' }, answersMarkdown(input.portal_url, ordered)),
    );
    const application = upsertApplication(h, role.id, {
      package_paths_json: { ...app.package_paths_json, answers: path },
      stage: laterStage(app.stage, 'submit'),
      ...(input.portal_url ? { portal_url: input.portal_url } : {}),
    });
    const needs_you = (await queueFactChecks(h, role.id, ['answers'], claims, texts)).map((c) => ({ ...c, doc: 'answers' as const }));
    const counts = {
      needs_you: ordered.filter((a) => a.needs_human).length,
      written: ordered.filter((a) => a.kind === 'written').length,
      standard: ordered.filter((a) => a.kind === 'standard').length,
      autofill: ordered.filter((a) => a.kind === 'autofill').length,
    };
    if (h.ctx.runId)
      h.runLog({
        title: 'apply.fill',
        summary: { role_id: role.id, ...counts, claims: needs_you.length },
        lines: [
          `${role.id}: ${counts.needs_you} need you, ${counts.written} written, ${counts.standard} standard, ${counts.autofill} portal fills`,
          ...ordered.filter((a) => a.needs_human).map((a) => `- ${a.question}: ${a.reason}`),
        ],
      });
    return { application, answers: ordered, counts, fact_check: { checked, needs_you } };
  },
});
