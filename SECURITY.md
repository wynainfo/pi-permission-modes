# Security model

`permission-mode` gates the agent's filesystem/bash access and adds an OS-level
sandbox. This document states what it does and does **not** protect against, so
you can rely on it appropriately.

## Two layers

1. **Policy engine** (`allow` / `ask` / `deny`) - per-mode, per-surface decisions
   that drive the prompt/block UX. For bash, commands are parsed with
   **tree-sitter** (a real AST), so privilege escalation and out-of-project paths
   are detected even nested in `$(...)`, backticks, and subshells; `sh|bash|… -c
   '…'` scripts are re-parsed recursively (depth-limited), and privilege
   escalation is detected through known wrapper commands (`env`, `nice`,
   `nohup`, `timeout`, `xargs`, …). Still foolable by variable-built commands
   (`$CMD rm …`), scripts read from files, and shell globs or brace
   expansion (`cat .en?`, `cat .env{,}` are matched as written, not as what
   the shell expands them to). If the tree-sitter grammar can't
   load, it falls back to the original token-scan heuristic
   (`bashConfirmReason`) - **not** a shell parser, foolable by variable-built
   paths etc. Either way this is the *prompting* layer, **not** the containment
   boundary.
2. **OS sandbox** (`@anthropic-ai/sandbox-runtime`) - the real enforcement for
   in-project `bash` in the sandboxed modes: `bubblewrap` (Linux) / `sandbox-exec`
   (macOS) confine **writes** to the profile's `allowWrite` (project + `/tmp/pi`
   + the session's scratch directory by default) and deny reads of the profile's
   `denyRead` secrets, regardless of what the command does. A `bash` action of
   `allow` still runs **sandboxed**; the sandbox is what actually contains it.

## Known limitations (read these)

