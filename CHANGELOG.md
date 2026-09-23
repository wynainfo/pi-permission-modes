# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.1]

### Security
- **A newline inside a bash argument bypassed `ask`/`deny` bash policy.** The
  glob matcher compiled `*` to a regex `.*` without the dotAll flag, and `.`
  excludes `\n` in JavaScript — so any command whose joined `name args…`
  string spanned lines matched no `bash` pattern at all, not even `"*"`. In
  the sandboxed modes the per-token `path` layer still matched and contributed
  `allow`, so most-restrictive resolved to `allow`: `sudo sh -c "\nid\n"`
  skipped a `"sudo *": "deny"` rule, and in the shipped Default mode a
  multi-line argument turned `bash: {"*": "ask"}` into a silent run with no
  prompt. The OS sandbox still contained in-project writes, so this is a
  prompting/policy failure rather than a containment escape (see
  SECURITY.md, "Gating ≠ containment") — but `deny` is documented as a hard
  boundary and could be skipped with a single newline. Affected 2.0.0–2.2.0.
  The same miss made unsandboxed modes fall through to the `ask` fallback,
  so YOLO prompted on every heredoc or multi-line script. Fix: the matcher
  now uses the dotAll flag, so `*` and `?` span newlines and `"*"` is a true
  universal fallback for multi-line targets. Regression tests added at the
  matcher, resolver, and dispatcher levels.

  Reported by [dyoon98-creator](https://github.com/dyoon98-creator). Independently
  found and fixed with the same one-line change in
  [#5](https://github.com/wynainfo/pi-permission-modes/pull/5) by
  [@BeLeap](https://github.com/BeLeap), two weeks earlier, as a wildcard bug —
  the security angle was not visible from that report.

### Fixed
- **A bash command matched by no rule now falls back to `ask`, not `allow`.**
  In the sandboxed modes each command extracted from a chain is judged
  separately, and one that matched neither a `bash` pattern nor the `path`
  gate was treated as `allow` — while the file-tool resolver and the
  unsandboxed/heuristic bash path already fell back to `ask`. A sparse custom
  mode such as `"bash": { "git *": "allow" }` with no `"*"` rule therefore ran
  the commands it never mentioned silently. Both paths now share the same
  least-privilege default. The shipped modes all specify `"*"` and are
  unaffected; `decideBashChain` in `resolve.ts` holds the chain logic and its
  fallback, unit-tested.
- **Temp-dir paths no longer prompt as "outside project" (and no longer run
  unsandboxed on approval).** The bash escape detector and the file-tool
  project boundary knew nothing about the sandbox profile, so a path under
  the mode's own `allowWrite` — `/tmp` in every shipped sandboxed mode, plus
  the runtime's `/tmp/claude` where it points `TMPDIR` — prompted as an
  escape on every `mktemp`, download, or scratch file, even though the
  sandbox permitted the write anyway. Worse, approving that prompt ran the
  whole command unsandboxed, turning a harmless temp write into a real
  containment escape. The sandbox-writable roots are now in-bounds for both
  bash and the file tools: they neither prompt nor lift the sandbox. Other
  absolute paths, relative escapes, and privilege escalation prompt exactly
  as before; unsandboxed modes (YOLO) are governed solely by their
  `external_directory` policy, as before.
- **`show_plan` and `request_network_access` now carry a `promptSnippet`**, so
  they are listed in the system prompt's "Available tools" section like the
  built-ins instead of reaching the model only through the JSON schema, which
  weakened tool awareness in some models. Reported by [@sunzx](https://github.com/sunzx)
  in [#3](https://github.com/wynainfo/pi-permission-modes/issues/3).
- **macOS git worktrees/submodules are sandboxed again.** The gitfile guard
  that degrades the OS sandbox (bubblewrap can't bind `.git/hooks` under a
  `.git` file) ran on every platform, but only the Linux runtime mounts that
  path — `sandbox-exec` denies the `.git/hooks`/`.git/config` paths in its
  profile instead. The guard is now Linux-only. Reported by
  [@pafuent](https://github.com/pafuent) in [#4](https://github.com/wynainfo/pi-permission-modes/issues/4).
- **The extension no longer enables every built-in tool.** Tool hiding
  rebuilt the active set from *all* registered tools minus `hideTools`, which
  silently re-enabled `grep`, `find`, `ls`, and `powershell` for everyone and
  overrode `defaultTools` in `settings.json`. It now starts from pi's current
  active set, remembers only what it hid, and restores only that on a mode
  switch — your own tool selection stays in force. Reported by
  [@sunzx](https://github.com/sunzx) in [#2](https://github.com/wynainfo/pi-permission-modes/issues/2).

## [2.2.0]

### Added
- **Blocked network hosts now ask instead of silently failing.** The sandbox
  proxy consults a live callback for any host outside the domain allowlist —
  the connection waits while you choose *Allow for session / Allow forever /
  Deny*. Denies are remembered for the session (no prompt-storms from
  retrying installers); dismissed prompts deny without being remembered;
  headless sessions deny as before. Every blocked host is appended to the
  command output, so the model sees exactly which connection the sandbox
  refused instead of blaming phantom proxies. Opt back into silent denying
  with `sandbox.askOnBlockedHost: false` (projects may force it off, never
  on).
- **`request_network_access` tool** (all modes): the model asks for one or
  more domains with a reason; a single prompt covers the whole batch. Grants
  apply instantly — the callback reads live session state, no sandbox
  re-init. "Allow forever" persists to the active mode's allowlist in the
  global config, computed against the stock+global base so a project's
  tightened list is never baked in.
- **`/net` command and `alt+n`**: `/net status | allow <domain…> | open |
  restrict | reset`; `alt+n` toggles filtering for the session. The footer
  now always shows the state and the shortcuts:
  `Build (sandboxed in project dir, alt+m)  Network: filtered (alt+n)` —
  green when filtered, orange when open.
- **Sandbox awareness in the system prompt.** Sandboxed modes now inject a
  factual `## Sandbox & permissions` section each turn, generated from the
  active mode's **merged** profile: writable paths, denied reads, the network
  allowlist, and how the prompt flow works (boundary-crossing commands are
  fine to issue — the user is asked automatically). Previously the model
  discovered the sandbox by crashing into it (writes to `$HOME`, installs
  into `~/.npm`, fetches from non-allowlisted domains) and wasted turns
  retrying variants. When the sandbox is degraded the section says so and
  points at the confirmation prompts instead. Headless-fallback children get
  the factual section too (their steering `systemPrompt` stays skipped). Opt
  out per mode with `"injectSandboxInfo": false`; unsandboxed modes (YOLO)
  never inject.

## [2.1.2]

### Security
- **Project config could disable the sandbox and suppress bash prompts.** A
  repository-controlled `.pi/permission-mode.json` could set
  `sandbox.enabled:false` on an inherited-sandboxed mode (Default/Build);
  combined with the non-sandbox bash fast path treating a disabled sandbox as
  YOLO-class, this ran the next bash command unsandboxed with no confirmation —
  defeating the "opening an untrusted repo can't weaken your protection"
  guarantee. Affected 2.0.0–2.1.1. Two fixes: project-local tighten-only config
  can no longer change `sandbox.enabled` (it cannot disable containment
  inherited from stock/global policy), and unsandboxed modes now honor explicit
  `bash:ask`/`bash:deny` policy (YOLO stays non-interactive only because its
  bash policy explicitly resolves to `allow`). Loader and end-to-end dispatcher
  regressions added for both paths.

  Reported by Magnus Gille (https://gille.ai/).

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
