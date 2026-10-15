import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type PolicyConfig,
  type RenderDoc,
  type Skill,
  VOICE_LEARN_MAX_EMAILS,
  VOICE_LEARN_MAX_POSTS,
  VOICE_LEARN_SAMPLES_MAX,
} from '@perfect-placement/contracts';
import { CHROME_PREFIX, GMAIL_DRAFT_TOOL, GMAIL_GET_DRAFT_TOOL, GMAIL_UPDATE_TOOL, isConnectorTool, skillAllowedTools } from './grants.js';
import { MCP_SERVER_NAME } from './mcp-server.js';

/* A headless run's prompt (shared by every runner): run ids, the run's tools, the SKILL.md and its companion files. */

export interface PromptContext {
  runId: string;
  skill: Skill;
  roleId?: string;
  contactId?: string;
  /** `connect` (#82): config.linkedin and today's remaining profile budget, stated in the prompt. */
  linkedin?: PolicyConfig['linkedin'] & { budget_left: number };
  /** `fill` (#81): the vault path of questions the user pasted (`apply.set_questions`); answer those, no portal read. */
  questions?: string;
  /** `fill` (#106): the fill assist (Open and fill): upload the PDFs and fill the answer fields, stop before Submit. */
  assist?: boolean;
  /**
   * `fill` with assist (#123): the PDFs the engine rendered before launch (absolute paths, in `dir`, the one folder the
   * session may read), or why rendering failed (then the run uploads nothing and reports both as skipped).
   */
  uploads?: AssistUploads;
  /** `voice` (#76): whether LinkedIn posts may be read (config.linkedin.mode is `live`) and the page cap. */
  voice?: { linkedin: boolean; max_pages: number };
}

/** The fill assist's rendered PDFs (#123): absolute paths in the role's `files/<role_id>/` folder, or the render error. */
export type AssistUploads = { dir: string; files: Array<{ doc: RenderDoc; abs_path: string }> } | { error: string };

/**
 * Companion files that ship next to a skill's SKILL.md in the repo and are inlined into its prompt.
 * Skill files live in the repo, never the vault: a headless run must not look for them with vault.read.
 * (`connect/RUNBOOK.md` is a human runbook for a supervised live run; it is not inlined.)
 */
export const SKILL_ASSETS: Readonly<Partial<Record<Skill, readonly string[]>>> = {
  scout: ['plan.md'],
  onboard: ['extract.md'],
};

function readAsset(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : `(not found at ${file})`;
}

/**
 * The prompt: the run ids, the tools this run has, the skill's SKILL.md and its companion files
 * (read from the repo by absolute path), and the closing instruction.
 */
export function skillPrompt(skillsDir: string, c: PromptContext): string {
  const file = join(skillsDir, c.skill, 'SKILL.md');
  const skill = existsSync(file) ? readFileSync(file, 'utf8').trim() : `# ${c.skill}\n\n(SKILL.md not found at ${file})`;
  const ids = [`run_id: ${c.runId}`, ...(c.roleId ? [`role_id: ${c.roleId}`] : []), ...(c.contactId ? [`contact_id: ${c.contactId}`] : [])];
  const live = c.voice ? c.voice.linkedin : c.linkedin ? c.linkedin.mode === 'live' : true;
  const extra = skillAllowedTools(c.skill, { linkedin: live, assist: c.assist === true }).slice(1);
  const assets = (SKILL_ASSETS[c.skill] ?? []).map((name) => {
    const abs = join(skillsDir, c.skill, name);
    return `## ${name} (skill file, ${abs})\n\n${readAsset(abs)}`;
  });
  return [
    `You are running the Perfect Placement "${c.skill}" skill headless. Every read and write goes through the ${MCP_SERVER_NAME} MCP tools; never edit files or the database directly. Never submit an application or send an email.`,
    '',
    ids.join('\n'),
    '',
    `The run already exists (runs.start was called for you). Pass run_id in your work and finish with runs.finish { run_id: "${c.runId}", status }.`,
    '',
    `Tools: the ${MCP_SERVER_NAME} MCP tools${extra.length ? ` and ${extra.join(', ')}` : ''}, nothing else. The skill's files (SKILL.md${assets.length ? `, ${(SKILL_ASSETS[c.skill] ?? []).join(', ')}` : ''}) are below; they live in the repo, not the vault, so never look for them with vault.read.`,
    `If a tool you need is denied or missing, do not work around it: finish with runs.finish { run_id: "${c.runId}", status: "error", summary: { error: "tool denied: <tool>", denied_tools: ["<tool>"] }, note: "<what you could not do>" }.`,
    ...(extra.some(isConnectorTool) ? [connectorLine(c.runId)] : []),
    ...(c.linkedin ? ['', linkedinLine(c.linkedin)] : []),
    ...(c.skill === 'fill' ? ['', fillLine(c.questions, c.assist === true)] : []),
    ...(c.skill === 'fill' && c.assist === true ? [uploadsLine(c.uploads)] : []),
    ...(extra.some((t) => t.startsWith(CHROME_PREFIX)) ? ['', tabsLine(c.skill === 'fill' && c.assist === true)] : []),
    ...(c.voice ? ['', voiceLine(c.voice)] : []),
    '',
    skill,
    ...(assets.length ? ['', ...assets] : []),
  ].join('\n');
}

