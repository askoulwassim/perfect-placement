import { deflateRawSync } from 'node:zlib';
import { cleanDictation, numberWordsToDigits } from '@perfect-placement/contracts';
import { describe, expect, it } from 'vitest';
import { checkFacts, nearestSource, storySourceText } from './facts.js';
import { nextQuestion, QUESTION_BANK, YEARS_LEAVE_OUT } from './questions.js';
import { parseResumeHeuristic, statedYears, yearsFromDates } from './resume.js';
import { extractResumeText, resumeKind } from './resume-text.js';
import { SYNTH_RESUME, SYNTH_RESUME_NO_YEARS, synthDocx, synthPdf } from './synthetic.js';

const NOW = new Date('2026-10-08T12:00:00Z');
const claims = (r: ReturnType<typeof checkFacts>['unsupported']) => r.map((c) => `${c.kind}:${c.claim}`);

describe('checkFacts (#38)', () => {
  it('rejects an invented "26 years" and other numbers the source lacks', () => {
    const doc = '# Jordan Example\n\nProduct leader with 26 years of experience.\n\n- Cut warehouse spend 45% with usage-based pricing.';
    const r = checkFacts(doc, SYNTH_RESUME);
    expect(claims(r.unsupported)).toEqual(['years:26 years', 'number:45']);
    expect(r.unsupported.every((c) => c.hard)).toBe(true);
  });

  it('passes a truthful tailored resume and cites the source line of each claim', () => {
    const doc = [
      '# Jordan Example',
      '',
      'Principal Product Manager, Data Platforms. Ten years across startups and a public company.',
      '',
      '### Acme Data — Principal Product Manager, Analytics — Mar 2022–Present',
      '- Launched a self-serve analytics product used by 120 teams.',
      '- Cut warehouse spend 30% with usage-based pricing.',
      '',
      '### Widget Labs - Senior Product Manager - 2018–2022',
      '- Grew API revenue from 1M to 6M ARR.',
      '',
      '## Education',
      '- BS, Example State University',
    ].join('\n');
    const r = checkFacts(doc, SYNTH_RESUME);
    expect(r.unsupported).toEqual([]);
    const years = r.supported.find((c) => c.kind === 'years');
    expect(years).toMatchObject({ claim: '10 years', source: expect.stringContaining('Ten years') });
    expect(r.supported.find((c) => c.claim === '120')?.source).toContain('used by 120 teams');
    expect(r.supported.find((c) => c.kind === 'date')?.claim).toBe('mar 2022');
  });

  it('flags an invented role heading, date and degree as hard; prose titles and employers as soft', () => {
    const doc = [
      '### Globex — VP Product — Jun 2012–2016',
      'As Head of Data at Initech I shipped it.',
      '- MBA, Example State University',
    ].join('\n');
    const r = checkFacts(doc, SYNTH_RESUME);
    const hard = r.unsupported.filter((c) => c.hard);
    const soft = r.unsupported.filter((c) => !c.hard);
    expect(claims(hard)).toEqual(['employer:Globex', 'title:VP Product', 'date:jun 2012', 'degree:MBA']);
    expect(claims(soft)).toEqual(['title:Head of Data', 'employer:Initech']);
    // "Master Resume" in the source is not a Master's degree; an MBA does not stand in for a BS.
    expect(checkFacts("Master's in Data Science", SYNTH_RESUME).unsupported.map((c) => c.kind)).toEqual(['degree']);
  });

  it('a cover letter may name the target company and role (context) but never take years from the JD', () => {
    const jd = 'Contoso is hiring a Group Product Manager. 8+ years of experience. Team of 40.';
    const cover = 'Hi team,\n\nI want to join Contoso as Group Product Manager. I bring 8 years of platform work to your team of 40.';
    const r = checkFacts(cover, SYNTH_RESUME, { context: jd, numbersFromContext: true, headings: false });
    expect(claims(r.unsupported)).toEqual(['years:8 years']);
  });

  it('Story sources: years only when stated or confirmed, never a guessed number', () => {
    expect(storySourceText({ headline: 'PM', years: 26 })).toBe('PM');
    expect(storySourceText({ years: 26, years_basis: 'from dates' })).toBe('');
    expect(storySourceText({ years: 10, years_basis: 'confirmed' })).toBe('10 years of experience');
    expect(storySourceText({ roles: [{ company: 'Acme', title: 'PM', dates: '2020', bullets: ['Shipped 3 things'] }] })).toContain(
      'Acme - PM - 2020',
    );
    expect(checkFacts('26 years', storySourceText({ years: 26 })).unsupported).toHaveLength(1);
  });
});

