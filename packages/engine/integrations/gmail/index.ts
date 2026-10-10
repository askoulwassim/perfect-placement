/*
 * Gmail adapter (lane H). Create draft only. Never send.
 *
 * The client interface has exactly one write: `createDraft`. There is no send method, and the HTTP
 * client below only ever calls `POST /gmail/v1/users/me/drafts` (never `/drafts/send` or
 * `/messages/send`). Scope needed: `https://www.googleapis.com/auth/gmail.compose`.
 *
 * Modes:
 * - `createDryRunGmail()`: records drafts in memory, returns `dryrun-<n>` ids. Tests and dry runs.
 * - `createGmailApiClient({ accessToken, fetch })`: real Gmail REST drafts endpoint. A caller supplies
 *   the token source (OAuth on the user's account) or swaps in an MCP-backed client with the same interface.
 */

// Lane H owns this folder.
export const OWNER_LANE = 'H' as const;

export interface DraftInput {
  /** Empty when the contact has no known email; the human fills it in Gmail. */
  to: string | null;
  subject: string;
  /** Plain text body. */
  body: string;
}

export interface DraftResult {
  draftId: string;
}

/** A sender-free Gmail client: drafts only. */
export interface GmailDraftClient {
  readonly mode: 'dry-run' | 'live';
  createDraft(input: DraftInput): Promise<DraftResult>;
}

/** Optional Gmail read used by people.find (people the user has emailed at a company domain). */
export interface GmailContactsSource {
  searchByDomain(domain: string): Promise<Array<{ name: string; email: string }>>;
}

// --------------------------------------------------------------------------- MIME

const encodeHeader = (s: string): string => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

const noCrlf = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim();

/** RFC 2822 message (UTF-8 plain text). Header values are stripped of CR/LF (header injection). */
export function buildMime(input: DraftInput): string {
  const headers = [
    ...(input.to ? [`To: ${noCrlf(input.to)}`] : []),
    `Subject: ${encodeHeader(noCrlf(input.subject))}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${input.body.replace(/\r?\n/g, '\r\n')}`;
}

export const toBase64Url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

// ------------------------------------------------------------------------ clients

export const GMAIL_DRAFTS_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/drafts';

export interface GmailApiOptions {
  /** Returns a valid OAuth access token with the gmail.compose scope. */
  accessToken: () => Promise<string>;
  fetch?: typeof fetch;
}

export function createGmailApiClient(opts: GmailApiOptions): GmailDraftClient {
  const f = opts.fetch ?? fetch;
  return {
    mode: 'live',
    async createDraft(input) {
      const res = await f(GMAIL_DRAFTS_ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${await opts.accessToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message: { raw: toBase64Url(buildMime(input)) } }),
      });
      if (!res.ok) throw new Error(`gmail drafts.create failed: ${res.status}`);
      const json = (await res.json()) as { id?: unknown };
      if (typeof json.id !== 'string') throw new Error('gmail drafts.create returned no id');
      return { draftId: json.id };
    },
  };
}

export interface DryRunGmail extends GmailDraftClient {
  readonly mode: 'dry-run';
  readonly drafts: Array<DraftInput & { draftId: string; mime: string }>;
}

export function createDryRunGmail(): DryRunGmail {
  const drafts: DryRunGmail['drafts'] = [];
  return {
    mode: 'dry-run',
    drafts,
    async createDraft(input) {
      const draftId = `dryrun-${drafts.length + 1}`;
      drafts.push({ ...input, draftId, mime: buildMime(input) });
      return { draftId };
    },
  };
}