/**
 * The connector line of a prompt (#122): a granted connector tool that is not loaded in this session is not a denial.
 * The run reports `error_code: "connector_unavailable"` and the engine retries it once after a short delay.
 */
export function connectorLine(runId: string): string {
  return `If a Gmail or Claude in Chrome tool listed above is not available in this session at all (not loaded, as opposed to denied), do nothing else and finish with runs.finish { run_id: "${runId}", status: "error", error_code: "connector_unavailable", error: "connector_unavailable: <tool>" }. The engine retries the run once a little later.`;
}

/** The LinkedIn line of a `connect` prompt (#82): mode, caps and today's budget, from config. */
export function linkedinLine(l: NonNullable<PromptContext['linkedin']>): string {
  if (l.mode !== 'live')
    return `LinkedIn: off for this run (config.linkedin.mode = ${l.mode}). Do not open LinkedIn; call people.find with linkedin: { pages_opened: 0 } and no linkedin hints.`;
  return `LinkedIn (read-only via Claude in Chrome): at most ${l.max_pages_per_run} pages this run, ${l.budget_left} profiles left today (of ${l.max_profiles_per_day}), at most ${l.max_mutual_expansions} mutual lists, wait ${l.min_delay_s} to ${l.min_delay_s * 2} s before every page. Never message, connect, follow, like or click a button.`;
}

/**
 * The portal line of a `fill` prompt (#81): pasted questions on file, or read the portal read-only. With the
 * fill assist (#106) a second line: upload the rendered PDFs and fill the answer fields, stop before Submit.
 */
export function fillLine(questions?: string, assist = false): string {
  const read = questions
    ? `Questions: the user pasted this portal's questions (vault.read { path: "${questions}" }). Answer exactly those; do not read the portal for questions.`
    : `Portal (${assist ? 'read first' : 'read-only'} via Claude in Chrome): open the apply page in the session's tab and read every tab and step by navigating to its URL (find the tab and step links). Never click, type${assist ? '' : ', fill a field, upload'} or submit. If the questions stay unreadable, finish with status "error" and note "portal questions unreadable" so the user can paste them.`;
  return assist ? `${read}\n${FILL_ASSIST_LINE}` : read;
}

/**
 * The Chrome tabs line of a Chrome run's prompt (#107): reuse the session's tab, never leave an empty extra one,
 * close only the tabs the run used, report them on runs.finish. The fill assist leaves its portal tab open.
 */
export function tabsLine(assist = false): string {
  return [
    'Chrome tabs: first call tabs_context_mcp and reuse the tab this session created (navigate it); call tabs_create_mcp only if no tab is usable, so no empty extra tab is left. Never touch, navigate or close a tab the user already had open.',
    assist
      ? 'At the end (done or failed), leave the portal tab open for the user to submit and close every other tab you opened or used with tabs_close_mcp. Report them in runs.finish: tabs: { opened: [<every tab id you used>], closed: [<ids you closed>], left_open: [<portal tab id>], portal: <portal tab id> }.'
      : 'At the end (done or failed), close every tab you opened or used with tabs_close_mcp. Report them in runs.finish: tabs: { opened: [<every tab id you used>], closed: [<ids you closed>], left_open: [] }.',
  ].join('\n');
}

