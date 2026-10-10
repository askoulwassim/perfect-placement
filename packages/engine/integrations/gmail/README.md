# packages/engine/integrations/gmail

Gmail adapter: create draft only. Never send.

## Shape

- `GmailDraftClient.createDraft({ to | null, subject, body })` is the only write. No send method exists.
- `createGmailApiClient({ accessToken, fetch })`: `POST gmail/v1/users/me/drafts` only. Scope `gmail.compose`.
- `createDryRunGmail()`: in-memory drafts (`dryrun-<n>`), for tests and dry runs.
- `buildMime`: RFC 2822 plain text, CR/LF stripped from headers.
- `GmailContactsSource.searchByDomain(domain)`: optional read used by `people.find`; no implementation in Wave 1.

## Auth

The connect skill creates drafts through the Gmail MCP connector in the agent session (`docs/wave1-decisions.md` #5). `createGmailApiClient` stays available for an OAuth path with `gmail.compose`. Tokens always live outside the repo.
