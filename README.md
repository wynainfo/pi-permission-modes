# pi-permission-modes

[![CI](https://github.com/wynainfo/pi-permission-modes/actions/workflows/ci.yml/badge.svg)](https://github.com/wynainfo/pi-permission-modes/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Switchable, **user-definable** permission modes for the [pi](https://pi.dev)
coding agent. Each mode is a JSON bundle of an **OS-level sandbox profile**
(bubblewrap / `sandbox-exec`) plus an **allow / ask / deny policy** across every
surface (bash, file tools, the project boundary, web search, extension tools,
skills). Bash gating uses a real **tree-sitter** AST, not a regex.

Four modes ship by default - **Default -> Plan Mode -> Build -> YOLO** - and
you can retune them or add your own in `permission-mode.json`.

The complete reference lives in [`docs/`](docs/index.md) and ships with the
extension, so the agent can read it too: when a sandbox or permission limit
blocks a step, the message points at the section that explains it. See
[SECURITY.md](SECURITY.md) for the threat model, [CHANGELOG.md](CHANGELOG.md)
for releases, and [CONTRIBUTING.md](CONTRIBUTING.md) to hack on it.

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

- `pi install npm:pi-permission-modes@2.4.2` - pin a version (`pi update` won't advance it)
- `pi install -l npm:pi-permission-modes` - project-local install (`.pi/npm/`, shareable with your team)
- `pi update --extensions` - pull the latest release later

To try it without adding it to your config, run it directly from a clone:
`pi -e ./src/index.ts`. Node 22.12 or newer is required (pi itself needs
22.19).

On **Linux** (including **WSL2**) the sandbox also needs three system packages
on `PATH`:

```bash
# Debian / Ubuntu / WSL2
sudo apt install -y bubblewrap socat ripgrep
```

> **Ubuntu 24.04 and newer** (desktop and server; WSL2 images usually do not)
> restrict unprivileged user namespaces through AppArmor, and every sandboxed
> command fails with `bwrap: ... Operation not permitted`. Nothing runs
> unsandboxed. Grant `userns` to `bwrap` with a small AppArmor profile, or
> set `kernel.apparmor_restrict_unprivileged_userns=0`:
> [docs/troubleshooting.md](docs/troubleshooting.md#bubblewrap-namespaces).
> WSL1 has no user namespaces at all; the sandbox reports it as unsupported.

On **macOS** the sandbox uses the built-in `sandbox-exec` - no extra packages.
Go tools (`gh`, `kubectl`, `terraform`) need an opt-in switch per mode
([docs/sandbox.md](docs/sandbox.md#macos)); loopback services and local
ports are open unless a mode turns `sandbox.allowLocalBinding` off
([docs/sandbox.md](docs/sandbox.md#local-binding)).

> **Native Windows (alpha).** The sandbox is the runtime's Windows backend:
> commands run as a separate local account behind a firewall rule keyed on
> it, with the profile as NTFS permissions. It needs Git for Windows and one
> `/sandbox install` in pi (one UAC prompt, then one question: whether your
> user profile is readable to sandboxed commands, minus the credential
> stores). Until then the sandboxed modes degrade to *prompting only*.
> Details and limits: [docs/sandbox.md](docs/sandbox.md#windows).

### Verify

1. Start pi in any project - the footer shows a mode indicator, e.g. `Default`.
2. Switch to Build (`alt+m` until `Build`, or `/perm build`):
   - sandbox active -> `Build (sandboxed in project dir)`;
   - otherwise -> `Build (!) sandbox-runtime missing ...` plus a fix-it notification.
3. `/sandbox` prints the active sandbox configuration (or why it's unavailable).

---

## Modes

Cycle with **`alt+m`** or set directly with **`/perm <mode>`**. The current
mode is persisted per session and shown in the footer, next to the network
state: `Build (sandboxed in project dir, alt+m)  Network: filtered (alt+n)`.
The table describes the **shipped defaults**; every mode is data and can be
retuned, and you can add your own ([docs/modes.md](docs/modes.md)).

| Mode | Behavior |
|------|----------|
| **Default** | Confirm every `bash`/`edit`/`write`; reads are free. Approved **in-project** `bash` runs **sandboxed** (writes confined to the project). |
| **Plan Mode** | Reads are free; in-project `bash` runs **sandboxed read-only**, so only read commands work. The one mutation allowed without confirmation is creating or editing **Markdown** inside the project. A system-prompt addition steers the model to write a plan to `plan/<date>_<description>.md`, render it with the **`show_plan`** tool, and hand over: an **Accept / Decline** prompt follows the plan ([approving a plan](docs/modes.md#approving-a-plan)). |
| **Build** | Reads, writes, and `bash` **inside the project** run with no confirmation; in-project `bash` runs **sandboxed**. |
| **YOLO** | Never prompts, never sandboxes, no protected-path backstop. Can do anything the current user can. |

In every mode except YOLO: **out-of-project** access prompts; `bash` that
reaches outside the project or **escalates privileges** (`sudo` and friends,
detected even through wrappers and `bash -c` scripts) prompts, and runs
**unsandboxed** once you approve it; `edit`/`write` to **protected paths**
(`.git/`, `.env`, dotfiles, ...) are hard-blocked. When the sandbox is
unavailable, the sandboxed modes show `(!) <reason>` in the footer and
in-project `bash` **prompts** instead - you are never silently unprotected.

### At a glance

| Command | What it does |
|---|---|
| `alt+m`, `/perm <mode>` | Cycle or switch the mode |
| `alt+n`, `/net ...` | Toggle network filtering; allowlist, grants, denies |
| `/perm init` | Write a full copy of the stock defaults to the global config |
| `/perm clear-approvals`, `/perm blocks`, `/perm unblock <path>` | Session grants and "Deny and block" paths |
| `/plan approve`, `/plan status` | Plan approval |
| `/sandbox` | The active sandbox configuration |
| `pi --perm <mode>`, `pi --no-sandbox` | Start mode; keep the modes, drop OS sandboxing |

Network requests to hosts outside the allowlist **pause while you're asked**
(allow for the session or forever, or deny); the model can also ask for hosts
up front with `request_network_access`
([docs/network.md](docs/network.md)). Prompts for an out-of-project path
offer **Deny and block**, which masks the path for the rest of the session
([docs/permissions.md](docs/permissions.md#deny-and-block)). Git over SSH
cannot authenticate inside the sandbox (`~/.ssh` is masked); use HTTPS with a
fine-grained token ([docs/network.md](docs/network.md#git-authentication)).

---

## How protection works

Two independent layers compose:

1. **Policy engine** (`allow` / `ask` / `deny`): every tool call resolves
   against the active mode's policy for its surface. For **bash**, the command
   line is parsed with **tree-sitter** and every command it contains, nested
   ones included, is judged separately; out-of-project paths and privilege
   escalation are detected structurally
   ([docs/permissions.md](docs/permissions.md)).
2. **OS sandbox** (`@anthropic-ai/sandbox-runtime`): the real enforcement for
   bash. In-project bash runs wrapped by `sandbox-exec` (macOS) or
   `bubblewrap` (Linux), with **writes** confined to the profile's
   `allowWrite`, the profile's `denyRead` secrets unreadable, and network
   traffic filtered by a domain allowlist, regardless of what the command
   does ([docs/sandbox.md](docs/sandbox.md)).

So a `bash` command that policy says `allow` still runs **sandboxed**; `ask`
prompts, then runs sandboxed, or **unsandboxed** for an escape you approve;
`deny` never runs. Only the model's `bash` tool is OS-sandboxed; the file
tools are governed by the policy engine and the protected-path backstop.
While a sandboxed mode is active, the model is told its boundaries in the
system prompt, so it picks paths and hosts that work. [SECURITY.md](SECURITY.md)
has the full threat model and the known limitations.

---

## Configuration

Modes are data, layered in this order:

1. **Stock defaults** - `permission-mode.defaults.json`, shipped with the
   extension. Run **`/perm init`** to drop a full copy at the global path.
2. `~/.pi/agent/permission-mode/permission-mode.json` (**global, full
   authority**): redefine built-in modes, add your own, set `defaultMode` and
   `cycleOrder`.
3. `<project>/.pi/permission-mode.json` (**project, tighten-only**): may only
   make an existing mode *stricter*. Opening an untrusted repo can never
   weaken your protection.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/wynainfo/pi-permission-modes/main/schemas/permission-mode.schema.json",
  "defaultMode": "default",
  "cycleOrder": ["default", "plan", "build", "yolo"],
  "modes": {
    "default": {                        // values here are illustrative - run /perm init for the real defaults
      "label": "Default",
      "color": "muted",                 // muted | mdLink | accent | error
      "sandbox": {
        "enabled": true,                // false = run bash unsandboxed (YOLO-style)
        "writable": true,               // false = bash runs read-only (Plan-style)
        "allowWrite": [".", "/tmp/pi"],
        "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg"],
        "network": { "allowedDomains": ["github.com", "*.github.com"], "deniedDomains": [] }
      },
      "permission": {
        "path": { "*": "allow", "*.env": "deny" },  // cross-cutting gate (deny overrides per-tool allow)
        "external_directory": "ask",                // the out-of-project boundary
        "read": "allow", "grep": "allow", "find": "allow", "ls": "allow",
        "write": "ask", "edit": "ask",
        "bash": { "*": "ask", "sudo*": "deny" },    // matched per command (name + args)
        "web_search": "ask", "tool": "allow", "skill": "allow"
      }
    }
  }
}
```

Actions are `allow`, `ask`, `deny`; a surface is a single action or a glob
map where the **last matching pattern wins** and, across layers, the **most
restrictive wins**. Every key, the pattern syntax, the project rules, and the
outdated-default warnings: [docs/configuration.md](docs/configuration.md),
[docs/sandbox.md](docs/sandbox.md), [docs/permissions.md](docs/permissions.md).

---

## Documentation

| File | Covers |
|---|---|
| [docs/index.md](docs/index.md) | Topic map, commands and shortcuts |
| [docs/configuration.md](docs/configuration.md) | Files, layers, what a project config may change, keeping the global config current |
| [docs/modes.md](docs/modes.md) | The stock modes, mode fields, start mode, plan approval, your own modes, strict home |
| [docs/permissions.md](docs/permissions.md) | Rules, pattern syntax, resolution, bash gating, protected paths, session grants, Deny and block |
| [docs/sandbox.md](docs/sandbox.md) | Every sandbox key, scratch directory, violations, placeholders, platforms |
| [docs/network.md](docs/network.md) | Allowlist, requesting access, grants, git authentication |
| [docs/troubleshooting.md](docs/troubleshooting.md) | One section per error message |
| [docs/architecture.md](docs/architecture.md) | For forks and contributors |

---

## Disabling

- Temporarily: launch pi with `--no-extensions` (disables all), or `--no-sandbox`
  to keep the modes but drop OS sandboxing.
- Permanently: `pi remove npm:pi-permission-modes` (or
  `git:github.com/wynainfo/pi-permission-modes`, matching how you installed
  it) - or remove the entry from your pi settings.
