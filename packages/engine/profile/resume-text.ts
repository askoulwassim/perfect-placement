import { inflateRawSync } from 'node:zlib';

/*
 * Text out of an uploaded resume (#38), so the source is kept and every later fact can be checked
 * against it. PDF through `unpdf` (pdf.js, no native deps); DOCX by reading word/document.xml out of
 * the zip (node:zlib only); MD / TXT as UTF-8. Text is copied, never rewritten.
 */

export type ResumeKind = 'pdf' | 'docx' | 'md' | 'txt';

export function resumeKind(name: string, bytes?: Uint8Array): ResumeKind | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'txt' || ext === 'text') return 'txt';
  if (bytes && bytes.length > 4) {
    const head = Buffer.from(bytes.subarray(0, 5)).toString('latin1');
    if (head === '%PDF-') return 'pdf';
    if (head.startsWith('PK\u0003\u0004')) return 'docx';
  }
  return null;
}

// ------------------------------------------------------------------ docx

/** One file out of a zip archive (stored or deflated), or null. */
export function unzipEntry(zip: Uint8Array, wanted: string): Buffer | null {
  const b = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  // End of central directory: signature 0x06054b50 within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= b.length; n++) {
    if (b.readUInt32LE(p) !== 0x02014b50) return null;
    const method = b.readUInt16LE(p + 10);
    const size = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== wanted) continue;
    if (b.readUInt32LE(local) !== 0x04034b50) return null;
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const data = b.subarray(start, start + size);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return inflateRawSync(data);
    return null;
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? _m;
  });

/** Paragraph text from word/document.xml: headings as `#`, list items as `- `, tabs and breaks kept. */
export function docxXmlToText(xml: string): string {
  const body = /<w:body[^>]*>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  const out: string[] = [];
  for (const m of body.matchAll(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g)) {
    const p = m[0];
    let raw = '';
    for (const t of p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:(?:br|cr)\/>/g)) {
      if (t[1] !== undefined) raw += t[1];
      else raw += t[0] === '<w:tab/>' ? '\t' : '\n';
    }
    const text = decode(raw);
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? '';
    const level = /^(?:Heading|heading)\s*(\d)$/.exec(style)?.[1] ?? (style === 'Title' ? '1' : null);
    const list = /<w:numPr>/.test(p) || /^List/i.test(style);
    const line = text.trimEnd();
    if (!line.trim()) out.push('');
    else if (level) out.push(`${'#'.repeat(Number(level))} ${line.trim()}`);
    else if (list) out.push(`- ${line.trim()}`);
    else out.push(line);
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ------------------------------------------------------------------- pdf

async function pdfText(bytes: Uint8Array): Promise<string> {
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let s = '';
    for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
      if (typeof item.str !== 'string') continue;
      s += item.str + (item.hasEOL ? '\n' : '');
    }
    pages.push(s.replace(/[ \t]+\n/g, '\n').trim());
  }
  await pdf.cleanup?.();
  return pages.join('\n\n').trim();
}

/** The text of a resume upload. Throws when the kind is unsupported or nothing readable came out. */
export async function extractResumeText(name: string, bytes: Uint8Array): Promise<{ kind: ResumeKind; text: string }> {
  const kind = resumeKind(name, bytes);
  if (!kind) throw new Error(`unsupported resume file: ${name} (PDF, DOCX, MD or TXT)`);
  let text: string;
  if (kind === 'pdf') text = await pdfText(bytes);
  else if (kind === 'docx') {
    const xml = unzipEntry(bytes, 'word/document.xml');
    if (!xml) throw new Error(`${name}: not a readable DOCX`);
    text = docxXmlToText(xml.toString('utf8'));
  } else text = Buffer.from(bytes).toString('utf8');
  text = text.replace(/\r\n?/g, '\n').trim();
  if (!text) throw new Error(`${name}: no text found (a scanned PDF needs OCR first)`);
  return { kind, text };
}