describe('years are never guessed (#38)', () => {
  it('the old guess (26, from a 2000 degree date) is gone: years come from role dates, marked for confirmation', () => {
    const d = parseResumeHeuristic(SYNTH_RESUME_NO_YEARS, NOW);
    expect(d.story).toMatchObject({ years: 10, years_basis: 'from dates' });
    const noDates = parseResumeHeuristic('# Sam\n\n## Education\n- MBA, Example School, 2000\n', NOW);
    expect(noDates.story.years).toBeUndefined();
  });

  it('stated years win and are marked stated', () => {
    expect(statedYears('Ten years across startups')).toBe(10);
    expect(statedYears('12+ years of experience in data')).toBe(12);
    expect(statedYears('Grew revenue 3x in 2 years.')).toBeNull();
    expect(parseResumeHeuristic(SYNTH_RESUME, NOW).story).toMatchObject({ years: 10, years_basis: 'stated' });
    expect(yearsFromDates([{ dates: 'Jan 2019–Present' }, { dates: '2016–2018' }], NOW)).toBe(10);
    expect(yearsFromDates([{ dates: 'no dates' }], NOW)).toBeNull();
  });

  it('a derived number is asked for confirmation (or left out)', () => {
    const draft = { story: { years: 10, years_basis: 'from dates' } };
    const q = nextQuestion(draft, ['story.headline', 'story.win']);
    expect(q?.id).toBe('story.years');
    expect(q?.optionsFor?.(draft)).toEqual(['10', YEARS_LEAVE_OUT]);
    q?.apply(draft, '10');
    expect(draft.story).toEqual({ years: 10, years_basis: 'confirmed' });
    const drop = { story: { years: 10, years_basis: 'from dates' } as Record<string, unknown> };
    QUESTION_BANK.find((x) => x.id === 'story.years')?.apply(drop, YEARS_LEAVE_OUT);
    expect(drop.story).toEqual({});
    expect(nextQuestion({ story: { years: 10, years_basis: 'stated' } }, ['story.headline', 'story.win'])?.id).not.toBe('story.years');
  });
});

describe('cleanDictation (#38)', () => {
  it('strips fillers and stutters, keeps the meaning and the numbers', () => {
    expect(cleanDictation('um, so I uh led the the migration, you know, that cut costs by 40%.')).toBe(
      'I led the migration, that cut costs by 40%.',
    );
    expect(cleanDictation('Uhh, I mean, we grew ARR from 1M to 6M. Hmm, in two quarters.')).toBe(
      'We grew ARR from 1M to 6M. In two quarters.',
    );
    expect(cleanDictation('Launched a product used by 120 teams.')).toBe('Launched a product used by 120 teams.');
    // Words that only look like fillers stay.
    expect(cleanDictation('Built an umbrella data model for human resources.')).toBe('Built an umbrella data model for human resources.');
  });
  it('number words compare as digits', () => {
    expect(numberWordsToDigits('Ten years, twenty-six teams')).toBe('10 years, 26 teams');
  });
});

