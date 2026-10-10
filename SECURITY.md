# Security

## Reporting a vulnerability

Please report security issues privately through GitHub: on this repository's **Security** tab, choose **Report a vulnerability**. Don't open a public issue, and don't include anyone's personal data in the report.

You'll get an acknowledgement within a week. Fixes land on `main` and in the next release.

## Supported versions

Only the latest release and `main` get security fixes while the project is pre-1.0.

## What pp promises

Perfect Placement runs on your machine and keeps your data there. Reports that break any of these are in scope:

- **Local only.** `pp up` serves the web UI, the API and MCP on `127.0.0.1`, checks the `Host` header against DNS rebinding, and allows cross-origin requests only from loopback origins.
- **Your data stays in your vault.** Profile, pipeline, applications and contacts live in `PP_HOME` (default `~/.perfect-placement`) and never in this repository.
- **No external actions on its own.** pp never submits an application or sends an email or message. Gmail access is read plus draft only; LinkedIn is read-only, capped and slow.
- **Least privilege for agent runs.** Headless skill runs get an explicit tool allowlist per skill (`SKILL_TOOLS` in `packages/engine/ops/runner.ts`); everything else is denied.
- **No keys in the repo.** Optional keys (`KEV_API_KEY`, `ANTHROPIC_API_KEY`) are read from the environment and never stored.

Out of scope: issues that need an attacker who already controls your user account or your agent session.
