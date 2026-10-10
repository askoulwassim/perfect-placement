# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- MIT license, contributing guide with DCO sign-off, code of conduct, security policy, issue forms, pull request template and Dependabot.
- `docs/`: architecture, decisions and UI design references.

### Changed
- Kev is the only System One decision backend; the hosted backend that was off by default is removed. A `config.json` that still carries that backend's settings block loads unchanged (the block is dropped on the next save). If you had pointed `backends.default` or `backends.fallback` at it, set them back to `kev` / `agent`.
- Demo fixtures use `.example` company domains.
- CI runs with read-only repository permissions.

### Removed
- The internal build brief (`docs/v2/`); it remains in git history.

## 0.1.0

First working version: engine, decision layer, MCP server, CLI and web UI on a local vault.
