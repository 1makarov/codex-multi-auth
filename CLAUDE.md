<!-- ftask:managed v1 — auto-generated; edit OUTSIDE this block -->
# Agent rules — codex-multi-auth (managed by ftask)

- This repo is part of sunke's agent-OS. Agents NEVER run git directly here — use `bun ~/.claude/PAI/TOOLS/ftask.ts`.
- Base branch: `main`. Feature work happens on a `ftask new <slug>` feat branch (single-dir mode), never on `main` directly.
- Ship semantics: sunke's explicit `ftask ship` authorization is the production decision; green gates complete merge, push, cleanup, and finalization in that command. `postship` is optional health monitoring or legacy recovery, not another approval.
- Test gate: `ftask ship` runs valid SPEC-targeted paths locally with `bun run test` (auto-detected); required CI owns every full suite. Missing/stale/drifted CI or invalid targets BLOCK merge — never fall back to a local full suite.
- Code questions (where is X / who calls X / what breaks if I change X): this repo has a `.codegraph/` index — use the `codegraph_*` MCP tools (explore/callers/callees/impact) FIRST instead of grep/Read sweeps; cross-repo queries take a `projectPath` arg. Human-readable architecture map: vault `AgentOS/<repo>/GRAPH.md`.
- When you fix a bug found while troubleshooting (a 排障), add a regression test that FAILS without the fix BEFORE `ftask ship`, and record the root cause as one line under "Known gotchas" below.
- Global protocol: `~/.claude/CLAUDE.md` (Claude), `~/.codex/AGENTS.md` (Codex), and `~/.grok/AGENTS.md` (Grok) — "AGENT-OS" section. User cheatsheet: `~/code/AGENT-OS.md`.

## Known gotchas
- (root causes from 排障 sessions accrue here so the same bug is never debugged twice)
<!-- /ftask:managed -->
