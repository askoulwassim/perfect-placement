import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSubmitLike } from '@perfect-placement/contracts';
import { FIXTURE_ROLE_IDS } from '@perfect-placement/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractResumeText } from '../../profile/resume-text.js';
import { ctxAt, type FixtureEngine, okOut, openFixtureEngine } from '../../testing/index.js';
import { parseMarkdown, renderDocx, renderPdf } from '../documents.js';
import { downloadableFile } from './assist.js';

/*
 * #106: rendered documents (PDF + DOCX from the tailored markdown) and the fill assist report. Synthetic text,
 * temp vault (openFixtureEngine); every rendered file stays in that temp dir.
 */

const RESUME = `---
id: "ap_0002-resume"
type: "application_resume"
---

# Alex Example

Product leader · alex@example.com · [Portfolio](https://example.com/alex)

## Experience

### Staff PM, Example Data Co

- Shipped the **metrics layer** used by every team
- Cut query cost by 40% with a caching tier
1. Numbered item stays in order

## Education

BSc Computer Science, Example University
`;

let e: FixtureEngine;
beforeEach(() => {
  e = openFixtureEngine();
});
afterEach(() => e.cleanup());

const role_id = FIXTURE_ROLE_IDS.linearDraft;
const resumePath = `applications/${role_id}/resume.md`;
const app = () => e.db.prepare('SELECT * FROM application WHERE role_id = ?').get(role_id) as Record<string, string | null>;

describe('documents (pure renderers)', () => {
  it('parses headings, bullets, numbered items, bold and links', () => {
    const blocks = parseMarkdown(RESUME.replace(/^---[\s\S]*?---\n/, ''));
    expect(blocks.filter((b) => b.t === 'h').map((b) => (b.t === 'h' ? b.level : 0))).toEqual([1, 2, 3, 2]);
    const li = blocks.filter((b) => b.t === 'li');
    expect(li).toHaveLength(3);
    expect(li[0]).toMatchObject({
      marker: '•',
      spans: [{ text: 'Shipped the ' }, { text: 'metrics layer', bold: true }, { text: ' used by every team' }],
    });
    expect(li[2]).toMatchObject({ marker: '1.' });
    const p = blocks.find((b) => b.t === 'p');
    expect(p && p.t === 'p' ? p.spans.map((s) => s.text).join('') : '').toContain('Portfolio (https://example.com/alex)');
  });

  it('PDF and DOCX carry the markdown text: headings and bullets (round trip through the resume extractor)', async () => {
    const md = RESUME.replace(/^---[\s\S]*?---\n/, '');
    const pdf = await renderPdf(md, { title: 'Resume' });
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const pdfText = (await extractResumeText('r.pdf', pdf)).text;
    for (const s of [
      'Alex Example',
      'Experience',
      'Staff PM, Example Data Co',
      'Shipped the metrics layer used by every team',
      'Cut query cost by 40%',
      'Education',
    ])
      expect(pdfText).toContain(s);
    expect(pdfText).toContain('•');

    const docx = await renderDocx(md, { title: 'Resume' });
    const docxText = (await extractResumeText('r.docx', docx)).text;
    expect(docxText).toContain('# Alex Example');
    expect(docxText).toContain('## Experience');
    expect(docxText).toContain('### Staff PM, Example Data Co');
    expect(docxText).toContain('- Shipped the metrics layer used by every team');
    expect(docxText).toContain('- Cut query cost by 40% with a caching tier');
    expect(docxText).toContain('## Education');
  });

  it('PDF survives characters the standard fonts lack', async () => {
    const pdf = await renderPdf('# Zoë Łukasz 東京\n\n- “quoted” — dash', { title: 'x' });
    const text = (await extractResumeText('r.pdf', pdf)).text;
    expect(text).toContain('Zoë Lukasz');
    expect(text).toContain('“quoted” — dash');
  });
});

