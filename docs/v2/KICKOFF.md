# Kickoff prompts for Claude Code

Open Claude Code at the v1 repo (`~/Documents/Claude/Projects/PerfectPlacement`). Run `/design-login` once so the Claude Design import works. Then paste Prompt 1.

Note: the v1 repo still has its v1 `CLAUDE.md`. It describes the old system. For this build, `docs/v2/` supersedes it.

---

## Prompt 1: Wave 0 (contracts)

```
We are building Perfect Placement v2. The complete brief is in docs/v2/. The v1 CLAUDE.md in this repo describes the old system; for this work docs/v2/ supersedes it.

Read, in order: docs/v2/README.md, decisions.md, blueprint.md, contracts.md, design.md, v1-inventory.md, then skim lanes/.

You are the Wave 0 agent. Do exactly what docs/v2/contracts.md says, starting with Step 0: ask me whether to build in a new repo (recommended) or this one, and where. Then:
1. Scaffold the system repo per the layout and tooling defaults.
2. Import the Claude Design prototype (design.md) and extract the final tokens and component inventory into packages/contracts. If the import fails, use the baseline tokens and tell me.
3. Write packages/contracts (statuses, events, ops with impact tiers, resolver + policy types), migration 001, synthetic fixtures, AGENTS.md (no CLAUDE.md anywhere), .gitignore, CONTRACT_CHANGES.md, and empty lane skeletons.
4. Make pnpm build and test pass on a clean clone, commit, and create branches v2/lane-a ... v2/lane-j.

Rules: locked decisions in decisions.md are not up for debate; no personal data from 01_Profile, 02_Pipeline, 03_Applications, 04_Interviews, or the resume ever goes into the system repo; no feature work beyond contracts and stubs. When done, report what you built, any contract choices you made that lanes must know, and anything you need from me. Stop there.
```

---

## Prompt 2: Wave 1 (parallel lanes)

Run after Wave 0 is merged and reviewed. Two options.

**Option A, one orchestrating session** (paste into Claude Code at the system repo):

```
Wave 0 is merged. Launch Wave 1: one subagent per lane brief in docs/v2/lanes/ (A through J), each in its own git worktree on its lane branch (v2/lane-<x>), all in parallel. Give each subagent its lane brief plus README.md, decisions.md, contracts.md and AGENTS.md as context. Each lane writes only inside the folders its brief says it owns and requests contract changes through CONTRACT_CHANGES.md. Each lane ends with a passing build/test on its branch and a short report: what shipped, deviations, open questions, what Wave 2 needs to know. Do not merge anything. When all lanes report, give me one summary table and the merge order proposed in lanes/W2-integrate.md. Lanes D (design import) and H (LinkedIn on one real role) need me at points; queue those questions and ask me in one batch.
```

**Option B, one terminal per lane** (more control, more windows):

```
git worktree add ../pp-lane-a v2/lane-a   # repeat per lane
cd ../pp-lane-a && claude
```

Then in each session:

```
You are lane A of Perfect Placement v2. Read AGENTS.md, docs/v2/README.md, docs/v2/decisions.md, docs/v2/contracts.md, and your brief docs/v2/lanes/A-data-migration.md. Do only what the brief says, only inside the folders it owns. End with passing build/test on this branch and a short report. Do not merge.
```

---

## Prompt 3: Wave 2 (integrate)

```
All Wave 1 lane branches have reported. You are the Wave 2 agent. Follow docs/v2/lanes/W2-integrate.md exactly. Merge in the order given, resolve CONTRACT_CHANGES.md, switch the UI to live ops, and stop before any step that touches my real data (migrate, rescore, freshness backfill, scheduled tasks, the real-role run) so I can be present for it.
```
