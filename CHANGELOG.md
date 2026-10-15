# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-10-15

Codex and Cursor become full runners: their own tools for web, Gmail and the browser, with Open and fill, and a browser policy PP enforces itself.

Thanks to **Chris Dupuy ([@waywardcoder](https://github.com/waywardcoder))** for the Codex work this release builds on: fixing web tools and MCP approvals in Codex background runs (#155), and the Codex connectors with the restricted local browser runtime, tested against a live Chrome session (#157). His review back-and-forth shaped #158 to #161.

### Added
- Codex connectors (#157, @waywardcoder): Codex runs use Codex's own web search and fetch, the Gmail tools connected to Codex, and PP's Chrome DevTools browser adapter (`pp_browser`) for fill, connect and voice, including the fill assist (Open and fill). `pp setup --runner codex` installs the pinned browser runtime; missing setup ends a run with `setup required: <capability>`.
- Cursor runs fill, connect and voice through `pp_browser`, including the fill assist, with the same browser policy as Codex (#161). `pp setup --runner cursor-agent` installs the browser runtime.
- CI runs a real-browser regression: the pinned runtime, installed by `pp setup`, in headless Chrome through the adapter (#161).

### Changed
- One module per runner under `packages/engine/runners` (#168): command lines, Ask parsing, setup steps and doctor checks per runner instead of branches on the runner's name. `pp setup` and `pp doctor` no longer show browser lines for Claude.
- Skills are runner-neutral (#169): SKILL.md files name tools as `{{placeholders}}` that each runner fills in, so Codex and Cursor read their own tool names instead of rewritten Claude text. Claude's prompts are unchanged.
- The browser runtime is no longer named for Codex: `runtimes/browser`, cached in `~/.cache/perfect-placement/browser`, checked by `pp doctor` as `browser_runtime`. **Existing Codex installations need `pp setup` once**; the old `perfect-placement/codex-browser` cache can be deleted by hand (#161).
- Dependencies: OpenUI `lang-core` and `react-lang` 1.0, upgraded together (#176); markdown-it 15 (#163); zod, vitest, docx and the Anthropic SDK patch and minor updates (#162, #174). `@types/node` stays on the oldest supported Node (22) (#165).

### Fixed
- Codex background runs: web skills use Codex's web tool, and pp tool calls that need approval no longer fail after successful reads (#155, @waywardcoder).

### Security
- Codex and Cursor browser runs follow one policy per run, enforced by PP's adapter: they act only on tabs they opened (your own tabs are hidden from them), open only the role's own sites, applicant-tracking and sign-in sites (LinkedIn only for connect and voice), and cannot read or fill a page a redirect took elsewhere (#161).
- The browser adapter uploads only the role's rendered resume and cover letter, only to real file inputs, and refuses a short answer containing a line break or tab, which would be typed as Enter or Tab and could submit a form (#157).
- Closed the nine CodeQL alerts (#152): ATS hosts match by domain, so `evilgreenhouse.io` is not Greenhouse; `parseMoney`, the submit-label guard and base-url slash trimming run in linear time (`parseMoney` was cubic on long runs of spaces); the resolver eval's agreement matrix cannot be steered onto `Object.prototype` by a backend name; an op that throws a non-Error returns `unexpected error` instead of echoing the thrown value.

## [0.1.0] - 2026-10-10

First public release: engine, decision layer, MCP server, CLI and web UI on a local vault, now open source under MIT.

### Added
- MIT license, contributing guide with DCO sign-off, code of conduct, security policy, issue forms, pull request template and Dependabot.
- `docs/`: architecture, decisions and UI design references.
- The Perfect Placement logo (ring with overlapping P's) in the app rail, onboarding and the browser tab; logo files, a social preview image and README diagrams in `docs/assets/`.
- A new README with a demo GIF, screenshots, diagrams and a map of every doc; install and uninstall detail moved to `docs/install.md` and `docs/uninstall.md`.
- GitHub Sponsors funding link.

### Changed
- Kev is the only System One decision backend; the hosted backend that was off by default is removed.
- Demo fixtures use `.example` company domains.
- CI runs with read-only repository permissions, and its actions are pinned to commit SHAs.
- A new vault is owner-only: its folders are created 0700 and `config.json` and `pp.db` 0600. Existing vaults keep their permissions.

### Removed
- The internal build brief (`docs/v2/`); it remains in git history.

[Unreleased]: https://github.com/askoulwassim/perfect-placement/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/askoulwassim/perfect-placement/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/askoulwassim/perfect-placement/releases/tag/v0.1.0
