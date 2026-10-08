# Locked decisions (2026-10-08)

Locked by Wassim. Change only with his explicit OK; log any change at the bottom with date and reason.

| # | Topic | Decision | Notes |
| --- | --- | --- | --- |
| 1 | Runtime | **TypeScript monorepo**: engine, resolver, MCP, CLI, web in one language | OpenUI and the MCP SDK are TS-native. |
| 2 | Data home | **`~/.perfect-placement`** (hidden). `PP_HOME` env var overrides. | Must stay openable as an Obsidian vault. |
| 3 | Source of truth | **SQLite for structure, markdown for long-form, linked by id** | Markdown frontmatter carries the DB id. |
| 4 | Autonomy | **Confidence x impact policy** (below). Low impact + confident = auto. | Applies to every decision, not only profile learning. |
| 5 | Dream companies | **Capped nudge (+/-5 points), no dealbreaker bypass** | Plus blind role scoring and a per-company cap. |
| 6 | 2nd-degree discovery | **Browser automation on LinkedIn** in Wassim's own signed-in session | Read-only, slow, capped per day, only on roles he picked. LinkedIn terms restrict automation: keep volume low, never message from automation. |
| 7 | Decision models | **Jev default from day one** (Wassim has access) **+ Kev as local open-weights backend** | Same System One API; one adapter, base URL switch. |
| 8 | Agent instructions | **AGENTS.md only. No CLAUDE.md anywhere.** | See verification note below. |
| 9 | v1 scheduled tasks | **Paused** (done manually 2026-10-08) | New schedules start at the Wave 2 cutover. |
| 10 | OpenUI | **Spike in Wave 1, decide after** | Lane J. |
| 11 | UI design | **Claude Design prototype is the UI source of truth** | See `design.md`. Palette approved as is. |
| 12 | Repo | **Open: new system repo vs this repo.** Recommended: new repo for the system, this repo kept as the private v1 archive. | This repo's git history contains personal data. Ask Wassim in Wave 0 step 0. |

## Decision policy (confidence x impact)

Every decision a human would otherwise make goes through the resolver first. The human always sees the pick and its probability, never a blank question.

| Impact \ confidence | p >= 0.90 | 0.70 to 0.90 | p < 0.70 |
| --- | --- | --- | --- |
| **Low** (reversible, internal) | auto | auto after a second backend agrees | human |
| **Medium** (reversible, visible) | auto + 24h undo | human, with the pick shown | human |
| **High** (external or irreversible) | human, always | human, always | human, always |

- High impact = submit an application, send an email, delete anything, change a dealbreaker, change the comp floor.
- "Second backend agrees" = LLM or Kev confirms Jev's answer (same option, its p >= 0.70).
- "Auto + undo" = applied now, shown on the Now screen for 24h with one-tap undo.
- Thresholds live in config, per decision type. Human overrides are logged and used to retune them.

## Decision backends

- **Jev** (TypeSafe AI, hosted, launched 2026-09-15). Returns probabilities, not text. Question types: choice, yes/no ("Noulli"), score. Many questions on one state per call, ~70 to 500 ms, very cheap. Calibrated probabilities. Limits: no reasons, weak on numbers and dates (keep those rule-based), always picks an option (always include an "other"). Confirm the exact request/response shape from TypeSafe's docs.
- **Kev** (Jared Palmer, Apache-2.0, Qwen-based). Hugging Face: `jaredpalmer/kev-0.8b`, `kev-4b`, `kev-9b`, `kev-27b` (tag `v1.0`). Serves `POST /v1/systemone` (state + typed questions -> answers, probabilities, confidence). The TypeSafe SDK reportedly works against it unchanged. Local run: `uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b --port 8009` (MLX on Apple Silicon; ~0.7 s for 5 new questions on M5). Kev-27B is close to Jev on accuracy; Jev ranks better. Repo: https://github.com/jaredpalmer/kev
- Default routing: Jev for Wassim; Kev for open-source installs and whenever Jev is unreachable.
- Writing (resume, letters, answers, emails, profile diff text) always uses an LLM, never a System One model.

## AGENTS.md verification

Claude Code reads `AGENTS.md` only when **no** `CLAUDE.md` exists in the working directory or any parent directory (shipped in Claude Code 2.1.277, 2026-09-18; default `/config` "Project instructions" mode `claude-md-or-agents-md`). Gotchas:
- Any `CLAUDE.md` above the repo silently disables the fallback. `pp doctor` must check the parent chain.
- Nested `AGENTS.md` files only load if no `CLAUDE.md` exists above them.
- Not yet supported on Bedrock, Vertex, Foundry.
Sources: third-party write-ups citing the changelog (dev.to/valyuai, medium/@dan.avila7). Verify on first run by asking Claude Code what instructions it loaded.

## Change log

- 2026-10-08: initial lock.