/** The fill assist line (#106): the user clicked Open and fill and is watching. */
export const FILL_ASSIST_LINE =
  'Fill assist (the user clicked Open and fill): after apply.fill, in the portal tab you read (reuse it, no new tab), upload the resume PDF (and the cover letter PDF where the portal takes one) with file_upload, passing each file\'s absolute path exactly as the Uploads line gives it (paths: ["/..."], never a vault-relative files/... path), and fill each answer field from the saved Answers with form_input (find / read_page to locate fields). Never click, press a key, run script or submit, and never touch a Submit, Apply or Send control. Leave the portal tab open on the last step, report with apply.fill_done { role_id, filled, uploaded, skipped }, then finish. The user reviews and submits.';

/**
 * The Uploads line of a fill assist prompt (#123). The engine renders the PDFs before launch and the session may
 * read only that role's folder (`--add-dir`), so it uploads those absolute paths. Rendering failed: upload nothing,
 * report both documents as skipped with the reason. No `uploads` (a prompt built outside the run queue): render here.
 */
export function uploadsLine(u?: AssistUploads): string {
  if (!u) return 'Uploads: call apply.render_documents { role_id, formats: ["pdf"] } and upload each returned abs_path (absolute).';
  if ('error' in u) {
    const reason = `render failed: ${u.error}`.replace(/"/g, "'");
    return `Uploads: none. Rendering the PDFs failed before launch (${u.error}). Upload nothing and do not call apply.render_documents; fill the answer fields, then report apply.fill_done with uploaded: [] and skipped including { label: "Resume", reason: "${reason}" } and { label: "Cover letter", reason: "${reason}" }.`;
  }
  const files = u.files.map((f) => `${f.doc}: ${f.abs_path}`).join(', ');
  return `Uploads: rendered before launch, the only folder you can read is ${u.dir}. Upload these absolute paths with file_upload: ${files}. Do not render them again.`;
}

/** The sources line of a `voice` prompt (#76): Gmail sent mail read-only, LinkedIn posts only when live, caps. */
export function voiceLine(v: NonNullable<PromptContext['voice']>): string {
  const gmail = `Gmail (read-only): only messages the user sent (search "in:sent", newest first), at most ${VOICE_LEARN_MAX_EMAILS}. Never read received mail beyond the user's own words, never draft, send, label or delete.`;
  const li = v.linkedin
    ? `LinkedIn (read-only via Claude in Chrome): only the user's own recent posts (their profile's activity page), at most ${VOICE_LEARN_MAX_POSTS} posts and ${v.max_pages} pages. Never like, comment, message, connect, follow or click a button.`
    : 'LinkedIn: off for this run (config.linkedin.mode is not live). Do not open LinkedIn; report linkedin_posts: 0.';
  return `${gmail}\n${li}\nPropose at most ${VOICE_LEARN_SAMPLES_MAX} short samples with profile.propose_voice; never apply the diff.`;
}

/** The `## Gmail draft step` section of a SKILL.md (up to the next `## ` heading), or null. */
export function gmailStepSection(skillMd: string): string | null {
  const m = /^## Gmail draft step\b[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(skillMd);
  return m ? `## Gmail draft step\n${m[1]}`.trim() : null;
}

/**
 * The prompt for a `connect` run scoped to one outreach (Gmail via agent): read the draft, create a
 * Gmail DRAFT with the agent's own Gmail tool (never send), record it with outreach.to_gmail.
 */
export function gmailDraftPrompt(skillsDir: string, c: { runId: string; outreachId: string; roleId: string; contactId: string }): string {
  const file = join(skillsDir, 'connect', 'SKILL.md');
  const section = existsSync(file) ? gmailStepSection(readFileSync(file, 'utf8')) : null;
  return [
    `You are running the Perfect Placement "connect" skill headless, Gmail draft step only. Every Perfect Placement read and write goes through the ${MCP_SERVER_NAME} MCP tools; never edit files or the database directly. Never send an email: create a Gmail DRAFT only. Never submit an application.`,
    '',
    [`run_id: ${c.runId}`, `outreach_id: ${c.outreachId}`, `role_id: ${c.roleId}`, `contact_id: ${c.contactId}`].join('\n'),
    '',
    '1. Read the draft: outreach_get { outreach_id }. Subject = its subject (if null: the role title from roles_get, then " at " and the company name). Body = its `body` field, exactly as returned (greeting, Hook, Proof, Ask, sign-off; plain text).',
    '2. Recipient: outreach_get returns `to` (the contact, or the mutual for a bridge draft). To = `to.email`. If `to.decision_id` is set (a guessed address waiting in Needs you), or `outreach.status` is not `drafted`, or `outreach.gmail_draft_id` is set, create nothing: finish ok with summary { outreach_id, skipped: "email pending" or "already in Gmail" } (the engine queues this step again once the address is confirmed). If `to.email` and `to.guess` are both null (the recipient has no address at all), create nothing: finish ok with summary { outreach_id, skipped: "no email" } (never a Gmail draft without To; the draft stays in the vault). If `to.email` is null otherwise, leave To empty (`to.reason` says why); never use `to.guess`.',
    `3. Create a Gmail DRAFT with your Gmail draft tool (Claude Code: the Gmail connector's create_draft), once. Never call send, reply or forward. If your Gmail draft tool is not available in this session, create nothing and finish with runs_finish { run_id: "${c.runId}", status: "error", error_code: "connector_unavailable", error: "connector_unavailable: ${GMAIL_DRAFT_TOOL}" } (the engine retries the step once a little later).`,
    `4. Record it: outreach_to_gmail { outreach_id: "${c.outreachId}", gmail_draft_id: "<the id your tool returned>", confidence: <0 to 1, how sure you are the draft matches> }.`,
    `5. Finish: runs_finish { run_id: "${c.runId}", status: "ok", summary: { outreach_id: "${c.outreachId}", gmail_draft_id, to: <the To you used or null>, to_reason: <to.reason when To is empty> } } (status "error" with a note if any step failed).`,
    ...(section ? ['', section] : []),
  ].join('\n');
}

/**
 * The prompt for the To update step (#99): an in-Gmail draft was created with no To while its address was
 * a guess; now the address is confirmed. Read the Gmail draft, set its To (keep subject and body exactly as
 * they are in Gmail: the user may have edited them), record it with outreach.to_gmail. Never send.
 */
export function gmailToPrompt(skillsDir: string, c: { runId: string; outreachId: string; roleId: string; contactId: string }): string {
  const file = join(skillsDir, 'connect', 'SKILL.md');
  const md = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const m = /^## Gmail To step\b[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(md);
  return [
    `You are running the Perfect Placement "connect" skill headless, Gmail To step only. Every Perfect Placement read and write goes through the ${MCP_SERVER_NAME} MCP tools; never edit files or the database directly. Never send an email: only set the To of an existing Gmail DRAFT. Never submit an application.`,
    '',
    [`run_id: ${c.runId}`, `outreach_id: ${c.outreachId}`, `role_id: ${c.roleId}`, `contact_id: ${c.contactId}`].join('\n'),
    '',
    '1. Read the record: outreach_get { outreach_id }. The Gmail draft id is `outreach.gmail_draft_id`; To = `to.email` (confirmed). If `to.email` is null, change nothing and finish the run as error with a note.',
    `2. Read the Gmail draft with ${GMAIL_GET_DRAFT_TOOL} (that id). Keep its subject and body exactly as they are in Gmail. If ${GMAIL_GET_DRAFT_TOOL} or ${GMAIL_UPDATE_TOOL} is not available in this session, change nothing and finish with runs_finish { run_id: "${c.runId}", status: "error", error_code: "connector_unavailable", error: "connector_unavailable: <tool>" } (the engine retries the step once a little later).`,
    `3. Set its To with ${GMAIL_UPDATE_TOOL}: the same draft id, To = \`to.email\`, the subject and body you just read. Never call send, reply, forward, create_draft or delete.`,
    `4. Record it: outreach_to_gmail { outreach_id: "${c.outreachId}", gmail_draft_id: "<the same draft id>", confidence: <0 to 1, how sure you are the draft now has this To> }.`,
    `5. Finish: runs_finish { run_id: "${c.runId}", status: "ok", summary: { outreach_id: "${c.outreachId}", gmail_draft_id, to: <the To you set> } } (status "error" with a note if any step failed).`,
    ...(m ? ['', `## Gmail To step\n${m[1]}`.trim()] : []),
  ].join('\n');
}
