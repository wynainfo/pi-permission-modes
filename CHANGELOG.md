# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.1]

### Added
- Published to npm: `pi install npm:pi-permission-modes` is now the primary
  install method (README updated with pinning, project-local install, and
  update commands).
- pi.dev gallery demo video (`pi.video` in package.json), hosted as a GitHub
  release asset.

### Changed
- README: CI + MIT badges; deduplicated mode table and protection sections;
  stale claims fixed across README/SECURITY/CONTRIBUTING (see the docs-cleanup
  commits).

## [2.1.0]

Hardening release: the six findings from a full code review, each with tests.

### Added
- **End-to-end dispatcher tests** (`src/index.test.ts`): a fake `pi`/`ctx`
  harness drives the real registered handlers — prompt flows and blocks per
  mode, bash session grants across chains, Plan-mode Markdown gating and
  prompt injection, "Allow forever" persistence + hot-reload, skill/input
  gating, startup mode resolution (`--perm` flag, session-entry restore),
  `alt+m` cycling, `/perm init`, and the project tighten-only overlay.
  Hermetic (temp project root + `PI_CODING_AGENT_DIR` temp agent dir,
  `--no-sandbox`); self-skips when the host-bundled pi SDK isn't installed.
  CI now runs `npm install` (tolerantly) so the harness executes there.

### Changed
- **CI typecheck is now blocking.** The pi SDK peer deps resolve from the
  public npm registry, so `tsc --noEmit` failures are real regressions, not
  missing-types noise; `continue-on-error` is gone.
- **The config loader warns on array-index-like pattern keys** (e.g.
  `"777": "deny"`): JS iterates such keys first regardless of file order,
  silently breaking a pattern-map's last-match-wins semantics. The pattern
  still loads; the warning tells the user their ordering may not be honored.

### Fixed
- **The headless-child safety fallback no longer injects the fallback mode's
  system prompt.** A headless child with no forwarded mode still starts in the
  most restrictive mode (Plan, with its full policy), but Plan's planning
  prompt — "write a plan file, ask the user to press alt+m" — is not injected
  into a headless worker it would misdirect. The implicit fallback is also not
  re-exported via `PI_PERMISSION_MODE` as if it were an explicit choice;
  grandchildren derive the same safe fallback themselves. An explicitly
  forwarded or flagged mode behaves as before, prompt included.
- **The protected-path backstop now resolves symlinks.** `edit`/`write` targets
  are matched lexically AND on their canonical (symlink-resolved) path, so an
  in-project link pointing at `.git/`, `.env`, a shell rc file, etc. no longer
  smuggles a write past the backstop — this matters most in Build, where file
  tools don't prompt and aren't OS-sandboxed. In-project targets are judged
  root-relative, so a project that itself lives under a directory named
  `node_modules` (debugging a dependency in place) isn't spuriously
  write-blocked.
- **Privilege escalation is now detected through wrappers and shell `-c`
  scripts in the tree-sitter path.** `env PATH=/x sudo …`, `nice -n 10 sudo …`,
  `timeout 5 doas …`, `xargs sudo …` unwrap to their effective command head,
  and `sh|bash|… -c '<script>'` scripts are re-parsed recursively
  (depth-limited) so their inner commands are visible to privilege/escape
  detection *and* policy/path matching — closing the `bash -c 'sudo …'` gap the
  AST path had while the regex fallback (whole-string scan) caught it. As a
  bonus, the AST path no longer false-positives on mere mentions
  (`grep sudo README.md` is not "privilege escalation").
- **Bash session approvals now cover the whole chain, not just its first
  command.** A grant is keyed on every command name tree-sitter extracts, and a
  chain passes silently only when ALL of its names are already granted —
  "Allow `git` for session" no longer silently approves
  `git status && curl … | sh`. Approving a chain remembers each of its names;
  when no parse is available (heuristic fallback), the key is the exact command
  string.
- **The cross-cutting `path` gate now binds bash in the tree-sitter path.** Each
  extracted command is judged against the `path` patterns — the joined
  `name args…` string *and* every individual token — via `decideBashCommand`, so
  a rule like `"path": { "*.env": "deny" }` blocks `cat .env extra-arg` no matter
  where the target sits in the command. Previously the AST path only consulted
  the `bash` surface (the `path` gate applied to bash only in the regex
  fallback, and only against the whole command line), contradicting the
  documented "gate over ALL file access (incl. bash args)" semantics. Project
  tighten-only overlays fold in the same way.

## [2.0.0]

Declarative mode engine. Modes are now **data** — each a JSON bundle of a sandbox
profile and an allow/ask/deny policy — so they can be retuned and user-defined.

### Added
- **Declarative modes** in `permission-mode.json`: define your own modes (label,
  color, sandbox profile, per-surface policy, hidden tools) or retune the
  built-ins. JSON Schema at `schemas/permission-mode.schema.json`.