- **Reads are deny-listed, not allow-listed.** The sandbox blocks out-of-project
  *writes* at the kernel, but reads stay broad (so build tools work) except for
  the configured `denyRead` secrets. An out-of-project **read** in bash is gated
  only by the AST/heuristic prompt layer - if detection misses it (e.g. a
  variable-built path), the sandbox allows the read. Treat the project boundary
  for reads as best-effort, and the `denyRead` list (`~/.ssh`, `~/.aws`,
  `~/.gnupg`, `~/.netrc`, `~/.git-credentials`, `~/.pypirc`,
  `~/.gem/credentials`, `~/.vault-token`, `~/.password-store`, and pi's own
  `~/.pi/agent/auth.json` and `oauth.json` by default) as the hard guard. A
  denied prompt is a refusal, not containment: a determined agent can read
  the same file through a script it writes into the project. **Deny and
  block** (offered on every out-of-project path prompt) turns that Deny into
  containment for the session: every later sandboxed command carries the
  path as extra `denyRead`, and the file tools refuse it directly. A block
  is by path, like every `denyRead`: a second name for the same file that
  already exists elsewhere (a hardlink, an earlier copy) is not covered. A mode
  can invert the default with `allowRead`: deny `~` and re-open only the
  toolchain directories (README, "Strict home"); a more specific `denyRead`
  or a session block inside a carve-out still wins, and a project config can
  only remove carve-outs. One deliberate exemption in the
  bash prompt layer: an in-project symlink whose target is an *executable
  file* outside the project (a venv's `bin/python`) is not treated as an
  escape - executing it is the project's intent and the sandbox still confines
  the run. Symlinks to outside directories or non-executable files remain
  escapes, and the file tools always follow symlinks.
- **File tools aren't OS-sandboxed.** `read`/`edit`/`write`/… are governed by the
  policy engine and path checks (out-of-project prompt, protected-path backstop,
  per-surface allow/ask/deny), not bubblewrap.
- **Approved & non-sandboxing commands run unsandboxed.** Anything you confirm,
  any approved out-of-project command, and everything in a mode with
  `sandbox.enabled:false` (YOLO) runs with your full permissions. Treat them as
  fully trusted.
- **Gating ≠ containment.** The AST/heuristic decides whether to *prompt* and
  whether an approved command runs *unsandboxed*. A missed detection is a missed
  prompt; in-project commands still run sandboxed, so the exposure is a missed
  prompt, not a filesystem escape.
- **Project configs can only tighten.** A `<project>/.pi/permission-mode.json` is
  applied as a most-restrictive overlay (it can add `ask`/`deny`, never loosen)
  and its sandbox is intersected/unioned stricter. It cannot change
  `sandbox.enabled`, add modes, widen the network allowlist, or re-enable secret
  reads. Opening an untrusted repo can't weaken your protection.
- **Sandbox and policy are independent.** A mode with `sandbox.enabled:false`
  still honors its explicit bash policy. `bash:ask` prompts before an
  unsandboxed command and `bash:deny` blocks it. YOLO runs silently because its
  policy explicitly says `bash:allow`, not merely because containment is off.
- **Network is a domain allowlist**, not traffic inspection - allowing a broad
  domain permits exfiltration to it. Keep the allowlist tight. Hosts outside
  the allowlist trigger a **live permission prompt** (deny-by-default: headless
  sessions, dismissed prompts, and `askOnBlockedHost:false` all deny). Session
  grants, `/net allow`, `/net open`/`alt+n`, and the model's
  `request_network_access` tool widen the reachable set **only through an
  explicit user action in the UI** - the model cannot grant itself access, but
  everything you allow is exfiltration surface. The runtime refuses an allowed
  name that resolves to loopback, link-local, this host's own addresses, or
  a cloud metadata endpoint, so a permitted domain cannot be pointed at local
  services through DNS. `/net open` disables the
  allowlist entirely for the session (shown orange in the footer). Interactive
  grants are user authority: they can reach past a project config's tightened
  allowlist, exactly like approving an out-of-project command. "Allow forever"
  persists to the global config against the stock+global base - a project's
  tighten-only intersection is never baked in.
- **Subagent forwarding is best-effort.** The active mode is exported as
  `PI_PERMISSION_MODE` and inherited by child `pi` processes (e.g. subagents),
  which adopt it on start. A spawner that overrides the child's environment breaks
  this; as a backstop, a **headless child with no forwarded mode starts in the
  most restrictive mode, never YOLO** - with that mode's full policy but
  *without* its system-prompt injection (a planning prompt would misdirect a
  headless worker), and without re-exporting the fallback to its own children
  (they derive the same fallback themselves). Don't rely on forwarding as a
  security boundary - the child enforces its own modes regardless.
- **Sandbox-writable directories are in-bounds, and shared.** A path under the
  active profile's `allowWrite` (`/tmp/pi` by default), the session's scratch
  directory, or the runtime's own `/tmp/claude` is *not* treated as an escape:
  no prompt, and the command stays sandboxed. Everything the agent writes
  there is plain user-owned data on a world-readable `/tmp` - the `/tmp/pi`
  base is sticky/world-writable like `/tmp` itself and each session folder is
  `0700`, but files an agent puts directly under the shared base are visible
  to every pi session (and every process of your user) on the host. Don't
  route secrets through temp files. A global/project config that drops
  `/tmp/pi` from `allowWrite` narrows the shared part; the session folder
  itself is **always** writable and in-bounds (the extension appends it to
  the profile - a project config cannot remove it).
- **The runtime has write paths of its own.** `@anthropic-ai/sandbox-runtime`
  unconditionally allows writes to `/tmp/claude` (and points `TMPDIR` there
  unless `CLAUDE_TMPDIR` is set - this extension sets it to the scratch
  directory), `~/.npm/_logs`, `~/.claude/debug`, and - on macOS - the user's
  `$TMPDIR` under `/var/folders/…`. These are not in your config and cannot be
  removed from it; only `/tmp/claude` is treated as in-bounds by the prompt
  layer, the others still prompt.
- **Temp-dir narrowing is enforced on Linux, partial on macOS, policy-only on
  Windows.** On Linux only `allowWrite` (plus the runtime's built-ins) is
  writable - a tool that hardcodes `/tmp` and ignores `TMPDIR` fails silently
  (the kernel denies it; the awareness prompt tells the model to ask you). On
  macOS the per-user `/var/folders/…` temp dir stays writable regardless. On
  Windows there is no OS sandbox at all: `allowWrite` only feeds the prompt
  bounds, and the scratch directory lives under `os.tmpdir()`.
- **Scratch sweep is hygiene, not a guarantee.** At session start, sibling
  folders under the scratch base untouched for 7 days are deleted (directories
  only - files and symlinks are skipped, never followed; another user's
  folder can't be deleted and is skipped). It keys on directory mtime. Treat
  the scratch base as ephemeral and don't rely on the sweep to remove
  anything sensitive.
- **Platform**: Linux (needs `bubblewrap`, `socat`, `ripgrep`) and macOS only.
  **Native Windows has no sandbox**: the sandboxed modes degrade to prompting
  only, the network allowlist is not enforced, and `allowWrite` only feeds the
  prompt bounds. Run pi under WSL2 for OS-level enforcement.
- **Pinned directories on Linux.** Every existing ancestor of a path the
  sandbox protects (a denied read, a mandatory-deny dotfile, the runtime's
  own binds) is a mount point inside the sandbox. Renaming or removing such a
  directory from inside a sandboxed command fails with `EBUSY`, and `rm -rf`
  of a nested repository leaves its `.git/hooks` and the pinned directories
  behind. This is how bubblewrap works, not a containment gap; run the
  removal outside the sandbox (it prompts) if you really mean it.
- **Masked dotfiles are devices inside the sandbox.** The runtime hides the
  absent protected dotfiles at the project root (`.bashrc`, `.gitconfig`,
  ...) by binding `/dev/null` over them, so inside a sandboxed command they
  exist as character devices: `git add -A` at the root refuses them (add by
  name instead, or list them in the repository's `.git/info/exclude`), and a
  tool that stats them sees a device, not a missing file. Harmless for
  containment; noted so nobody files it as a leak.
- **Violation reports are best effort.** The `<sandbox_violations>` block is
  diagnostic output for the model, gathered by observers that run beside the
  sandbox (a seccomp write observer on Linux, the system sandbox log on
  macOS). A refusal that goes unreported is still a refusal; the sandbox
  never depends on the observers.

## Reporting a vulnerability

Please report security issues **by email to the maintainer** (address in
[`package.json`](package.json)) - GitHub issues are public, so don't open one
with exploit details. Include the mode, platform, and a minimal reproduction.
Non-sensitive hardening ideas are welcome as regular
[issues](https://github.com/wynainfo/pi-permission-modes/issues).

## Acknowledgements

- **Sandbox/policy downgrade via project config** (fixed in 2.1.2) - reported
  by Magnus Gille (https://gille.ai/).
- **Bash `ask`/`deny` policy bypass via a newline in a command argument**
  (fixed in 2.2.1) - reported by dyoon98-creator (https://github.com/dyoon98-creator);
  independently found and fixed in PR #5 by BeLeap (https://github.com/BeLeap)
  and in PR #6 by hsiangron (https://github.com/hsiangron).
