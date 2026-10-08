# packages/engine/integrations/gmail

**Owner: lane H** (`docs/v2/lanes/`). Only lane H writes here.

Gmail adapter: create draft only. Never send.

## Shape

- `GmailDraftClient.createDraft({ to | null, subject, body })` is the only write. No send method exists.
- `createGmailApiClient({ accessToken, fetch })`: `POST gmail/v1/users/me/drafts` only. Scope `gmail.compose`.
- `createDryRunGmail()`: in-memory drafts (`dryrun-<n>`), for tests and dry runs.
- `buildMime`: RFC 2822 plain text, CR/LF stripped from headers.
- `GmailContactsSource.searchByDomain(domain)`: optional read used by `people.find`; no implementation in Wave 1.

## Wave 2

Pick the auth path with Wassim (OAuth app with `gmail.compose`, or the Gmail MCP connector behind the same interface). Tokens live outside the repo.