describe('apply.render_documents', () => {
  it('renders both documents in both formats to files/<role_id>/ and records them on the application', async () => {
    writeFileSync(join(e.home, resumePath), RESUME);
    const out = okOut(await e.runOp('apply.render_documents', { role_id }, ctxAt()));
    expect(out.files.map((f) => f.path).sort()).toEqual(
      ['cover_letter.docx', 'cover_letter.pdf', 'resume.docx', 'resume.pdf'].map((f) => `files/${role_id}/${f}`),
    );
    for (const f of out.files) {
      expect(f.abs_path).toBe(join(e.home, f.path));
      expect(existsSync(f.abs_path)).toBe(true);
      expect(readFileSync(f.abs_path).length).toBe(f.bytes);
    }
    expect(JSON.parse(app().package_paths_json as string)).toMatchObject({
      resume: resumePath,
      resume_pdf: `files/${role_id}/resume.pdf`,
      resume_docx: `files/${role_id}/resume.docx`,
      cover_letter_pdf: `files/${role_id}/cover_letter.pdf`,
      cover_letter_docx: `files/${role_id}/cover_letter.docx`,
    });
    const pdf = readFileSync(join(e.home, `files/${role_id}/resume.pdf`));
    expect((await extractResumeText('r.pdf', pdf)).text).toContain('Shipped the metrics layer');
    // Doctor still passes: rendered files are referenced, non-markdown, not orphans.
    const { doctor } = await import('../../db/doctor.js');
    expect(
      doctor({ home: e.home, db: e.db }).checks.filter((c) => !c.ok && c.name !== 'no_claude_md' && c.name !== 'pp_home_not_in_git'),
    ).toEqual([]);
  });

  it('one format and one document on request; refuses a role with nothing tailored', async () => {
    const out = okOut(await e.runOp('apply.render_documents', { role_id, formats: ['pdf'], docs: ['resume'] }, ctxAt()));
    expect(out.files.map((f) => f.path)).toEqual([`files/${role_id}/resume.pdf`]);
    expect(await e.runOp('apply.render_documents', { role_id: FIXTURE_ROLE_IDS.stripeOnDeck }, ctxAt())).toMatchObject({
      status: 'error',
      code: 'conflict',
    });
  });
});

describe('downloadableFile (the download route guard)', () => {
  it('serves only rendered files an application references', async () => {
    okOut(await e.runOp('apply.render_documents', { role_id, formats: ['pdf'], docs: ['resume'] }, ctxAt()));
    const ok = downloadableFile(e.db, e.home, `files/${role_id}/resume.pdf`);
    expect(ok).toMatchObject({ name: `${role_id}_resume.pdf`, contentType: 'application/pdf' });
    writeFileSync(join(e.home, 'files', 'stray.pdf'), '%PDF-1.4');
    for (const bad of ['files/stray.pdf', resumePath, `files/${role_id}/resume.docx`, '../x.pdf', `/files/${role_id}/resume.pdf`, 'pp.db'])
      expect(downloadableFile(e.db, e.home, bad), bad).toBeNull();
  });
});

describe('apply.fill_done', () => {
  it('records the assist and moves the application to submit; the human submits', async () => {
    okOut(await e.runOp('apply.render_documents', { role_id, formats: ['pdf'] }, ctxAt()));
    expect(app().fill_assist_json).toBeNull();
    const out = okOut(
      await e.runOp(
        'apply.fill_done',
        {
          role_id,
          filled: ['Why Linear?', 'LinkedIn profile'],
          uploaded: ['resume', 'cover_letter'],
          skipped: [{ label: 'Gender', reason: 'you answer demographic questions yourself' }],
        },
        ctxAt(),
      ),
    );
    expect(out.application.stage).toBe('submit');
    expect(out.application.fill_assist_json).toMatchObject({
      filled: ['Why Linear?', 'LinkedIn profile'],
      uploaded: ['resume', 'cover_letter'],
    });
    expect(JSON.parse(app().fill_assist_json as string).skipped).toEqual([
      { label: 'Gender', reason: 'you answer demographic questions yourself' },
    ]);
    // Still draft-ready: nothing was submitted.
    expect((e.db.prepare('SELECT status FROM role WHERE id = ?').get(role_id) as { status: string }).status).toBe('draft-ready');
  });

  it('refuses a submit-like control and an upload with no rendered PDF', async () => {
    for (const label of ['Submit', 'Submit application', 'Apply now', 'Send application', 'Review and submit'])
      expect(await e.runOp('apply.fill_done', { role_id, filled: ['Why Linear?', label] }, ctxAt()), label).toMatchObject({
        status: 'error',
        code: 'invalid_input',
      });
    expect(await e.runOp('apply.fill_done', { role_id, uploaded: ['resume'] }, ctxAt())).toMatchObject({ code: 'invalid_input' });
    expect(app().fill_assist_json).toBeNull();
    // A question that merely mentions applying is an answer field, not a control.
    for (const q of ['Why do you want to apply?', 'Have you applied before?', 'Confirm email']) expect(isSubmitLike(q), q).toBe(false);
  });

  it('is for a draft-ready role only', async () => {
    expect(await e.runOp('apply.fill_done', { role_id: FIXTURE_ROLE_IDS.rampIv }, ctxAt())).toMatchObject({ code: 'conflict' });
  });
});
