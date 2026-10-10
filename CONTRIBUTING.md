# Contributing to Perfect Placement

Thanks for helping. Bug reports, fixes, docs and new skills are all welcome. This page covers how to set up, the rules every change follows, and how contributions are licensed.

## Ground rules

- **No personal data, ever.** Nothing from a real profile, pipeline, application, resume, inbox or vault goes into the repo, an issue or a pull request. Fixtures are synthetic. `scripts/check-repo.mjs` (part of `pnpm test`) blocks the obvious cases; the rest is on you.
- **pp never acts externally on its own.** It never submits an application or sends an email or message. Changes that weaken that are not accepted.
- **Every write is an op.** Read [`AGENTS.md`](AGENTS.md) before changing code; it is the operating manual for people and coding agents alike.

## Set up

Prerequisites: macOS or Linux, Node 22+, git (on macOS also the Xcode Command Line Tools for `better-sqlite3`).

```sh
corepack enable
pnpm i
pnpm build
pnpm test        # every package, plus the repo guard
pnpm lint        # Biome
pp up --fixtures # the app on synthetic data (after ./install.sh)
```

Tests never touch a real `PP_HOME`: develop against `@perfect-placement/fixtures`, or `@perfect-placement/engine/testing` for a real engine on a temp fixtures vault. After editing `packages/fixtures/src/data.ts`, run `pnpm --filter @perfect-placement/fixtures gen`.

## Making a change

1. Open an issue first for anything bigger than a small fix, so we can agree on the shape.
2. One branch per piece of work; keep pull requests focused.
3. `pnpm build && pnpm test && pnpm lint` pass locally (CI runs the same, plus a fresh-install smoke test).
4. Update the docs the change touches: a package README, a `skills/*/SKILL.md`, `docs/`.
5. Open the pull request with the template filled in.

**Contracts and schema.** `packages/contracts` (schemas, ops, events, policy) and the database migrations change in their own pull request that updates schemas, tests and docs together. A schema change is a new numbered migration; never edit an applied one.

**UI.** The design rules are in [`docs/design.md`](docs/design.md): one primary action per screen, labels of one to three words, every button calls one op.

## Sign your commits (DCO)

Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/) (DCO). By adding a `Signed-off-by` line to each commit you certify that you wrote the change or otherwise have the right to submit it under this project's license:

```sh
git commit -s -m "Fix the freshness ladder for Lever postings"
# adds: Signed-off-by: Your Name <you@example.com>
```

Forgot? `git commit --amend -s` for the last commit, or `git rebase --signoff main` for a branch.

## License

Perfect Placement is [MIT-licensed](LICENSE). By contributing, you agree that your contributions are licensed under the same MIT license.

## Reporting bugs and security issues

- **Bugs:** open an issue with the bug form. Include `pp doctor` output, your OS, Node version and agent (Claude Code, Codex, Cursor, Claude Desktop). Leave out any personal data.
- **Security issues:** don't open a public issue; follow [`SECURITY.md`](SECURITY.md).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind; assume good intent.
