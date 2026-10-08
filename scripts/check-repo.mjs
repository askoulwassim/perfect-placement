// Repo guard: no CLAUDE.md anywhere (decisions.md #8) and no personal data paths tracked or present.
import { execSync } from 'node:child_process';

const files = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' }).split('\n').filter(Boolean);
const bad = [];
for (const f of files) {
  const base = f.split('/').pop();
  if (base === 'CLAUDE.md') bad.push(`${f}: CLAUDE.md is not allowed; use AGENTS.md`);
  if (/^(01_Profile|02_Pipeline|03_Applications|04_Interviews)\//.test(f)) bad.push(`${f}: v1 personal data folder`);
  if (/\.(pdf|docx?|db|sqlite3?)$/i.test(f)) bad.push(`${f}: binary personal-data type`);
  if (/(^|\/)\.env(\.|$)/.test(f) && !f.endsWith('.env.example')) bad.push(`${f}: env file`);
}
if (bad.length) {
  console.error(`check-repo failed:\n${bad.join('\n')}`);
  process.exit(1);
}
console.log(`check-repo: ok (${files.length} files)`);
