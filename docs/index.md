# pi-permission-modes documentation

Reference for the extension: every setting, every message, and how the
pieces fit. The [README](../README.md) is the short version; these files are
what the agent reads when a sandbox or permission limit blocks a step, and
what you read to change the configuration.

| You want to | Read |
|---|---|
| Know which file to edit, what a project config may change, why a warning about outdated defaults appears | [configuration.md](configuration.md) |
| Understand the four stock modes, define your own, control which mode pi starts in, approve a plan | [modes.md](modes.md) |
| Write `allow` / `ask` / `deny` rules, understand why a tool call prompted or was blocked, protected paths, session grants, "Deny and block" | [permissions.md](permissions.md) |
| Tune the OS sandbox: writable paths, denied reads, `allowRead` carve-outs, scratch directory, violations, platform notes | [sandbox.md](sandbox.md) |
| Allow a host, understand the live network prompt and `/net`, authenticate git inside the sandbox | [network.md](network.md) |
| Fix an error message: bubblewrap namespaces, sandbox unavailable, SSH, silent failures, `git add -A`, the Windows install and self-check | [troubleshooting.md](troubleshooting.md) |
| Fork or contribute: module layout, the decision flow, invariants, how to add a config key | [architecture.md](architecture.md) |

Related files in the repository root: [SECURITY.md](../SECURITY.md) (threat
model and known limitations), [CHANGELOG.md](../CHANGELOG.md),
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Commands and shortcuts at a glance

| Command | What it does |
|---|---|
| `alt+m` | Cycle the permission mode (`cycleOrder`) |
| `alt+n` | Toggle network filtering for the session (`Network: filtered` / `open`) |
| `/perm <mode>` | Switch to a mode by name |
| `/perm init` | Write a full copy of the stock defaults to the global config path |
| `/perm clear-approvals` | Forget this session's "Allow for session" grants and blocks |
| `/perm blocks`, `/perm unblock <path>` | List or lift this session's "Deny and block" paths |
| `/net status`, `/net allow <domain...>`, `/net open`, `/net restrict`, `/net reset` | Network allowlist, session grants, the open toggle |
| `/plan approve`, `/plan status` | Approve the pending plan, or name it |
| `/sandbox` | Print the active sandbox configuration, or why the sandbox is unavailable |
| `/sandbox install`, `/sandbox uninstall` | Windows: set up or remove the native sandbox (one UAC prompt each) |
| `pi --perm <mode>` | Start in a given mode |
| `pi --no-sandbox` | Keep the modes, drop OS sandboxing (prompts instead) |

The model also has two tools of its own: `request_network_access` (asks you
to allow hosts up front) and `show_plan` (renders a plan file for approval).
