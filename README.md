# pi-permission-modes

[![CI](https://github.com/wynainfo/pi-permission-modes/actions/workflows/ci.yml/badge.svg)](https://github.com/wynainfo/pi-permission-modes/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Switchable, **user-definable** permission modes for the [pi](https://pi.dev)
coding agent. Each mode is a JSON bundle of an **OS-level sandbox profile**
(bubblewrap / `sandbox-exec`) plus an **allow / ask / deny policy** across every
surface (bash, file tools, the project boundary, web search, extension tools,
skills). Bash gating uses a real **tree-sitter** AST, not a regex.

Four modes ship by default - **Default → Plan Mode → Build → YOLO** - and you can
retune them or add your own in `permission-mode.json`.

See [SECURITY.md](SECURITY.md) for the threat model,
[CHANGELOG.md](CHANGELOG.md) for releases, and [CONTRIBUTING.md](CONTRIBUTING.md)
to hack on it.

---

## Install

From npm (recommended):

```bash
pi install npm:pi-permission-modes
```

or straight from GitHub:

```bash
pi install git:github.com/wynainfo/pi-permission-modes
```

`pi install` fetches the package and runs `npm install` for you, so
`@anthropic-ai/sandbox-runtime` comes along automatically; the pi SDK is
provided by the host. Useful variants:

- `pi install npm:pi-permission-modes@2.1.1` - pin a version (`pi update` won't advance it)
- `pi install -l npm:pi-permission-modes` - project-local install (`.pi/npm/`, shareable with your team)
- `pi update --extensions` - pull the latest release later

To try it without adding it to your config, run it directly from a
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

- `bubblewrap` - provides the `bwrap` binary that confines bash (the package is
  `bubblewrap`, the executable is `bwrap`).
- `socat` - network filtering; without it the sandbox fails to init and the
  sandboxed modes fall back to prompting.
- `ripgrep` - provides `rg`.

> **Ubuntu 24.04 and newer** (desktop and server; WSL2 images usually do
> not) enable `kernel.apparmor_restrict_unprivileged_userns`, which strips
> the capabilities bubblewrap and the runtime's seccomp helper need. Every
> sandboxed command then fails with `bwrap: ... Operation not permitted` and
> nothing runs. Either disable the restriction
> (`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, persist it
> in `/etc/sysctl.d/`) or grant `userns` to `bwrap` in an AppArmor profile.
> WSL1 has no user namespaces at all; the sandbox reports it as unsupported.

On **macOS** the sandbox uses the built-in `sandbox-exec` - no extra packages.

> **Native Windows: no sandbox.** There is no OS-level sandbox on Windows and
> this extension does not attempt one. The sandboxed modes degrade to
> *prompting only*: every in-project `bash` command asks for confirmation, the
> network allowlist is not enforced, and `allowWrite` only feeds the prompt
> bounds. For real containment run pi under **WSL2** and follow the Linux
> instructions above.

### Verify

1. Start pi in any project - the footer shows a mode indicator, e.g. `Default`.
2. Switch to Build (`alt+m` until `Build`, or `/perm build`):
   - sandbox active → `Build (sandboxed in project dir)`;
   - otherwise → `Build (!) sandbox-runtime missing ...` plus a fix-it notification.
3. `/sandbox` prints the active sandbox configuration (or why it's unavailable).

---

## Modes

Cycle with **`alt+m`** or set directly with **`/perm <mode>`**. The current mode
is persisted per session (survives `/reload`, resume, and branch navigation) and
shown in the footer.

Default, Plan Mode, and Build all run in-project `bash` inside the OS sandbox.
The footer always shows the mode, the network state, and their shortcuts -
e.g. `Build (sandboxed in project dir, alt+m)  Network: filtered (alt+n)` -
with the network chip green while the domain allowlist filters and orange when
open (see [Network](#network)). Only YOLO is unsandboxed. Labels are plain text
(no icons); `alt+m` cycles in the order below. The table describes the **shipped defaults** - every mode is data and can
be retuned, and you can add your own, in `permission-mode.json` (see
[Configuration](#configuration)).

| Mode | Behavior |
|------|----------|
| **Default** | Confirm every `bash`/`edit`/`write`; reads are free. Approved **in-project** `bash` runs **sandboxed** (writes confined to the project). |
| **Plan Mode** | Planning mode. Reads are free; in-project `bash` runs **sandboxed read-only** (writes/deletes fail), so only read commands effectively work. The one mutation allowed without confirmation is **creating/editing Markdown** (`*.md`/`*.markdown`) inside the project - other `edit`/`write` are blocked. A system-prompt addition steers the model: for a planning task, write the plan to `plan/<YYYY-MM-DD>_<description>.md`, render it for review with the **`show_plan`** tool, then ask you to switch to Build to apply it. |
| **Build** | Reads, writes, and `bash` **inside the project** run with no confirmation; in-project `bash` runs **sandboxed**. |
| **YOLO** | Never prompts, never sandboxes, no protected-path backstop. Can do anything the current user can. |

In every mode except YOLO: **out-of-project** access prompts; `bash` that
reaches outside the project or **escalates privileges**
(`su`/`sudo`/`doas`/`pkexec`/`runuser`/`setpriv`/`chroot` - detected even
through wrappers like `env`/`nice`/`xargs` and `bash -c '…'` scripts) prompts,
and runs **unsandboxed** once you approve it; and `edit`/`write` to
**protected paths** (`.git/`, `.env`, dotfiles, … - see
[below](#how-protection-works)) are hard-blocked. The mode's **sandbox-writable
directories** (`allowWrite` - `/tmp/pi` by default - plus the session's
[scratch directory](#scratch-directory) and the runtime's own `/tmp/claude`)
count as *in-bounds*: a temp file there is not an escape, so it neither prompts
nor runs unsandboxed. Neither is an in-project **symlink to an outside
executable** (a venv's `bin/python`, a tool shim): running it is what the
project intends, and the sandbox still governs what it may touch. Symlinks to
outside directories or non-executable files stay escapes.

> **When the sandbox is unavailable** (missing dependency, init failure,
> unsupported platform, `--no-sandbox`): Default/Plan/Build show
> `(!) <reason>` in the footer, and in-project `bash` that would have been
> sandboxed instead **prompts** for confirmation - you are never silently
> unprotected.

> **Sandbox violations are reported to the model.** When a sandboxed command
> tries to write outside the mode's writable roots or to reach a host the
> allowlist refused, its output ends with a `<sandbox_violations>` block
> naming the path or host, so the model can adjust instead of guessing why
> a step failed. Linux reports refused write attempts (a denied read just
> returns nothing, there is no failing syscall to observe); macOS reports
> both through the system sandbox log.

> **Sandbox placeholder cleanup:** the sandbox runtime write-protects a fixed set
> of dotfiles/dirs at the project root (`.git/hooks`, `.gitconfig`, `.gitmodules`,
> `.bashrc`/`.zshrc`/… shell rc files, `.ripgreprc`, `.mcp.json`, `.vscode`,
> `.idea`, `.claude/{commands,agents}`). When one of these is **absent**, it
> blocks the path by mounting `/dev/null` over the first missing component, and
> because the project is writable in Default/Build, bubblewrap materializes that
> mountpoint as a **0-byte, read-only file**. The runtime removes its own mount
> points after every command; the extension additionally sweeps such 0-byte
> files at startup and around each run, for the case where a pi died
> mid-command. Only 0-byte *files* are removed - real directories (`.vscode/`,
> `.git/`, …) and non-empty files (`.gitmodules`, …) are never touched.
>
> **Git worktrees and submodules** (`.git` is a file pointing at the real git
> dir) sandbox normally on every platform: the runtime protects `.git/hooks`
> only when `.git` is a directory. Because the real git dir lies outside the
> project, the extension makes it and the shared common dir writable inside
> the sandbox (git needs them for the index, refs, and objects) with their
> `hooks` and `config` write-denied, the same protection a normal repository
> gets. `/sandbox` lists them.

### Scratch directory

Every session gets its own **scratch directory** for temporary files:
`/tmp/pi/<session-id>/` on Linux and macOS, `<os.tmpdir()>/pi/<session-id>/`
on Windows (override the base with the `PI_PERMISSION_TMPDIR` env var, e.g. for
a `noexec` `/tmp`). The awareness section names it, `TMPDIR` points there inside
bash (sandboxed *and* unsandboxed runs; Windows also gets `TEMP`/`TMP`), and it
is always sandbox-writable and in-bounds - even if a global or project config
drops the shared `/tmp/pi` base from `allowWrite`, so the instruction to use it
stays truthful. `/sandbox` shows the path.

Sandbox-wise, all pi sessions on the host share the `/tmp/pi` base (it is in
the shipped `allowWrite`; the base is created sticky and world-writable like
`/tmp`, each session folder is `0700`). Instruction-wise, each session is told
to use only its own folder - including YOLO, which is otherwise unsandboxed but
still gets a short "scratch directory" pointer. Plan mode's read-only bash can't
write there (like everywhere else), so it isn't advertised there.

Nothing is deleted at shutdown - `/reload` and session resume find their files
again (the folder is keyed on pi's session id). Instead, at every session start,
**sibling folders untouched for 7 days are removed**; the current folder is
touched on start so a long-lived session isn't swept by a peer. Files and
symlinks under the base are never touched.

### Network

In the sandboxed modes, bash network traffic is filtered by the mode's **domain
allowlist** (package registries + GitHub by default). This is no longer a silent
wall - a request to a host outside the allowlist **pauses while you're asked**
(*Allow for session / Allow forever / Deny*), then proceeds or fails:

- **`alt+n`** toggles filtering for the session: `Network: filtered` (green) ⇄
  `Network: open` (orange) in the footer, which always shows the shortcut.
- **`/net`** - `status` (allowlist, session grants/denies), `allow <domain…>`
  (grant for the session), `open` / `restrict` (same as `alt+n`), `reset`
  (forget session grants/denies).
- The model has a **`request_network_access`** tool: it names the domains and a
  reason, you approve or deny - one prompt can cover several domains (e.g. all
  hosts an install needs). Denied hosts stay denied for the session (no
  prompt-storms from retrying installers), and any blocked host is reported in
  the command output so the model knows exactly what happened instead of
  guessing at proxies.
- "Allow forever" persists the domain to the active mode's allowlist in your
  global config. Set a mode's `sandbox.askOnBlockedHost` to `false` to restore
  silent denying.

Grants, denies, and the open toggle are **session-scoped** (except "Allow
forever") and apply instantly - no sandbox restart.

### CLI flags

- `--perm <mode>` - start in a given mode (any defined mode name).
- `--no-sandbox` - disable the OS sandbox for the sandboxed modes (falls back to
  AST/heuristic gating + prompts).

### Session approvals

When a mode `ask`s, the prompt offers **Allow once / Allow for session / Deny**.
"Allow for session" remembers that action (per mode) so it isn't re-asked for the
rest of the session. For **bash**, the grant is keyed on the command names
extracted from the chain, and **every** name must already be granted for a
command to pass silently - approving `git` does *not* cover a later
`git status && curl … | sh` (that chain prompts again, and approving it grants
`git` *and* `curl`). Clear them with `/perm clear-approvals`.

**Deny and block.** A prompt for an out-of-project *path* (bash or a file
tool) offers a fourth option, **Deny and block `<path>` for this session**.
Plain Deny refuses that one command; the agent is free to try again another
way, and reads outside the project are not contained by the sandbox (see
[SECURITY.md](SECURITY.md)), so a script that opens the file would succeed.
Deny and block adds the path to the session's block list, and every
sandboxed command from then on carries it as extra `denyRead`, so any
indirect read from bash gets nothing (Linux masks a file with `/dev/null`,
macOS returns a permission error), and the file tools refuse it without a
prompt. The awareness section lists the block, so
the model stops probing. Only the exact file or directory named is blocked,
never the home directory, a system root, or an ancestor of the project or of
a writable root; when a path can't be blocked safely the option is simply not
offered. `/perm blocks` lists the session's blocks, `/perm unblock <path>`
lifts one, and `/perm clear-approvals` clears them with the grants.

---

## How protection works

Two independent layers compose:

1. **Policy engine** (`allow` / `ask` / `deny`): every tool call resolves against
   the active mode's policy for its surface (`bash`, `read`/`write`/`edit`/…, the
   cross-cutting `path` gate, `external_directory`, `web_search`, `tool`,
   `skill`). `deny` blocks, `ask` prompts, `allow` passes.
   For **bash**, the command line is parsed with **tree-sitter** (a real AST)
   and every command it contains - including ones nested in `$(...)`, backticks,
   subshells, and `sh|bash|… -c '…'` scripts (re-parsed recursively) - is judged
   separately: matched against the `bash` patterns **and** the `path` gate
   (against the joined command and each individual token, so
   `"path": { "*.env": "deny" }` blocks `cat .env` wherever the target appears),
   with out-of-project paths and privilege escalation (even through wrappers
   like `env`/`nice`/`xargs`) detected structurally. If the tree-sitter grammar
   can't load, a whole-string token-scan heuristic stands in (see
   [SECURITY.md](SECURITY.md) for its limits).
2. **OS sandbox** (`@anthropic-ai/sandbox-runtime`): the real enforcement for
   bash. When a mode's `sandbox.enabled` is true, in-project bash runs wrapped by
   `sandbox-exec` (macOS) / `bubblewrap` (Linux), confining **writes** to the
   profile's `allowWrite` (project + `/tmp/pi` + the session's scratch directory
   by default) and denying reads of the
   profile's `denyRead` secrets - regardless of what the command does. A mode with
   `sandbox.writable:false` (Plan) runs bash **read-only**; `sandbox.enabled:false`
   (YOLO) runs it unsandboxed.

So a `bash` command that policy says `allow` still runs **sandboxed**; `ask`
prompts, then runs sandboxed - or **unsandboxed** for an out-of-project escape
or privilege escalation you approve, since you authorized it; `deny` never runs.

> Note: only the model's `bash` tool is OS-sandboxed. File tools (`read`/`edit`/
> `write`/…) are governed by the policy engine and the path checks, not bubblewrap -
> which is why the Plan-mode Markdown-only rule and the protected-path backstop
> are enforced at the tool layer. Reads inside the sandbox stay broad (only
> `denyRead` secrets are blocked at the kernel), and a non-sandboxing mode (YOLO)
> confines nothing. [SECURITY.md](SECURITY.md) has the full threat model.

**Sandbox awareness.** While a sandboxed mode is active, a factual
`## Sandbox & permissions` section is injected into the system prompt each turn:
the writable paths, denied reads, and network allowlist of the **merged** profile
(project overlays included), plus how the prompt flow works. The model then picks
paths and domains that actually work - project-local installs instead of `~/.npm`,
allowlisted hosts instead of dead fetches - and knows a boundary-crossing command
is fine to issue because you'll simply be asked. When the sandbox is degraded, the
section says so and points at the confirmation prompts instead. Opt a mode out
with `"injectSandboxInfo": false`; unsandboxed modes (YOLO) never inject.

**Tool hiding.** A mode's `hideTools` list removes those tools from the model
*before* it reasons (via the active-tools allowlist), so it never attempts them.
It only ever *removes*: tools you have off yourself (`defaultTools` in
`settings.json`, `--exclude-tools`) stay off, and switching modes restores
exactly what the previous mode hid. The list is honored literally, including
this extension's own `show_plan` - a setup that never plans can drop it; a
mode with the `"@plan"` prompt that hides it gets a warning at load, since
that prompt tells the model to call it.

**Skills & extension tools.** Skills are gated by name at `/skill:<name>` (the
`skill` surface); any non-builtin/extension tool (including MCP-as-tool in a host
that adds them) is gated by tool name (the `tool` surface). In **Default** and
**Plan**, a tool/skill the host adds that has no rule yet **prompts on first use** -
*Allow once / Allow this session / Allow forever / Deny*. "Allow forever"
persists `<mode>.permission.<tool|skill>.<name>: "allow"` to your global config so
it never asks again. **Build** and **YOLO** allow all tools/skills without
prompting. (Set a mode's `tool`/`skill` to `"allow"` to opt that mode out of the
first-use prompt, or to `"deny"` to block.)

**Protected paths.** Unless a mode sets `bypassProtectedPaths` (only YOLO does),
`edit`/`write` to protected paths are hard-blocked - matched by path segment, not
loose substring, on both the literal target **and** its symlink-resolved
canonical path (so a link pointing at `.git/` or a dotfile can't smuggle a write
past the backstop). The set mirrors the sandbox-runtime mandatory-deny list: `.git/`,
`node_modules/`, `.vscode/`, `.idea/`, `.env`/`.env.*`, `.claude/{commands,agents}/`,
and common dotfiles (`.bashrc`, `.zshrc`, `.profile`, `.gitconfig`, `.npmrc`, …).
This matters most in Build, where file tools aren't OS-sandboxed.

---

## Configuration

Modes are data, layered in this order:

1. **Stock defaults** - `permission-mode.defaults.json`, shipped with the extension
   (the four built-in modes). This is the same format you edit; copy it to make
   your own, or run **`/perm init`** to drop a copy at the global path below.
2. `~/.pi/agent/permission-mode/permission-mode.json` (**global, full authority**):
   redefine built-in modes, add your own, and set `defaultMode` / `cycleOrder`.
   (Stable location, independent of where `pi install` placed the extension.)
3. `<project>/.pi/permission-mode.json` (**project, tighten-only**): may only make
   an existing mode *stricter*. Its permission policy is applied as a
   most-restrictive overlay (so it can only `ask`/`deny` more, never loosen - no
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
    "default": {                        // values here are illustrative - run /perm init for the real defaults
      "label": "Default",
      "color": "muted",                 // muted | mdLink | accent | error
      "systemPrompt": "@plan",          // optional; "@plan" = the dated Plan-mode prompt
      "injectSandboxInfo": true,        // inject the mode's sandbox boundaries into the system prompt (default true)
      "sandbox": {
        "enabled": true,                // false = run bash unsandboxed (YOLO-style)
        "writable": true,               // false = bash runs read-only (Plan-style)
        "allowWrite": [".", "/tmp/pi"],
        "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg"],
        "allowRead": [],                // readable again inside denyRead (see "Strict home" below)
        "denyWrite": [],
        "network": { "allowedDomains": ["github.com", "*.github.com"], "deniedDomains": [] },
        "askOnBlockedHost": true          // live prompt for hosts outside the allowlist (false = silent deny)
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

### Keeping your global config current

`/perm init` writes a **full copy** of the stock defaults so you can edit values
in place. Every value in that file overrides the shipped default, which means a
later change to the defaults (2.3.0 narrowed `allowWrite` from `/tmp` to
`/tmp/pi`, for example) does not reach a copy that still carries the old value.
Two safeguards cover that:

- **Outdated-default warnings, every session start.** Each value in your global
  file is compared with the current default and with every older default
  shipped since 2.0.0 (`defaults-history.json`, clear-text copies with their
  version ranges). A value equal to the current default is fine; one that
  differs from it but equals an older default is reported by field, with both
  values and the versions it belonged to; one that equals no default is your
  customization and stays silent. Custom modes never trigger it.
- **A one-time notice after an upgrade.** When the extension version changes
  and the stock defaults changed between the two versions, users with a global
  config are told which fields changed, so a heavily customized file gets a
  nudge to compare even when nothing in it matches an old default verbatim.
  The last version seen is kept in `~/.pi/agent/permission-mode/state.json`.

To keep an outdated value knowingly, set `"acknowledgeDefaults": "<version>"`
(the version whose defaults you reviewed against; `/perm init` stamps the copy's
origin in a `$comment` for reference). The warnings stay silent until the
shipped defaults change again. Deleting values you never meant to change is the
simpler fix: the file is an overlay, and whatever it omits follows the defaults.

### Defining your own mode

Add a mode under `modes` in the global config and (optionally) list it in
`cycleOrder`. Example - a "review" mode: read-only sandbox, web search off, the
`edit`/`write` tools hidden entirely:

```jsonc
{
  "cycleOrder": ["default", "review", "build", "yolo"],
  "modes": {
    "review": {
      "label": "Review", "color": "mdLink",
      "sandbox": { "enabled": true, "writable": false, "allowWrite": [".", "/tmp/pi"], "denyRead": ["~/.ssh"] },
      "permission": { "read": "allow", "bash": "allow", "web_search": "deny", "write": "deny", "edit": "deny" },
      "hideTools": ["edit", "write"]
    }
  }
}
```

> **Linux glob limitation (sandbox filesystem only).** The sandbox-runtime drops
> glob patterns from its `allowWrite`/`denyRead`/`denyWrite` lists on Linux - use
> literal paths there (macOS supports globs). This applies to the **sandbox**
> lists, not the `permission` policy globs, which are matched by this extension.

> **Strict home (optional).** Reads outside the project are deny-listed, not
> allow-listed: the sandbox blocks only `denyRead` (credential files and dirs
> by default, see the defaults file) and lets everything else under `~` be
> read so toolchains work. `allowRead` turns that around for a mode: deny
> the whole home directory, then re-open only what the toolchain needs
> (deny-then-allow; a more specific `denyRead` or a session block inside a
> carve-out still wins). Paste into a mode's `sandbox` and trim the list:
>
> ```jsonc
> "denyRead": ["~"],
> "allowRead": [".", "/tmp/pi",
>               "~/.cache", "~/.config", "~/.local", "~/.npm", "~/.nvm",
>               "~/.cargo", "~/.rustup", "~/go", "~/.pyenv", "~/.gem"]
> ```
>
> Keep `.` in the list: a read-only mode (Plan) does not re-expose the
> project through `allowWrite`, and without it the project itself reads as
> empty. The extension re-opens its own runtime directory automatically (the
> sandbox's seccomp helper lives there, under `~/.pi/agent/...`); the
> interpreter that runs pi does not need to be listed either, only what the
> agent's commands execute (`~/.nvm`, `~/.cargo`, a venv outside the
> project). Everything under `~` that is not listed reads as **absent** inside
> bash (Linux mounts an empty directory over it; no error, no prompt), so a
> tool that needs a home path you left out fails silently; `/sandbox` shows
> the lists, and the awareness section tells the model what is masked.
> `~/.config` and `~/.local` are where most CLIs keep both their settings and
> their tokens (`gh`, many others); leave them out only if the agent never
> needs those tools. A project config may remove carve-outs, never add them.
> Note that `~/.pi/agent/auth.json` in the default `denyRead` means a `pi`
> started from inside sandboxed bash cannot authenticate; remove it if you
> spawn nested pi sessions that way.

> **Temp directories, per platform.** The runtime *always* allows writes to its
> own `/tmp/claude` (and, on macOS, to the user's `$TMPDIR` under
> `/var/folders/…`), regardless of `allowWrite`; on macOS `/tmp` is
> `/private/tmp` and both spellings are handled. Windows has no OS sandbox, so
> there `allowWrite` only feeds the prompt bounds. A tool that hardcodes `/tmp`
> and ignores `TMPDIR` fails **silently** inside the sandbox (no prompt - the
> kernel denies it); add `/tmp` back to the mode's `allowWrite` if you need
> such a tool, at the cost of sharing `/tmp` with everything else on the host
> (and set `acknowledgeDefaults` so the outdated-default warning stays quiet,
> see below).

---

## Disabling

- Temporarily: launch pi with `--no-extensions` (disables all), or `--no-sandbox`
  to keep the modes but drop OS sandboxing.
- Permanently: `pi remove npm:pi-permission-modes` (or
  `git:github.com/wynainfo/pi-permission-modes`, matching how you installed
  it) - or remove the entry from your pi settings.
