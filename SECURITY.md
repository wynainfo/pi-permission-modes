# Security model

`permission-mode` gates the agent's filesystem/bash access and adds an OS-level
sandbox. This document states what it does and does **not** protect against, so
you can rely on it appropriately.

## Two layers

1. **Policy engine** (`allow` / `ask` / `deny`) — per-mode, per-surface decisions
   that drive the prompt/block UX. For bash, commands are parsed with
   **tree-sitter** (a real AST), so privilege escalation and out-of-project paths
   are detected even nested in `$(...)`, backticks, and subshells; `sh|bash|… -c
   '…'` scripts are re-parsed recursively (depth-limited), and privilege
   escalation is detected through known wrapper commands (`env`, `nice`,
   `nohup`, `timeout`, `xargs`, …). Still foolable by variable-built commands
   (`$CMD rm …`) and scripts read from files. If the tree-sitter grammar can't
   load, it falls back to the original token-scan heuristic
   (`bashConfirmReason`) — **not** a shell parser, foolable by variable-built
   paths etc. Either way this is the *prompting* layer, **not** the containment
   boundary.
2. **OS sandbox** (`@anthropic-ai/sandbox-runtime`) — the real enforcement for
   in-project `bash` in the sandboxed modes: `bubblewrap` (Linux) / `sandbox-exec`
   (macOS) confine **writes** to the profile's `allowWrite` (project + `/tmp` by
   default) and deny reads of the profile's `denyRead` secrets, regardless of what
   the command does. A `bash` action of `allow` still runs **sandboxed**; the
   sandbox is what actually contains it.

## Known limitations (read these)

- **Reads are deny-listed, not allow-listed.** The sandbox blocks out-of-project
  *writes* at the kernel, but reads stay broad (so build tools work) except for
  the configured `denyRead` secrets. An out-of-project **read** in bash is gated
  only by the AST/heuristic prompt layer — if detection misses it (e.g. a
  variable-built path), the sandbox allows the read. Treat the project boundary
  for reads as best-effort, and the `denyRead` list (`~/.ssh`, `~/.aws`,
  `~/.gnupg` by default) as the hard guard.
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
- **Network is a domain allowlist**, not traffic inspection — allowing a broad
  domain permits exfiltration to it. Keep the allowlist tight.
- **Subagent forwarding is best-effort.** The active mode is exported as
  `PI_PERMISSION_MODE` and inherited by child `pi` processes (e.g. subagents),
  which adopt it on start. A spawner that overrides the child's environment breaks
  this; as a backstop, a **headless child with no forwarded mode starts in the
  most restrictive mode, never YOLO** — with that mode's full policy but
  *without* its system-prompt injection (a planning prompt would misdirect a
  headless worker), and without re-exporting the fallback to its own children
  (they derive the same fallback themselves). Don't rely on forwarding as a
  security boundary — the child enforces its own modes regardless.
- **Platform**: Linux (needs `bubblewrap`, `socat`, `ripgrep`) and macOS only.
  Windows is unsupported; the sandboxed modes degrade to prompting there.
- **Git worktrees/submodules** can't be OS-sandboxed (bubblewrap can't bind
  `.git/hooks` under a `.git` file); those projects degrade to prompting.

## Reporting a vulnerability

Please report security issues **by email to the maintainer** (address in
[`package.json`](package.json)) — GitHub issues are public, so don't open one
with exploit details. Include the mode, platform, and a minimal reproduction.
Non-sensitive hardening ideas are welcome as regular
[issues](https://github.com/wynainfo/pi-permission-modes/issues).
