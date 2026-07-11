# pi-permission-modes

Switchable, **user-definable** permission modes for the [pi](https://pi.dev)
coding agent. Each mode is a JSON bundle of an **OS-level sandbox profile**
(bubblewrap / `sandbox-exec`) plus an **allow / ask / deny policy** across every
surface (bash, file tools, the project boundary, web search, extension tools,
skills). Bash gating uses a real **tree-sitter** AST, not a regex.

Four modes ship by default — **Default → Plan Mode → Build → YOLO** — and you can
retune them or add your own in `permission-mode.json`.

`License: MIT` · see [SECURITY.md](SECURITY.md) for the threat model,
[CHANGELOG.md](CHANGELOG.md) for releases, and [CONTRIBUTING.md](CONTRIBUTING.md)
to hack on it.

---

## Install

```bash
pi install git:github.com/wynainfo/pi-permission-modes
```

`pi install` clones the package and runs `npm install` for you, so
`@anthropic-ai/sandbox-runtime` is fetched automatically; the pi SDK is provided
by the host. To try it without adding it to your config, run it directly from a
clone:

```bash
pi -e ./src/index.ts
```

On **Linux** (including **WSL2**) the sandbox also needs three system packages on
`PATH`:

```bash
# Debian / Ubuntu / WSL2
sudo apt install -y bubblewrap socat ripgrep
```

- `bubblewrap` — provides the `bwrap` binary that confines bash (the package is
  `bubblewrap`, the executable is `bwrap`).
- `socat` — network filtering; without it the sandbox fails to init and Build
  falls back to prompting.
- `ripgrep` — provides `rg`.

On **macOS** the sandbox uses the built-in `sandbox-exec` — no extra packages.
Native **Windows** is unsupported (modes degrade to prompting); run pi under WSL
for OS-level enforcement.

### Verify

1. Start pi in any project — the footer shows a mode indicator, e.g. `Default`.
2. Switch to Build (`alt+m` until `Build`, or `/perm build`):
   - sandbox active → `Build (sandboxed in project dir)`;
   - otherwise → `Build (!) sandbox-runtime missing ...` plus a fix-it notification.
3. `/sandbox` prints the active sandbox configuration (or why it's unavailable).

---

## Modes

Cycle with **`alt+m`** or set directly with **`/perm <mode>`**. The current mode
is persisted per session (survives `/reload`, resume, and branch navigation) and
shown in the footer.

Default, Plan Mode, and Build all run in-project `bash` inside the OS sandbox —
the footer shows `(sandboxed in project dir)` (muted) when it's active. Only YOLO
is unsandboxed. Labels are plain text (no icons); `alt+m` cycles in the order
below. The table describes the **shipped defaults** — every mode is data and can
be retuned, and you can add your own, in `permission-mode.json` (see
[Configuration](#configuration)).

| Mode | Behavior |
|------|----------|
| **Default** | Confirm every `bash`/`edit`/`write`. Approved **in-project** `bash` runs **sandboxed** (writes confined to the project); approved **out-of-project** access runs **unsandboxed**. Writes to protected paths are hard-blocked. |
| **Plan Mode** | Planning mode. Reads are free; in-project `bash` runs **sandboxed read-only** (writes/deletes fail), so only read commands effectively work. The one mutation allowed without confirmation is **creating/editing Markdown** (`*.md`/`*.markdown`) inside the project — other `edit`/`write` are blocked. Any out-of-project access prompts. A system-prompt addition steers the model: for a planning task, write the plan to `plan/<YYYY-MM-DD>_<description>.md`, render it for review with the **`show_plan`** tool, then ask you to switch to Build to apply it. |
| **Build** | All reads/writes/`bash` **inside the project** run with no confirmation; in-project `bash` runs **sandboxed**. Prompts only when a tool touches a path **outside** the project, or `bash` escalates privileges (`su`/`sudo`/`doas`/`pkexec`/`runuser`/`setpriv`/`chroot`). Approved out-of-project commands run **unsandboxed**. Writes to protected paths are hard-blocked. |
| **YOLO** | Never prompts, never sandboxes. Can do anything the current user can. |

> **When the sandbox is unavailable** (missing dependency, init failure,
> `--no-sandbox`, or the project is a **git worktree/submodule** — see below):
> Default/Plan/Build show `(!) <reason>` in the footer, and in-project `bash` that
> would have been sandboxed instead **prompts** for confirmation — you are never
> silently unprotected.

> **Sandbox placeholder cleanup:** the sandbox runtime write-protects a fixed set
> of dotfiles/dirs at the project root (`.git`, `.gitconfig`, `.gitmodules`,
> `.bashrc`/`.zshrc`/… shell rc files, `.npmrc`, `.ripgreprc`, `.mcp.json`,
> `.vscode`, `.idea`, `.claude/{commands,agents}`). When one of these is **absent**,
> it blocks the path by mounting `/dev/null` over the first missing component, and
> — because the project is writable in Default/Build — bubblewrap materializes that
> mountpoint as a **0-byte, read-only file** that survives teardown (and, for
> `.git`, would break the next command). The extension keeps such projects **fully
> sandboxed** and deletes these 0-byte placeholders before and after every
> sandboxed run, so nothing accumulates. Only 0-byte *files* are removed — real
> directories (`.vscode/`, `.git/`, …) and non-empty files (`.gitmodules`, …) are
> never touched.
>
> A **real git worktree/submodule** (`.git` is a *non-empty* file pointing at the
> real gitdir) genuinely can't be sandboxed — bubblewrap can't bind `.git/hooks`
> under a file, and that file is legitimate so we won't delete it. There the
> extension disables the sandbox for the project (falling back to prompting)
> instead of letting every command fail with `bwrap: ... Not a directory`. Use a
> normal clone for full Build-mode sandboxing.

### CLI flags

- `--perm <mode>` — start in a given mode (any defined mode name).
- `--no-sandbox` — disable the OS sandbox for the sandboxed modes (falls back to
  AST/heuristic gating + prompts).

### Session approvals

When a mode `ask`s, the prompt offers **Allow once / Allow for session / Deny**.
"Allow for session" remembers that action (per mode) so it isn't re-asked for the
rest of the session. For **bash**, the grant is keyed on the command names
extracted from the chain, and **every** name must already be granted for a
command to pass silently — approving `git` does *not* cover a later
`git status && curl … | sh` (that chain prompts again, and approving it grants
`git` *and* `curl`). Clear them with `/perm clear-approvals`.

---

## How protection works

Two independent layers compose:

1. **Policy engine** (`allow` / `ask` / `deny`): every tool call resolves against
   the active mode's policy for its surface (`bash`, `read`/`write`/`edit`/…, the
   cross-cutting `path` gate, `external_directory`, `web_search`, `tool`,
   `skill`). `deny` blocks, `ask` prompts, `allow` passes. For **bash**, the
   command is parsed with **tree-sitter** (real AST) so each command — including
   those nested in `$(...)`, backticks, subshells, and `sh|bash|… -c '…'`
   scripts (re-parsed recursively) — is matched against the `bash` patterns
   **and** the cross-cutting `path` gate (against the joined command and each
   individual token, so `"path": { "*.env": "deny" }` blocks `cat .env` wherever
   the target appears), and out-of-project paths / privilege escalation are
   detected structurally — including through wrapper commands (`env sudo …`,
   `nice -n 10 sudo …`, `xargs sudo …`). If the tree-sitter grammar can't load, it falls back to the
   original regex heuristic (`bashConfirmReason`) — never worse than before.
2. **OS sandbox** (`@anthropic-ai/sandbox-runtime`): the real enforcement for
   bash. When a mode's `sandbox.enabled` is true, in-project bash runs wrapped by
   `sandbox-exec` (macOS) / `bubblewrap` (Linux), confining **writes** to the
   profile's `allowWrite` (project + `/tmp` by default) and denying reads of the
   profile's `denyRead` secrets — regardless of what the command does. A mode with
   `sandbox.writable:false` (Plan) runs bash **read-only**; `sandbox.enabled:false`
   (YOLO) runs it unsandboxed.

So a `bash` command that policy says `allow` still runs **sandboxed**; `ask`
prompts then runs sandboxed (or unsandboxed for an out-of-project escape you
approve); `deny` never runs. If the sandbox is unavailable, the sandboxed modes
fall back to **prompting** for in-project bash and the footer shows a warning, so
you're never silently under-protected.

> Note: only the model's `bash` tool is OS-sandboxed. File tools (`read`/`edit`/
> `write`/…) are governed by the policy engine and the path checks, not bubblewrap
> — which is why the Plan-mode Markdown-only rule and the protected-path backstop
> are enforced at the tool layer. Commands you explicitly approve, and everything
> in a non-sandboxing mode (YOLO), run **unsandboxed** since you authorized them.

**Tool hiding.** A mode's `hideTools` list removes those tools from the model
*before* it reasons (via the active-tools allowlist), so it never attempts them.
`show_plan` is never hidden.

**Skills & extension tools.** Skills are gated by name at `/skill:<name>` (the
`skill` surface); any non-builtin/extension tool (including MCP-as-tool in a host
that adds them) is gated by tool name (the `tool` surface). In **Default** and
**Plan**, a tool/skill the host adds that has no rule yet **prompts on first use**
— *Allow once · Allow this session · Allow forever · Deny*. "Allow forever"
persists `<mode>.permission.<tool|skill>.<name>: "allow"` to your global config so
it never asks again. **Build** and **YOLO** allow all tools/skills without
prompting. (Set a mode's `tool`/`skill` to `"allow"` to opt that mode out of the
first-use prompt, or to `"deny"` to block.)

**Protected paths.** Unless a mode sets `bypassProtectedPaths` (only YOLO does),
`edit`/`write` to protected paths are hard-blocked — matched by path segment, not
loose substring, on both the literal target **and** its symlink-resolved
canonical path (so a link pointing at `.git/` or a dotfile can't smuggle a write
past the backstop). The set mirrors the sandbox-runtime mandatory-deny list: `.git/`,
`node_modules/`, `.vscode/`, `.idea/`, `.env`/`.env.*`, `.claude/{commands,agents}/`,
and common dotfiles (`.bashrc`, `.zshrc`, `.profile`, `.gitconfig`, `.npmrc`, …).
This matters most in Build, where file tools aren't OS-sandboxed.

**Residual risk you should know about.** Bash gating uses a real AST when
available, but the OS sandbox remains the hard boundary: an approved
out-of-project command runs *unsandboxed*, and a non-sandboxing mode (YOLO) never
confines anything. Reads inside the sandbox stay broad (only `denyRead` secrets
are blocked at the kernel). Treat YOLO and explicitly-approved out-of-project
commands as fully trusted. See [SECURITY.md](SECURITY.md).

---

## Configuration

Modes are data, layered in this order:

1. **Stock defaults** — `permission-mode.defaults.json`, shipped with the extension
   (the four built-in modes). This is the same format you edit; copy it to make
   your own, or run **`/perm init`** to drop a copy at the global path below.
2. `~/.pi/agent/permission-mode/permission-mode.json` (**global, full authority**):
   redefine built-in modes, add your own, and set `defaultMode` / `cycleOrder`.
   (Stable location, independent of where `pi install` placed the extension.)
3. `<project>/.pi/permission-mode.json` (**project, tighten-only**): may only make
   an existing mode *stricter*. Its permission policy is applied as a
   most-restrictive overlay (so it can only `ask`/`deny` more, never loosen — no
   matter what patterns it uses), and its sandbox is intersected/unioned the
   stricter way. A project config **cannot** add modes, change defaults, or widen
   anything. Opening an untrusted repo can never weaken your protection.

### Shape

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/wynainfo/pi-permission-modes/main/schemas/permission-mode.schema.json",
  "defaultMode": "default",
  "cycleOrder": ["default", "plan", "build", "yolo"],
  "modes": {
    "default": {
      "label": "Default",
      "color": "muted",                 // muted | mdLink | accent | error
      "systemPrompt": "@plan",          // optional; "@plan" = the dated Plan-mode prompt
      "sandbox": {
        "enabled": true,                // false = run bash unsandboxed (YOLO-style)
        "writable": true,               // false = bash runs read-only (Plan-style)
        "allowWrite": [".", "/tmp"],
        "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg"],
        "denyWrite": [],
        "network": { "allowedDomains": ["github.com", "*.github.com"], "deniedDomains": [] }
      },
      "permission": {
        "path": { "*": "allow", "*.env": "deny" },  // cross-cutting gate (deny overrides per-tool allow)
        "external_directory": "ask",                // the out-of-project boundary
        "read": "allow", "grep": "allow", "find": "allow", "ls": "allow",
        "write": "ask", "edit": "ask",
        "bash": { "*": "ask", "sudo*": "deny" },     // matched per command (name + args)
        "web_search": "ask",
        "tool": "allow",                            // any non-builtin/extension tool, by name
        "skill": "allow"                            // skills, by name
      },
      "hideTools": []                               // tools removed from the model in this mode
    }
  }
}
```

**Actions:** `allow` (pass through), `ask` (prompt), `deny` (block). A surface is
either a single action or a `{ "<glob>": <action> }` map where **`*` matches any
characters incl. `/`**, `?` matches one, `~`/`$HOME` expand, **the last matching
pattern wins** (put `"*"` first as the default), and across the `path` /
`external_directory` / per-surface layers the **most restrictive wins**.

### Defining your own mode

Add a mode under `modes` in the global config and (optionally) list it in
`cycleOrder`. Example — a "review" mode: read-only sandbox, web search off, the
`edit`/`write` tools hidden entirely:

```jsonc
{
  "cycleOrder": ["default", "review", "build", "yolo"],
  "modes": {
    "review": {
      "label": "Review", "color": "mdLink",
      "sandbox": { "enabled": true, "writable": false, "allowWrite": [".", "/tmp"], "denyRead": ["~/.ssh"] },
      "permission": { "read": "allow", "bash": "allow", "web_search": "deny", "write": "deny", "edit": "deny" },
      "hideTools": ["edit", "write"]
    }
  }
}
```

> **Linux glob limitation (sandbox filesystem only).** The sandbox-runtime drops
> glob patterns from its `allowWrite`/`denyRead`/`denyWrite` lists on Linux — use
> literal paths there (macOS supports globs). This applies to the **sandbox**
> lists, not the `permission` policy globs, which are matched by this extension.

---

## Disabling

- Temporarily: launch pi with `--no-extensions` (disables all), or `--no-sandbox`
  to keep the modes but drop OS sandboxing.
- Permanently: `pi remove git:github.com/wynainfo/pi-permission-modes` (or
  remove the entry from your pi settings).

---

## License

[MIT](LICENSE) © Nico Merz