describe('resume text extraction (#38)', () => {
  const lines = ['Riley Sample', 'Senior Product Manager', 'Shipped a forecasting product used by 85 customers.'];
  it('PDF', async () => {
    const r = await extractResumeText('resume.pdf', synthPdf(lines));
    expect(r.kind).toBe('pdf');
    expect(r.text.split('\n')).toEqual(lines);
  });
  it('DOCX, stored or deflated; headings and list items kept', async () => {
    const paras = ['# Riley Sample', '- Shipped to 85 customers & more', 'Plain line'];
    for (const deflate of [undefined, (b: Buffer) => deflateRawSync(b)]) {
      const r = await extractResumeText('resume.docx', synthDocx(paras, deflate));
      expect(r).toEqual({ kind: 'docx', text: paras.join('\n') });
    }
  });
  it('MD / TXT as text; unknown kinds refused', async () => {
    expect((await extractResumeText('r.md', Buffer.from(SYNTH_RESUME))).text).toBe(SYNTH_RESUME.trim());
    expect(resumeKind('noext', synthPdf(['x']))).toBe('pdf');
    await expect(extractResumeText('r.png', Buffer.from([1, 2, 3]))).rejects.toThrow(/unsupported/);
    await expect(extractResumeText('r.docx', Buffer.from('not a zip'))).rejects.toThrow(/DOCX/);
  });
});

describe('Application defaults questions (#42)', () => {
  const q = (id: string) => QUESTION_BANK.find((x) => x.id === id);

  it('are full-sentence questions saved in Terms application_defaults', () => {
    const ids = QUESTION_BANK.filter((x) => x.id.startsWith('defaults.')).map((x) => x.id);
    expect(ids).toEqual([
      'defaults.sponsorship',
      'defaults.authorized_countries',
      'defaults.relocation',
      'defaults.notice_period',
      'defaults.in_office',
      'defaults.eeo',
    ]);
    for (const id of ids) expect(q(id)?.label).toMatch(/^[A-Z].+\?$/);
    const d: Record<string, Record<string, unknown>> = {};
    q('defaults.sponsorship')?.apply(d, 'no');
    q('defaults.authorized_countries')?.apply(d, 'United States, Canada');
    q('defaults.eeo')?.apply(d, 'prefer not to say');
    expect(d.terms?.application_defaults).toEqual({
      sponsorship: 'no',
      authorized_countries: ['United States', 'Canada'],
      eeo: 'Prefer not to say',
    });
    expect(q('defaults.sponsorship')?.known(d)).toBe(true);
    expect(q('defaults.notice_period')?.known(d)).toBe(false);
  });

  it('office days are asked only when the work mode is not remote only; a saved relocation is not asked again', () => {
    const answered = QUESTION_BANK.filter((x) => !x.id.startsWith('defaults.')).map((x) => x.id);
    const remote = { work_mode: { modes: ['remote'], remote_only: true } };
    const asked = (d: Record<string, Record<string, unknown>>) => {
      const seen: string[] = [];
      for (let next = nextQuestion(d, answered); next; next = nextQuestion(d, [...answered, ...seen])) seen.push(next.id);
      return seen;
    };
    expect(asked(remote)).not.toContain('defaults.in_office');
    // #83: remote picked alone is not remote only; office days are still asked.
    expect(asked({ work_mode: { modes: ['remote'], remote_only: false } })).toContain('defaults.in_office');
    expect(asked({ work_mode: { modes: ['hybrid'], relocation: 'no' } })).toEqual([
      'defaults.sponsorship',
      'defaults.authorized_countries',
      'defaults.notice_period',
      'defaults.in_office',
      'defaults.eeo',
    ]);
  });
});

describe('nearestSource (#54)', () => {
  it('finds the source line sharing the most words with the claim; null when none share one', () => {
    expect(nearestSource('Globex', 'At Globex I cut warehouse spend with usage-based pricing.', SYNTH_RESUME)).toBe(
      '- **Cost:** Cut warehouse spend 30% with usage-based pricing.',
    );
    expect(nearestSource('Zorblax', 'Zorblax quux.', SYNTH_RESUME)).toBeNull();
  });

  it('an employer at the end of a sentence is checked without its period', () => {
    expect(claims(checkFacts('I maintained a library at Globex.', SYNTH_RESUME).unsupported)).toEqual(['employer:Globex']);
  });
});
