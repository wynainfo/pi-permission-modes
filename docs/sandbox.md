# Sandbox

The OS sandbox is the real enforcement for the bash tool. When a mode's
`sandbox.enabled` is true, every in-project bash command runs wrapped by
`@anthropic-ai/sandbox-runtime`: bubblewrap on Linux (including WSL2),
`sandbox-exec` on macOS. Writes are confined to `allowWrite`, the configured
`denyRead` paths are unreadable, and network traffic goes through a filtering
proxy, whatever the command does. Only bash is sandboxed; the file tools are
policy-gated ([permissions.md](permissions.md)).

## Keys

All keys live under a mode's `sandbox` block. "Project" says what a project
config may do with the key ([configuration.md, Project config](configuration.md#project-config)).

| Key | Type | Default (stock) | Meaning | Project |
|---|---|---|---|---|
| `enabled` | boolean | true (false in YOLO) | Run bash inside the OS sandbox. `false` runs it unsandboxed; the mode's bash policy still applies | cannot change |
| `writable` | boolean | true (false in Plan) | `false` makes the sandbox read-only: writes fail everywhere, including the project. The session scratch directory stays writable | may set `false` |
| `allowWrite` | string[] | `[".", "/tmp/pi"]` | Writable roots. `.` is the project. The session scratch directory and the runtime's `/tmp/claude` are always added | may remove entries |
| `denyWrite` | string[] | `[]` | Write-denied paths inside the writable roots | may add entries |
| `denyRead` | string[] | credential paths, see below | Unreadable inside the sandbox. Linux masks a file with `/dev/null` and a directory with an empty tmpfs; macOS returns a permission error | may add entries |
| `allowRead` | string[] | `[]` | Readable again inside a `denyRead` region (deny-then-allow; [modes.md, Strict home](modes.md#strict-home)). A more specific `denyRead` or a session block inside a carve-out still wins | may remove entries |
| `network.allowedDomains` | string[] | package registries and GitHub | Hosts bash may reach; `*.example.com` wildcards and an optional `:port` suffix are accepted. Absent means no filtering ([network.md](network.md)) | may remove entries |
| `network.deniedDomains` | string[] | `[]` | Hosts always refused, even when the network is open for the session | may add entries |
| `askOnBlockedHost` | boolean | true | Prompt live when bash tries a host outside the allowlist. `false` denies silently | may set `false` |

Paths accept `~` and `$HOME`. The stock `denyRead`: `~/.ssh`, `~/.aws`,
`~/.gnupg`, `~/.netrc`, `~/.git-credentials`, `~/.pypirc`,
`~/.gem/credentials`, `~/.vault-token`, `~/.password-store`,
`~/.pi/agent/auth.json`, `~/.pi/agent/oauth.json`.

The runtime has write paths of its own that no config removes: `/tmp/claude`,
`~/.npm/_logs`, `~/.claude/debug`, and on macOS the user's `$TMPDIR` under
`/var/folders`. Only `/tmp/claude` counts as in-bounds for the prompt layer.

## How a profile reaches the runtime

At session start the extension initializes the runtime with the active
mode's profile (`profileToConfig` in `src/config-load.ts` turns the block
above into the runtime's config: `network`, `filesystem.denyRead`,
`allowRead`, `allowWrite`, `denyWrite`). A mode switch that changes the
profile re-initializes the runtime once no sandboxed command is running.
Per command, the extension adds what only that run needs: the read-only
switch in Plan mode, this session's "Deny and block" paths as extra
`denyRead`, and the git directories of a worktree. `/sandbox` prints the
effective configuration.

The runtime proxies network traffic (HTTP and SOCKS on localhost, with a
per-session auth token only the sandboxed child sees) and enforces the
allowlist there; the sandboxed process has no other route out.

## Scratch directory

Every session gets its own scratch directory: `/tmp/pi/<session-id>/` on
Linux and macOS, `<os.tmpdir()>/pi/<session-id>/` on Windows. Override the
base with `PI_PERMISSION_TMPDIR` (for a `noexec` `/tmp`, for example). The
awareness section names it, `TMPDIR` points there inside bash (sandboxed and
unsandboxed runs), and it is always sandbox-writable and in-bounds, even if a
config drops `/tmp/pi` from `allowWrite`. `/sandbox` shows the path.

All sessions on the host share the `/tmp/pi` base (sticky and world-writable
like `/tmp`; each session folder is `0700`). Nothing is deleted at shutdown:
`/reload` and resume find their files again. At every session start, sibling
folders untouched for 7 days are removed (directories only; files and
symlinks are never touched). Plan mode's read-only bash cannot write there,
so the pointer is not advertised in Plan mode.

## Temp directories per platform

The runtime always allows writes to its own `/tmp/claude`; on macOS `/tmp`
is `/private/tmp` and both spellings are handled. The per-user macOS temp dir
under `/var/folders` is not writable; `TMPDIR` inside sandboxed bash points
at the session scratch directory instead. A tool that hardcodes `/tmp` and
ignores `TMPDIR` fails silently inside the sandbox (the kernel denies the
write, no prompt); add `/tmp` to the mode's `allowWrite` if you need such a
tool, at the cost of sharing `/tmp` with everything else on the host (and set
`acknowledgeDefaults` so the outdated-default warning stays quiet).

## Linux glob limitation

The runtime drops glob patterns from `allowWrite`, `denyRead`, and
`denyWrite` on Linux; use literal paths there (macOS supports globs). A path
whose name happens to contain glob characters (`[wip] app`) is matched
literally too, since runtime 0.0.79. This applies to the sandbox lists, not
the `permission` policy globs, which the extension matches itself.

## Violations reported to the model

When a sandboxed command tries to write outside the writable roots or to
reach a host the allowlist refused, its output ends with a
`<sandbox_violations>` block naming the path or host, so the model can adjust
instead of guessing. Linux reports refused write attempts (a denied read
returns nothing; there is no failing syscall to observe); macOS reports both
through the system sandbox log. The Linux report is best effort: it can list
a write that landed in the throwaway tmpfs over a read-denied directory, and
it misses Plan mode's read-only refusals. Lines for `/dev` and `/proc` are
dropped. A refused host that you could still allow is followed by a hint
naming it ([network.md, Requesting access](network.md#requesting-access)).

## Placeholders and masked dotfiles

The runtime write-protects a fixed set of dotfiles and directories at the
project root (`.git/hooks`, `.gitconfig`, `.gitmodules`, shell rc files,
`.ripgreprc`, `.mcp.json`, `.vscode`, `.idea`, `.claude/{commands,agents}`).
When one is absent, it blocks the path by mounting `/dev/null` over the first
missing component; because the project is writable, bubblewrap materializes
that mount point as a 0-byte read-only file. The runtime removes these once
no sandboxed command runs, and re-covers leftovers of a crashed session on
its next run.

Inside the sandbox those masks are character devices, so `git status` lists
them as untracked and `git add -A` at the root fails with "can only add
regular files" ([troubleshooting.md](troubleshooting.md#git-add-fails-on-masked-dotfiles)).

Every existing ancestor of a protected path is a mount point inside the
sandbox on Linux: renaming or removing such a directory from a sandboxed
command fails with `EBUSY`, and `rm -rf` of a nested repository leaves its
`.git/hooks` and the pinned directories behind. Run the removal outside the
sandbox (it prompts) if you mean it.

## Git worktrees and submodules

A project whose `.git` is a file (a worktree or a submodule) sandboxes
normally. The real git directory lies outside the project, so the extension
makes it and the shared common directory writable inside the sandbox, with
their `hooks`, `config`, and pointer files write-denied, and says so at
session start; `/sandbox` lists them. The `.git` file is trusted only for a
layout git itself creates: a worktree whose git dir points back at this
`.git` file, or a submodule whose `core.worktree` is this project. Anything
else grants nothing. In Plan mode the git directories stay read-only.

## Platforms

| Platform | Sandbox | Notes |
|---|---|---|
| Linux, WSL2 | bubblewrap plus a seccomp write observer | needs `bubblewrap`, `socat`, `ripgrep` on `PATH`; Ubuntu 24.04 and newer need an AppArmor exception ([troubleshooting.md](troubleshooting.md#bubblewrap-namespaces)) |
| macOS | `sandbox-exec` | no extra packages; globs allowed in the path lists |
| WSL1 | none | no user namespaces; reported as unsupported, the sandboxed modes prompt instead |
| Windows | none | the sandboxed modes prompt only, the allowlist is not enforced, `allowWrite` only feeds the prompt bounds. Run pi under WSL2 for containment |

When the sandbox is unavailable, Default, Plan, and Build show
`(!) <reason>` in the footer, and in-project bash that would have been
sandboxed prompts for confirmation instead. You are never silently
unprotected.
