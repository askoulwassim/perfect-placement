import { z } from 'zod';
import { Id } from './primitives.js';

/*
 * Data home (contracts.md "Data home"). Pure constants and path builders; no fs here.
 * PP_HOME defaults to ~/.perfect-placement. It must never be inside a git repo.
 */

export const PP_HOME_ENV = 'PP_HOME';
export const PP_HOME_DEFAULT = '~/.perfect-placement';
export const DB_FILE = 'pp.db';
export const CONFIG_FILE = 'config.json';

export const VAULT_DIRS = ['profile', 'companies', 'roles', 'applications', 'interviews', 'outreach', 'files', 'runs'] as const;

export const APPLICATION_FILES = {
  resume: 'resume.md',
  cover_letter: 'cover_letter.md',
  fit_map: 'fit_map.md',
  answers: 'answers.md',
  /** Added (#81): questions the user pasted from the portal; a fill run answers these instead of reading the portal. */
  questions: 'questions.md',
} as const;

/** Added (#106): the tailored documents rendered to files, and the formats. */
export const RENDER_DOCS = ['resume', 'cover_letter'] as const;
export type RenderDoc = (typeof RENDER_DOCS)[number];
export const RENDER_FORMATS = ['pdf', 'docx'] as const;
export type RenderFormat = (typeof RENDER_FORMATS)[number];
/** The application package key a rendered file is recorded under (`resume_pdf`, `cover_letter_docx`). */
export const renderedKey = (doc: RenderDoc, format: RenderFormat) => `${doc}_${format}` as const;

/** Vault-relative path builders. Always POSIX separators. */
export const vaultPath = {
  profileComponent: (key: string) => `profile/${key}.md`,
  dossier: (companySlug: string) => `companies/${companySlug}/dossier.md`,
  role: (roleId: string) => `roles/${roleId}.md`,
  application: (roleId: string, file: keyof typeof APPLICATION_FILES) => `applications/${roleId}/${APPLICATION_FILES[file]}`,
  interviewPrep: (roleId: string) => `interviews/${roleId}/prep.md`,
  interviewRetro: (roleId: string, n: number) => `interviews/${roleId}/retro-${n}.md`,
  /** `contactId` is the recipient; `aboutId` (#98) the target a bridge intro is about. */
  outreach: (contactId: string, roleId: string, aboutId?: string | null) =>
    aboutId ? `outreach/${contactId}-${roleId}-about-${aboutId}.md` : `outreach/${contactId}-${roleId}.md`,
  file: (name: string) => `files/${name}`,
  /** Added (#106): a tailored document rendered for download and upload (`files/<role_id>/resume.pdf`). */
  rendered: (roleId: string, doc: RenderDoc, format: RenderFormat) => `files/${roleId}/${doc}.${format}`,
  /** Added (#38): a kept resume upload: its extracted text (markdown) and the original file. */
  resumeText: (stamp: string) => `files/resume-${stamp}.md`,
  resumeFile: (stamp: string, ext: string) => `files/resume-${stamp}-original.${ext}`,
  runLog: (date: string, op: string) => `runs/${date}_${op}.md`,
} as const;

export const MARKDOWN_TYPES = [
  'profile_component',
  'dossier',
  'role',
  'application_resume',
  'application_cover_letter',
  'application_fit_map',
  'application_answers',
  'application_questions',
  'interview_prep',
  'interview_retro',
  'outreach',
  'run',
  'resume_source',
] as const;

/** Every vault markdown file starts with this frontmatter. Structured fields live in the db, never parsed from markdown. */
export const Frontmatter = z.object({ id: Id, type: z.enum(MARKDOWN_TYPES) }).passthrough();
export type Frontmatter = z.infer<typeof Frontmatter>;
