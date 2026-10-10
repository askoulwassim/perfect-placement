/*
 * SYNTHETIC inputs for lane E tests. A made-up person ("Jordan Example") so the resume
 * parser is exercised. Never real data.
 */

export const SYNTH_RESUME = `# Jordan Example - Master Resume

**Title:** Principal Product Manager, Data Platforms
**Contact:** jordan@example.com • 555.010.0000 • linkedin.com/in/jordan-example

## Profile

Product leader who builds data platforms and ML products. Ten years across startups and a public company.

## Experience

### Acme Data — Principal Product Manager, Analytics — Mar 2022–Present
- **Self-serve analytics:** Launched a self-serve analytics product used by 120 teams.
- **Cost:** Cut warehouse spend 30% with usage-based pricing.
- Mentored four PMs.

### Widget Labs — Senior Product Manager — 2018–2022
- Grew API revenue from 1M to 6M ARR.

### Early roles — Analyst — 2016–2018
- Built the first churn model.

## Skills & Toolkit
- SQL, Python, dbt
- Experimentation

## Education & Continuous Learning
- BS, Example State University
`;

/** A SYNTHETIC resume that states no years (the old parser guessed 26 from the 2000 degree date). */
export const SYNTH_RESUME_NO_YEARS = `# Riley Sample

**Title:** Senior Product Manager

## Experience

### Northwind Analytics — Senior Product Manager — Jan 2019–Present
- Shipped a forecasting product used by 85 customers.

### Contoso Retail — Product Analyst — 2016–2018
- Built the weekly demand dashboard.

## Education
- MBA, Example Business School, 2000
`;

/**
 * A SYNTHETIC resume unlike SYNTH_RESUME (#22): an engineer in healthcare who writes long, formal
 * sentences without metrics. Its interview must differ noticeably from Jordan's.
 */
export const SYNTH_RESUME_ENGINEER = `# Casey Placeholder

**Title:** Staff Software Engineer, Clinical Systems

## Summary

Engineer who has spent the better part of a decade designing dependable clinical software that hospital care teams rely upon during every shift, with a particular focus on interoperability between electronic health record systems and bedside devices.

## Experience

### Mercy Example Health — Staff Software Engineer — 2021–Present
- Led the redesign of the medication administration workflow so that nurses and clinicians could verify patient identity and dosage information without leaving the bedside device they were already using.
- Partnered with clinical informatics and hospital compliance teams to define the integration contracts between the EHR and the pharmacy systems used across the network.

### Sample Clinic Software — Software Engineer — 2017–2021
- Maintained the scheduling services that patients and front desk staff used to book and reschedule appointments across the clinic network and its affiliated hospitals.
`;

/**
 * A SYNTHETIC salesperson's resume (#74): its interview options and scout titles must be sales ones, not
 * product ones.
 */
export const SYNTH_RESUME_SALES = `# Morgan Placeholder

**Title:** Senior Enterprise Account Executive

## Summary

Closer who builds pipeline with fintech and payments buyers. Eight years of experience in B2B SaaS sales.

## Experience

### Ledgerly Example — Senior Enterprise Account Executive — 2021–Present
- Closed 4.2M in new ARR across payments and banking accounts in 2024.
- Ran 140% of quota for three years.

### Paysample Inc — Account Executive — 2018–2021
- Opened 30 new mid-market payments accounts.

### Paysample Inc — Sales Development Rep — 2016–2018
- Booked 90 qualified meetings a quarter.
`;

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A minimal SYNTHETIC .docx (zip, stored or deflated) with one paragraph per entry; `#` marks a heading, `- ` a list item. */
export function synthDocx(paragraphs: string[], deflate: (b: Buffer) => Buffer = (b) => b): Buffer {
  const body = paragraphs
    .map((p) => {
      const h = /^(#+)\s+(.*)$/.exec(p);
      const li = /^-\s+(.*)$/.exec(p);
      const props = h
        ? `<w:pPr><w:pStyle w:val="Heading${h[1]?.length}"/></w:pPr>`
        : li
          ? '<w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr>'
          : '';
      const text = h ? (h[2] ?? '') : li ? (li[1] ?? '') : p;
      return `<w:p>${props}<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
    })
    .join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const entries: Array<[string, Buffer]> = [
    ['[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>')],
    ['word/document.xml', Buffer.from(xml, 'utf8')],
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, raw] of entries) {
    const data = deflate(raw);
    const method = data === raw ? 0 : 8;
    const n = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A minimal SYNTHETIC one-page PDF (Helvetica, one text line per entry). */
export function synthPdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = `BT /F1 11 Tf 14 TL 50 760 Td ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * A SYNTHETIC resume with a full contact header (#124): name line, email, phone, city and LinkedIn. A made-up
 * person at reserved example values (555-01xx numbers, example.com); never real data.
 */
export const SYNTH_RESUME_CONTACT = `# Avery Testperson - Resume

**Title:** Senior Data Product Manager
avery.testperson@example.com | +1 (555) 010-0142 | Springfield, IL | linkedin.com/in/avery-testperson

## Experience

### Example Metrics Co — Senior Data Product Manager — 2020–Present
- Shipped a metrics layer used by 40 teams.

### Sample Retail — Product Analyst — 2017–2020
- Built the weekly demand dashboard.
`;
