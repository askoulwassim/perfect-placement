import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertV1Profile, renderConversionReport, V1_FILES, type V1Inputs, type V1Source, verifyCoverage } from './convert-v1.js';

/*
 * Dry-run the v1 converter: reads a v1 repo READ-ONLY and writes conversion.json + report.md
 * to an output dir OUTSIDE any git repo. Never point outDir inside the system repo.
 *   node packages/engine/dist/profile/convert-v1-cli.js <v1-root> <out-dir>
 */

export function readV1Inputs(v1Root: string): V1Inputs {
  const out: V1Inputs = {};
  for (const [k, rel] of Object.entries(V1_FILES) as Array<[V1Source, string]>) {
    const p = join(v1Root, rel);
    if (existsSync(p)) out[k] = readFileSync(p, 'utf8');
  }
  return out;
}

export function runV1Conversion(v1Root: string, outDir: string, now = new Date()) {
  const inputs = readV1Inputs(v1Root);
  const conv = convertV1Profile(inputs, now);
  const coverage = verifyCoverage(inputs, conv);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'conversion.json'), `${JSON.stringify(conv, null, 2)}\n`);
  writeFileSync(join(outDir, 'report.md'), renderConversionReport(conv, coverage, true));
  return { conv, coverage };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [v1Root, outDir] = process.argv.slice(2);
  if (!v1Root || !outDir) {
    console.error('usage: convert-v1-cli <v1-root> <out-dir>');
    process.exit(2);
  }
  const { coverage } = runV1Conversion(v1Root, outDir);
  console.log(coverage.ok ? 'nothing dropped' : 'MISSING content, see report.md');
  for (const f of coverage.files) console.log(`${f.source}: ${f.covered}/${f.lines}`);
  process.exit(coverage.ok ? 0 : 1);
}