- **Stock defaults ship as data** — `permission-mode.defaults.json` (same format
  you edit), loaded over a minimal in-code safety fallback. `/perm init` copies it
  to the global config path, ready to customize.
- **allow / ask / deny policy engine** across surfaces: cross-cutting `path` gate,
  `external_directory`, per-file-tool, `bash`, `web_search`, `tool` (any
  extension tool), and `skill`. Last-match-wins within a surface; most-restrictive
  across layers.
- **Real bash parsing** via tree-sitter (`web-tree-sitter` + `tree-sitter-bash`):
  per-command matching incl. commands nested in `$(...)`, backticks, and
  subshells; structural escape/privilege detection. Falls back to the regex
  heuristic when the WASM grammar can't load.
- **Tool hiding** per mode (`hideTools`) — removes tools from the model before it
  reasons (`show_plan` is never hidden).
- **Skill gating** (the `skill` surface, via `/skill:<name>`) and **custom/extension
  tool gating** (the `tool` surface). In Default and Plan, an unknown tool/skill
  **prompts on first use** (Allow once / this session / forever / Deny); "Allow
  forever" persists the rule to the global config. Build/YOLO allow all
  tools/skills. Keeps unfamiliar tools on other hosts gated, not silently allowed.
- **Session approvals**: `ask` prompts offer Allow once / Allow for session / Deny;
  per-mode memory cleared on shutdown or via `/perm clear-approvals`.
- **Subagent forwarding**: the active mode is exported as `PI_PERMISSION_MODE` and
  adopted by child `pi` processes; headless children with no forwarded mode start
  in the most restrictive mode (never YOLO).
- Per-mode sandbox profiles: switching modes re-initializes the sandbox when the
  filesystem/network profile differs.

### Changed
- **BREAKING — config format & path.** `sandbox.json` is replaced by
  `permission-mode.json`: global at `~/.pi/agent/permission-mode/permission-mode.json`,
  project (tighten-only) at `<project>/.pi/permission-mode.json`. The old
  `sandbox.json` is no longer read.
- Project tighten-only now applies to the full policy (as a most-restrictive
  overlay that provably can't loosen), not just the sandbox lists.
- `--perm` accepts any defined mode name.

### Fixed
- **Sandbox placeholder litter.** In Default/Build, the OS sandbox left 0-byte
  read-only files in the project for every path in its mandatory write-deny set
  (`.bashrc`, `.gitconfig`, `.gitmodules`, `.vscode`, `.idea`, `.claude`,
  `.mcp.json`, `.ripgreprc`, …) when those paths were absent — not just `.git`.
  Placeholder cleanup is now generalized to the full set (removing only 0-byte
  *files*, never real dirs/files) before and after every sandboxed run.

### Preserved
- The four built-in modes reproduce 1.0.0 behavior (parity-tested), including the
  Plan-mode read-only sandbox + Markdown-only writes + `show_plan` flow, the
  protected-path backstop, the sandbox-unavailable degradation, and the non-git
  `.git`-placeholder cleanup.

## [1.0.0]

First public release.

### Modes
- Four switchable permission modes — **Default**, **Plan Mode**, **Build**,
  **YOLO** — cycled with `alt+m` or set via `/perm <mode>`; persisted per session.
- Plain-text footer indicator with per-mode colors and a muted
  `(sandboxed in project dir)` marker.

### Sandboxing
- OS-level sandbox for in-project `bash` in Default/Plan/Build via
  `@anthropic-ai/sandbox-runtime` (bubblewrap on Linux, `sandbox-exec` on macOS).
- **Plan Mode** runs bash read-only (per-command `allowWrite: []` override) and
  permits only in-project Markdown writes; injects a system prompt steering the
  model to write a plan to `plan/<date>_<desc>.md` and render it with `show_plan`.
- `show_plan` tool renders a written plan as formatted Markdown in the terminal,
  display-only (kept out of the model context).
- Graceful degradation to prompting when the sandbox is unavailable.

### Safety
- Tighten-only project config: `<project>/.pi/sandbox.json` can only make the
  sandbox stricter; overly-broad domain patterns are rejected.
- Symlink-aware out-of-project containment; protected-path writes blocked
  (`.git/`, `.env*`, dotfiles, etc.).
- Non-git projects stay fully sandboxed: the 0-byte `.git` placeholder bubblewrap
  plants is cleaned up around every run. Real git worktrees/submodules (a
  non-empty `.git` file) degrade to prompting instead of breaking.

[2.0.0]: https://github.com/wynainfo/pi-permission-modes/releases/tag/v2.0.0
[1.0.0]: https://github.com/wynainfo/pi-permission-modes/releases/tag/v1.0.0
