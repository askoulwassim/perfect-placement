import { AlignmentType, BorderStyle, Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import PDFDocument from 'pdfkit';

/*
 * #106: the tailored resume and cover letter (markdown) rendered to PDF and DOCX for download and for the
 * fill assist's upload. One clean, ATS-friendly template: a single column, standard fonts (Helvetica in the
 * PDF, Calibri in the DOCX), real headings and real bullets, no tables, columns, images or text boxes, so a
 * parser reads it top to bottom. Pure JS (`pdfkit`, `docx`); no headless browser, no native deps.
 */

/** One inline run: plain, bold or italic text (links keep their text, and the URL when it differs). */
export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

export type Block =
  | { t: 'h'; level: 1 | 2 | 3; spans: Span[] }
  | { t: 'p'; spans: Span[] }
  | { t: 'li'; spans: Span[]; marker: string }
  | { t: 'hr' };

/** Inline markdown to spans: `**bold**`, `*italic*` / `_italic_`, `[text](url)`, `` `code` ``. */
export function parseInline(src: string): Span[] {
  const text = src.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t: string, u: string) => {
    const bare = u.replace(/^mailto:/, '');
    return t.trim() === bare || t.trim() === u ? t : `${t} (${bare})`;
  });
  const out: Span[] = [];
  const re = /\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|(?<![\w])_([^_]+)_(?![\w])|`([^`]+)`/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at) });
    if (m[1] !== undefined || m[2] !== undefined) out.push({ text: (m[1] ?? m[2]) as string, bold: true });
    else if (m[3] !== undefined || m[4] !== undefined) out.push({ text: (m[3] ?? m[4]) as string, italic: true });
    else out.push({ text: m[5] as string });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.filter((s) => s.text.length > 0);
}

/** Markdown (frontmatter already stripped) to blocks: headings, paragraphs, bullets, numbered items, rules. */
export function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', spans: parseInline(para.join(' ')) });
    para = [];
  };
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const h = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (!line.trim()) flush();
    else if (h) {
      flush();
      const level = Math.min(3, (h[1] as string).length) as 1 | 2 | 3;
      blocks.push({ t: 'h', level, spans: parseInline((h[2] as string).replace(/\s+#+$/, '')) });
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ t: 'hr' });
    } else if (li) {
      flush();
      const marker = /\d/.test(li[1] as string) ? (li[1] as string).replace(')', '.') : '•';
      blocks.push({ t: 'li', marker, spans: parseInline(li[2] as string) });
    } else if (/^\s*>\s?/.test(line)) para.push(line.replace(/^\s*>\s?/, ''));
    else if (/^\s*\|/.test(line)) {
      // A table row: one line of cells (no tables in an ATS template); the separator row is dropped.
      if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line)) continue;
      flush();
      const cells = line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean);
      blocks.push({ t: 'p', spans: parseInline(cells.join(' | ')) });
    } else para.push(line.trim());
  }
  flush();
  return blocks;
}

/** Plain text of a block's spans. */
export const spanText = (spans: readonly Span[]) => spans.map((s) => s.text).join('');

// --------------------------------------------------------------------- pdf

/** Characters the PDF standard fonts (WinAnsi) can draw beyond Latin-1. */
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

/** Letters with no decomposition to a base letter. */
const FOLD: Record<string, string> = {
  Ł: 'L',
  ł: 'l',
  Đ: 'D',
  đ: 'd',
  Ħ: 'H',
  ħ: 'h',
  ı: 'i',
  Ŧ: 'T',
  ŧ: 't',
  '\u2212': '-',
  '\u2032': "'",
};

/** Text the standard fonts can draw: Latin-1 + WinAnsi kept, other letters folded to their base, the rest dropped. */
export function pdfSafe(s: string): string {
  let out = '';
  for (const ch of s.replace(/[‐‑‒]/g, '-').replace(/ /g, ' ')) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || (code >= 32 && code <= 126) || (code >= 160 && code <= 255) || WIN_ANSI_EXTRA.has(ch)) out += ch;
    else if (FOLD[ch]) out += FOLD[ch];
    else {
      const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
      if (base && [...base].every((c) => (c.codePointAt(0) ?? 0) <= 255)) out += base;
    }
  }
  return out;
}

const PDF = {
  margin: 54,
  body: 10.5,
  h: { 1: 18, 2: 12, 3: 11 } as Record<1 | 2 | 3, number>,
  ink: '#111111',
  rule: '#888888',
};

const pdfFont = (s: Span, base: 'regular' | 'bold' = 'regular') =>
  s.bold || base === 'bold' ? (s.italic ? 'Helvetica-BoldOblique' : 'Helvetica-Bold') : s.italic ? 'Helvetica-Oblique' : 'Helvetica';

/** A US Letter PDF: Helvetica, one column, headings, bullets with a hanging indent. */
export function renderPdf(md: string, meta: { title: string }): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: PDF.margin, bottom: PDF.margin, left: PDF.margin, right: PDF.margin },
    info: { Title: pdfSafe(meta.title), Creator: 'Perfect Placement', Producer: 'Perfect Placement' },
    bufferPages: false,
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((ok, fail) => {
    doc.on('end', () => ok(Buffer.concat(chunks)));
    doc.on('error', fail);
  });
  const left = PDF.margin;
  const width = doc.page.width - PDF.margin * 2;
  doc.fillColor(PDF.ink);

  /** Write spans as one flowing paragraph starting at (x, current y). */
  const write = (spans: Span[], x: number, w: number, size: number, base: 'regular' | 'bold' = 'regular') => {
    const parts = spans.map((s) => ({ ...s, text: pdfSafe(s.text) })).filter((s) => s.text);
    if (!parts.length) return;
    doc.fontSize(size);
    parts.forEach((s, i) => {
      doc.font(pdfFont(s, base));
      const opts = { width: w, continued: i < parts.length - 1, lineGap: 1.5 };
      if (i === 0) doc.text(s.text, x, doc.y, opts);
      else doc.text(s.text, opts);
    });
  };

  const blocks = parseMarkdown(md);
  blocks.forEach((b, i) => {
    const prev = blocks[i - 1];
    if (b.t === 'h') {
      if (i > 0) doc.moveDown(b.level === 1 ? 0.6 : b.level === 2 ? 0.8 : 0.5);
      write(b.spans, left, width, PDF.h[b.level], 'bold');
      if (b.level === 2) {
        const y = doc.y + 2;
        doc
          .save()
          .moveTo(left, y)
          .lineTo(left + width, y)
          .lineWidth(0.6)
          .strokeColor(PDF.rule)
          .stroke()
          .restore();
        doc.y = y + 4;
      } else doc.moveDown(0.2);
    } else if (b.t === 'hr') {
      doc.moveDown(0.4);
      const y = doc.y;
      doc
        .save()
        .moveTo(left, y)
        .lineTo(left + width, y)
        .lineWidth(0.6)
        .strokeColor(PDF.rule)
        .stroke()
        .restore();
      doc.y = y + 6;
    } else if (b.t === 'li') {
      if (prev && prev.t === 'p') doc.moveDown(0.3);
      const indent = 14;
      const y = doc.y;
      doc
        .font('Helvetica')
        .fontSize(PDF.body)
        .text(b.marker, left + 2, y, { width: indent, lineBreak: false });
      doc.y = y;
      write(b.spans, left + indent, width - indent, PDF.body);
      doc.moveDown(0.15);
    } else {
      if (prev && prev.t !== 'h') doc.moveDown(0.5);
      write(b.spans, left, width, PDF.body);
    }
  });
  doc.end();
  return done;
}

// -------------------------------------------------------------------- docx

const DOCX_SIZE = { body: 21, h1: 36, h2: 24, h3: 22 }; // half-points

const docxRuns = (spans: Span[], o: { size?: number; bold?: boolean } = {}) =>
  spans.map(
    (s) =>
      new TextRun({
        text: s.text,
        bold: Boolean(s.bold || o.bold),
        italics: Boolean(s.italic),
        ...(o.size ? { size: o.size } : {}),
      }),
  );

/** A DOCX: Calibri, one column, Word heading styles (Heading1..3) and Word bullets, so ATS parsers see structure. */
export function renderDocx(md: string, meta: { title: string }): Promise<Buffer> {
  const children = parseMarkdown(md).map((b) => {
    if (b.t === 'h') {
      const heading = b.level === 1 ? HeadingLevel.HEADING_1 : b.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
      return new Paragraph({
        heading,
        spacing: { before: b.level === 1 ? 0 : 240, after: 80 },
        ...(b.level === 2 ? { border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: '888888', space: 2 } } } : {}),
        children: docxRuns(b.spans),
      });
    }
    if (b.t === 'hr')
      return new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: '888888', space: 2 } }, children: [] });
    if (b.t === 'li')
      return b.marker === '•'
        ? new Paragraph({ bullet: { level: 0 }, spacing: { after: 40 }, children: docxRuns(b.spans) })
        : new Paragraph({
            spacing: { after: 40 },
            indent: { left: 360, hanging: 360 },
            children: docxRuns([{ text: `${b.marker}\t` }, ...b.spans]),
          });
    return new Paragraph({ spacing: { after: 120 }, alignment: AlignmentType.LEFT, children: docxRuns(b.spans) });
  });
  const heading = (id: string, name: string, size: number) => ({
    id,
    name,
    basedOn: 'Normal',
    next: 'Normal',
    quickFormat: true,
    run: { font: 'Calibri', size, bold: true, color: '111111' },
  });
  const doc = new Document({
    title: meta.title,
    creator: 'Perfect Placement',
    styles: {
      default: { document: { run: { font: 'Calibri', size: DOCX_SIZE.body, color: '111111' } } },
      paragraphStyles: [
        heading('Heading1', 'Heading 1', DOCX_SIZE.h1),
        heading('Heading2', 'Heading 2', DOCX_SIZE.h2),
        heading('Heading3', 'Heading 3', DOCX_SIZE.h3),
      ],
    },
    sections: [{ properties: { page: { margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } }, children }],
  });
  return Packer.toBuffer(doc);
}

/** MIME type per rendered format. */
export const RENDER_MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const;
