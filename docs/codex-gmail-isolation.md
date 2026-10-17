# Codex Gmail isolation (#158)

2026-10-17. **Gmail on headless Codex remains blocked.** This change fails closed; it does not complete Gmail enablement. See [issue #158](https://github.com/askoulwassim/perfect-placement/issues/158) and [decision 13](decisions.md#13-codex-gmail-isolation-2026-10-17).

## Verified identity and schemas

Read-only plugin metadata identified OpenAI's Gmail plugin `plugin_connector_1p_95d39881713c8191931482a62d6edff9`, catalog `openai-curated`, local reference `gmail@openai-curated-remote`, version `0.1.10`, and connector `connector_2128aebfecb84f64a069897515042a44`. The installed `.app.json` and canonical dependency metadata agree. Headless Codex **0.163.0** connected to the built-in `codex_apps` server at the `https://chatgpt.com` origin, identifying itself as `plugin-runtime`, and returned the same connector ID on Gmail tool descriptors. No mail tool was called for this verification. Personal link/account metadata is not a fixture and must not be committed.

Interactive names such as `mcp__codex_apps__gmail_search_emails` correspond to raw MCP identifiers such as `gmail.search_emails`. In the tested headless Responses protocol, the latter appears as namespace `mcp__codex_apps__gmail`, function `_search_emails`. This is runtime normalization, not permission to select an alias or a different provider. A matching display name alone proves nothing. Arbitrary Gmail MCP servers, legacy connectors, replacement plugins and fallback tools are unsupported.

The eligible grants are defined once in `runners/codex/gmail.ts`, used by prompt bindings and the launch gate:

| Run | Eligible raw tools (currently blocked) |
| --- | --- |
| Inbox / Voice | `gmail.search_emails`, `gmail.read_email_thread`, `gmail.read_email` |
| Full Connect | those reads plus `gmail.create_draft` |
| Gmail draft step | `gmail.create_draft` |
| To update step | `gmail.update_draft` |
| Other skills / Ask | none |

All other tools, including future tools, must stay unavailable. There is no `get_draft` in this plugin.

## Runtime blocker

The real `codex exec` binary was exercised against a localhost fake Responses model and fake hosted-app MCP endpoint, with temporary HOME/config and synthetic authentication. Positive control: an allowed `gmail.search_emails` call reached the fake server. Ordinary unlisted `gmail.send_email` and `gmail.future_write` calls did not.

Two counterexamples prevent enabling this policy:

1. `apps.<connector>.default_tools_enabled=false` and an empty/restricted `tools` table do not remove explicit inherited enablement. Configuration tables merge. A preapproved inherited `gmail.send_email` remained callable.
2. The app policy matches a raw tool name **or its title**. A new fake `gmail.future_write` tool with title `gmail.search_emails` inherited the allowed read's enablement and executed. Adding `mcp_servers.codex_apps.enabled_tools=["gmail.search_emails"]` did not stop it: the built-in app server does not use that configured MCP filter.

The reproducer intentionally expects these counterexamples to execute harmless fake tools. It is evidence for the launch block, not a passing claim of exact Gmail enforcement. A finite denylist, prompt instruction, renamed proxy, alternative provider, or a default approval setting is not a substitute. Enabling Gmail needs a verified raw-identity allowlist covering discovery and invocation, followed by schema, identity, authentication, override and workflow validation.

## Launch behavior and configuration precedence

Gmail-requiring Codex runs fail before an agent launch. The run supervisor records `runs.finish { status: "error", error: "setup required: Gmail" }`. The note names the blocker. Setup failures are never retried, even if another failure field says `connector_unavailable` or mentions a timeout. Scheduled runs use the same gate and release their queue slot. Recipient confirmation, Needs you, and saved outreach records are unchanged.

Non-Gmail Codex runs and Ask use a fresh working directory and child-only settings. `exec --ignore-user-config` excludes the user configuration and its profiles; a generated `.git` sentinel bounds project discovery even when the temporary directory has a repository ancestor. HOME and CODEX_HOME are preserved for authentication and managed requirements. No persistent user setting is changed. `--ignore-rules` excludes user/project execution rules; no shell tool is granted. Managed requirements remain in force.

Before spawning the agent, a bounded, metadata-only app-server process checks the exact CLI version and reads effective configuration without starting a thread or model. Every inherited MCP name is explicitly disabled in a TOML table, including names containing dots or quotes. Only PP's own stdio `pp` and, when granted, `pp_browser` definitions are enabled afterward. Disabled entries retain an inert transport because Codex validates even disabled definitions. Apps, plugins, remote plugins, hooks, shell/unified-exec, JS REPL, freeform patch tools, subagents, built-in browser/computer automation and skill dependency installation/search are disabled. Browser site, page, upload and tool grants remain the existing PP adapter policy. Configuration inspection failure or an unverified version stops launch with the setup error.

`runner.args` accepts paired `-m`/`--model`, limited reasoning/verbosity/service-tier `-c` settings, and stricter `prompt` approvals for PP tools. Profiles, app/MCP configuration, alternative endpoints, bypass flags, feature switches and arbitrary overrides are rejected. These restrictions also apply to Ask. Other runners retain their existing argument handling and prompts.

## Sparse To updates

The full headless MCP schema says omitted or null fields preserve the draft; omitting `payload` preserves its complete MIME tree and attachments. The display-only `app/read` tool summary contained an older contradictory attachment limitation; it is insufficient for schema verification.

Codex's prepared To-step prompt uses only `{ draft_id: outreach.gmail_draft_id, to: to.email }`, after checking the saved in-Gmail state, confirmed recipient and absence of a pending email decision. It never substitutes a message ID, thread ID, guessed address or vault copy of the body. Subject, body, headers and attachments are omitted, preserving edits in Gmail. The create-draft prompt uses a MIME payload and records the returned top-level draft ID, never `message.id`.

**A tool allowlist does not constrain arguments.** The update schema permits subject, payload, other headers and labels too. The sparse instruction is a prompt binding, not an argument-level enforcement claim. These prompts are unreachable while Gmail is blocked. No live draft, MIME mutation or attachment-preservation action was tested. Claude and Cursor retain their existing read-then-update flow; shared skills keep placeholders.

## Reproducing the evidence

After the normal build, with Codex 0.163.0 installed:

```sh
PP_CODEX_RUNTIME_BIN="$(command -v codex)" pnpm --filter @perfect-placement/engine exec vitest run runners/codex/isolation.runtime.test.ts
```

The opt-in suite uses only localhost, fake credentials and fake tools; it never opens the real vault or mailbox and never writes real Codex configuration. It also tests the production zero-Gmail restrictions against forced tool calls with inherited send approvals and the title collision, an active alternate MCP endpoint, built-in browser/computer calls, and ancestor project configuration. Normal tests cover every grant, argument rejection, pre-launch blocking, error recording, nonretry, sparse prompt bindings and other-runner snapshots. Normal CI skips the binary-dependent suite. Deferred Gmail discovery with a positive grant, live authentication failure, end-to-end MIME preservation and successful Gmail workflows remain unverified and must pass before the gate can be removed.
