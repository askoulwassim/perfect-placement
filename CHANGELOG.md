# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

## 0.1.0

First working version: engine, decision layer, MCP server, CLI and web UI on a local vault.
