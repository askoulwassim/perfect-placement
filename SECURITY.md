# Security

## Reporting a vulnerability

Please report security issues privately through GitHub: on this repository's **Security** tab, choose **Report a vulnerability**. Don't open a public issue, and don't include anyone's personal data in the report.

You'll get an acknowledgement within a week. Fixes land on `main` and in the next release.

## Supported versions

Security fixes land on `main` while the project is pre-1.0.

## What pp promises

Perfect Placement runs on your machine and keeps your data there. Reports that break any of these are in scope:

- **Local only.** `pp up` serves the web UI, the API and MCP on `127.0.0.1`, checks the `Host` header against DNS rebinding, and allows cross-origin requests only from loopback origins.
- **Your data stays in your vault.** Profile, pipeline, applications and contacts live in `PP_HOME` (default `~/.perfect-placement`) and never in this repository. A new vault is created owner-only (folders 0700, `config.json` and `pp.db` 0600).
- **No external actions on its own.** pp never submits an application or sends an email or message. pp's own code only ever creates Gmail drafts; LinkedIn reads are read-only, capped and slow.
- **Least privilege for agent runs.** With the default `claude` runner, each headless skill run gets an explicit per-skill tool allowlist (`SKILL_TOOLS` in `packages/engine/ops/runner.ts`), and Gmail tools beyond reading and creating (or, for one step, updating) drafts are denied. The `codex` and `cursor-agent` runners rely on those agents' own permission settings and configured MCP servers, so review those if you use them.
- **No keys in the repo.** Optional keys (`KEV_API_KEY`, `ANTHROPIC_API_KEY`) are read from the environment and never stored.

Out of scope: issues that need an attacker who already controls your user account or your agent session.
