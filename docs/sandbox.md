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
| `denyWrite` | string[] | `[]` | Write-denied paths; a `denyWrite` entry wins over `allowWrite` however the two are nested (a project under a denied home is read-only) | may add entries |
| `denyRead` | string[] | credential paths, see below | Unreadable inside the sandbox. Linux masks a file with `/dev/null` and a directory with an empty tmpfs; macOS returns a permission error | may add entries |
| `allowRead` | string[] | `[]` | Readable again inside a `denyRead` region (deny-then-allow; [modes.md, Strict home](modes.md#strict-home)). A more specific `denyRead` or a session block inside a carve-out still wins | may remove entries |
| `network.allowedDomains` | string[] | package registries and GitHub | Hosts bash may reach; `*.example.com` wildcards and an optional `:port` suffix are accepted. Absent means no filtering ([network.md](network.md)) | may remove entries |
| `network.deniedDomains` | string[] | `[]` | Hosts always refused, even when the network is open for the session | may add entries |
| `insideRoots` | string[] | `[]` | Roots the bash escape heuristic treats as inside, for remote paths named in `ssh` commands and the like ([Inside roots](#inside-roots)). Bash only; no file-tool or sandbox access | may remove entries |
| `askOnBlockedHost` | boolean | true | Prompt live when bash tries a host outside the allowlist. `false` denies silently | may set `false` |
| `allowLocalBinding` | boolean | true | A sandboxed command may listen on local ports and this machine may connect to them while the command runs; on macOS also direct loopback TCP, past the proxy ([Local binding](#local-binding)) | may set `false` |
| `macos.enableWeakerNetworkIsolation` | boolean | unset | macOS only. Allow the `trustd` lookup Go programs need to verify TLS certificates ([macOS](#macos)) | may set `false` |
| `linux.allowNestedUserNamespaces` | boolean | unset | Linux only. Let a sandboxed command create user and mount namespaces of its own, for Chromium, Electron, rootless podman ([Linux](#linux)) | may set `false` |

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
profile is applied in place on Linux and macOS (the runtime swaps its config:
the proxy reads the allow and deny lists per request, filesystem rules
compile at the next command; commands already running keep their sandbox as
it was) unless the switch is between a filtered and an unfiltered network,
which restarts the runtime once no sandboxed command is running. Windows
restarts on every change, because its permission entries are stamped per
session ([Windows](#windows)). `/sandbox` names how the last switch went.
While background shells run, a switch that restarts asks before it stops
them, and a `/reload` hands them to the new extension instance together
with the runtime they run under; a changed profile then waits until the
last shell ends ([shells.md, Lifetime](shells.md#lifetime)).
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

On Windows the scratch base is `%TEMP%\pi`, and `TMPDIR`, `TEMP` and `TMP`
inside sandboxed bash all point at the session's scratch directory; the
`/tmp/pi` entry of the stock `allowWrite` has no effect there. The sandbox
account's own `%TEMP%` is unrelated and invisible to you.

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
it misses Plan mode's read-only refusals, and after an in-place mode switch
it still judges writes by the lists of the mode the runtime was started
with (the paths that changed are reported as before the switch, or not at
all). Lines for `/dev` and `/proc` are dropped. A refused host that you could still allow is followed by a hint
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

## Local binding

`sandbox.allowLocalBinding` says whether a sandboxed command may listen on a
local port and whether this machine may connect to it while the command
runs: a dev server under test, a preview you open in the browser. It is on
unless set; a project config may set it to `false`, never back to `true`.
Version 2.5.0 spelled it `macos.allowLocalBinding` inside the `sandbox`
block; that spelling is still read, and an explicit top-level value wins
over it. What it does differs per platform:

- **macOS.** The profile otherwise allows direct TCP only to the proxy's own
  ports, so nothing can listen and a raw TCP client that does not speak
  proxy protocols (`libpq`, database CLIs) cannot reach a loopback service.
  The key maps to the runtime's `network.allowLocalBinding`: sandboxed bash
  may bind or accept on local ports and connect to loopback directly;
  every other host still goes through the allowlist. The runtime cannot
  separate the two, so turning it on opens loopback services without a
  prompt. Costs: loopback services are not sandboxed (a Postgres with
  `trust` authentication on loopback, the `initdb` default, is passwordless
  superuser access for any sandboxed command, so give the agent its own role
  and password), bind and inbound are allowed on all interfaces (a `0.0.0.0`
  dev server is reachable from the LAN while it runs; bind `127.0.0.1`), and
  a process that backgrounds itself survives the command on macOS with its
  profile still applied. `false` restores the runtime default: no listening,
  loopback through the proxy and its prompt only
  ([troubleshooting.md, macOS loopback services](troubleshooting.md#macos-loopback-services)).
- **Windows.** The fence stops the sandbox account's outbound connects, not
  inbound ones, so a listener is reachable from this machine while the
  command runs and dies with it. That is the `true` behaviour, and it is
  all the backend can do: `false` is not enforced (Windows Firewall rules
  need an administrator and do not filter loopback). `/sandbox` and the
  awareness section say so when a mode sets it.
- **Linux.** The sandbox has a network namespace of its own, so a sandboxed
  command may listen but this machine cannot reach it, whatever the key
  says. Managed jobs will relay declared ports to the host; until then the
  key has no effect on Linux.

Loopback services on this machine are otherwise reached through the proxy
like any other host: `localhost` needs the live prompt's approval once per
session, on every platform ([network.md, Allowlist](network.md#allowlist)).

## macOS

One switch the runtime offers only on macOS, under `sandbox.macos` with the
runtime's own name. It is off unless set, accepted but without effect on
Linux and Windows, and settable only in the global config: a project may
turn it off, never on. Enable it for one mode (a custom "Build + cloud"
mode, say) rather than for every sandboxed mode.

```jsonc
"sandbox": {
  "macos": { "enableWeakerNetworkIsolation": true }
}
```

**`enableWeakerNetworkIsolation`.** On macOS, Go programs verify TLS
certificates through the system's `trustd` daemon over Mach IPC, not through
a certificate file, so `SSL_CERT_FILE` changes nothing and the profile's
denial of that lookup makes `gh`, `kubectl`, `terraform`, and `gcloud` fail
with `x509: OSStatus -26276`. The switch allows the lookup. Cost: `trustd`
fetches revocation and issuer URLs named in the certificates it is handed,
outside the proxy and its allowlist, so a sandboxed process can move data out
through a crafted certificate. The runtime calls the switch "weaker network
isolation" for that reason
([troubleshooting.md, macOS Go TLS](troubleshooting.md#macos-go-tls)).

`/sandbox` shows the switch; off macOS it says "no effect here". The
awareness section tells the model about the Go TLS limit while it is off.

## Inside roots

The bash analysis reads every path-like argument as a local path, so
`ssh nas ls /mnt/user` prompts as an escape to `/mnt/user`, and approving it
runs the command unsandboxed. Exempting `ssh` arguments wholesale would hide
`ssh -i ~/.ssh/key` and the local side of `scp`. `sandbox.insideRoots` names
the roots instead:

```jsonc
"sandbox": { "insideRoots": ["/mnt/user", "/srv/backup"] }
```

A path under one of them is not an escape: the command neither prompts for
it nor runs unsandboxed, it runs inside the sandbox like any in-project
command, so a local write there is still refused by the sandbox and a local
read is as allowed as any other read. The file tools do not see the list (a
`read` of `/mnt/user/x` still prompts as outside the project), nothing is
forwarded to the runtime, and modes with `sandbox.enabled: false` skip the
escape heuristic anyway. Literal paths, `~` expands, globs are ignored.
Global config only: a project may remove entries, never add one. `/sandbox`
lists the roots.

## Linux

A sandboxed command has a network namespace of its own, with its own
loopback: a server it starts is unreachable from this machine, and a
background shell's server is reached through bash's `expose` parameter,
which relays ports into the shell ([shells.md, Network](shells.md#network)).
For that relay the directory of the node binary that runs pi is readable
inside the sandbox in every mode (next to the runtime's own package).

One switch the runtime offers only on Linux, under `sandbox.linux` with the
runtime's own name, same rules as the macOS block: off unless set, accepted
but without effect elsewhere, global config only (a project may turn it off,
never on).

```jsonc
"sandbox": {
  "linux": { "allowNestedUserNamespaces": true }
}
```

**`allowNestedUserNamespaces`.** Since runtime 0.0.80 a sandboxed command
stays in the namespaces made for it: it cannot create a user namespace or a
mount namespace of its own. Programs that sandbox themselves that way stop
working inside the sandbox: Chromium and Electron (so Playwright and
Puppeteer with the bundled browsers), rootless podman and buildah, a nested
bubblewrap, `unshare -r`. They fail with `EPERM` on the `unshare` or
`clone` call, and the message rarely names the cause. The switch lifts the
restriction for the mode. Cost: a process that can build its own user and
mount namespaces has more of the kernel's attack surface available to it; the
bubblewrap profile, the write bounds, the masked reads and the network
allowlist still apply. Where the program offers it, running it without its
own sandbox (`chromium --no-sandbox`, Playwright's `chromiumSandbox:
false`) needs no switch; the OS sandbox contains it either way. The
restriction is enforced by the seccomp helper, or by bubblewrap 0.8 and
newer when it is not installed setuid; where neither applies nothing limits
namespaces and the runtime says so under `SRT_DEBUG`
([troubleshooting.md, nested sandboxes on Linux](troubleshooting.md#nested-sandboxes-on-linux)).

## Windows

On native Windows the sandbox is the runtime's own Windows backend (alpha in
`@anthropic-ai/sandbox-runtime`). It is a different mechanism from
bubblewrap and `sandbox-exec`, with the same profile keys on top:

- Each command runs in Git Bash **as a separate local account**,
  `srt-sandbox`, started through the bundled `srt-win.exe` helper. Anything
  the command spawns, by any route, still carries that account.
- The network allowlist is enforced by a Windows Filtering Platform rule
  keyed on that account: it can connect only to the extension's loopback
  proxy, which applies the allowlist and the live prompt as on Linux. DNS
  lookups are not fenced (the system resolver answers them), connections
  are.
- The profile becomes NTFS permission entries for that account, added when
  the runtime initializes and removed when it resets: `allowWrite` grants
  Modify, `allowRead` grants Read and Execute, `denyRead` and `denyWrite`
  add Deny entries that win over a grant above them. The account has no
  rights of its own on your files, so on Windows reads are what the profile
  grants, not "everything but the denies". Granting the whole user profile
  is not an option: NTFS copies an inheriting entry onto every file below,
  and a whole profile exceeds the runtime's 60 s limit for one grant. The
  stock profiles therefore grant read access to the per-user tool roots
  that exist on the machine (`AppData\Local\Programs`, npm, pnpm, Volta,
  fnm, nvm, Scoop, WinGet, pip's user scripts, pyenv, uv, `.local\bin`,
  `go\bin`, `.dotnet\tools`, `.bun\bin`, `.deno\bin`, `.cargo\bin`), so
  tools installed for your user only still run; a mode that sets
  `allowRead` itself replaces that list. Configuration files in your profile
  are not granted and would not be read anyway: HOME inside the sandbox is
  the sandbox account's (your global git config and identity travel along,
  see below). Denies outside every grant are dropped before they reach the
  runtime: the account cannot read there in the first place, and the
  runtime stamps each deny's parent folder too, so `~/.ssh` would walk the
  whole profile. The credential list still holds: nothing of your profile
  is readable but the tool roots.

**Install.** Git for Windows (for all users, under Program Files, or the
profile must grant the per-user install read access) and one elevated
`/sandbox install` per machine (one UAC prompt): it creates the account, a
random password stored encrypted machine-wide, and the firewall rule.
`/sandbox uninstall` removes them. Until then the sandboxed modes prompt
before every bash command, as when the sandbox is unavailable anywhere
([troubleshooting.md, Windows sandbox install](troubleshooting.md#windows-sandbox-install)).

**Self-check.** The backend only adds entries for its account, so it is as
tight as the permissions already on the machine. Before the first command
the extension runs a probe inside the sandbox: the project's parent folder
and the drive root must not be writable (a folder created directly at a
drive root grants every local user Modify, so sibling projects would be
writable). A parent the account cannot read (a project inside your profile)
is reported once but keeps the sandbox active: that is tighter, not weaker.
A failed probe degrades to prompting and says why
([troubleshooting.md, Windows sandbox self-check](troubleshooting.md#windows-sandbox-self-check)).
Folders the profile grants write access to are not probed.

**What the command sees.** The sandboxed process starts from the sandbox
account's own profile with the broker's `PATH` and the proxy variables.
The extension adds your shell environment minus the account's identity and
profile paths (`USERNAME`, `USERPROFILE`, `APPDATA`, `HOME`, ...), the temp
and path variables, and the proxy and CA variables the runtime sets, so
`PI_*` and your tool settings arrive as on Linux. `TMPDIR`, `TEMP` and `TMP`
point at the session scratch directory. Your global git config is copied
into the command folder and read as `GIT_CONFIG_GLOBAL`, since the account
has no `.gitconfig` of yours (withheld by a mode that masks `~/.gitconfig`;
your `user.name` and `user.email` are exported either way). Git and cargo
are told to skip certificate revocation checks, which cannot leave the
fence ([troubleshooting.md, TLS revocation on Windows](troubleshooting.md#tls-revocation-on-windows)).

**Differences to Linux and macOS.**

- Plan mode (or any `writable: false` mode) re-initializes the runtime on
  the switch instead of dropping writes per command: grants are permission
  entries stamped at initialize time. The switch takes a moment (the
  runtime copies the entries over every granted tree, and pi is blocked
  while it does), so it starts one quiet second after the last cycle step:
  cycling through several modes pays for the last one only. The footer
  says "applying sandbox profile" meanwhile; a bash call that arrives
  during it is refused with "run the command again". Every change of
  profile restarts the runtime here, so while background shells run, every
  switch asks first ([shells.md, Lifetime](shells.md#lifetime)).
- A session block ("Deny and block") still rides along per command: denies
  are the one per-command filesystem change the backend supports.
- Programs installed for your user only are reachable only through the
  profile's read grant ([troubleshooting.md, Per-user tools on Windows](troubleshooting.md#per-user-tools-on-windows)).
- A project on a mapped network drive or a UNC path is refused
  ([troubleshooting.md, Mapped drive or UNC project on Windows](troubleshooting.md#mapped-drive-or-unc-project-on-windows)).
- Loopback services on the host go through the proxy like any other host,
  so `localhost` needs the live prompt's approval once per session.
- A sandboxed command can listen on a port, and anything on this machine
  can connect to it while the command runs: the fence stops the account's
  outbound connects, not inbound ones, so a dev server started inside a
  command is reachable from your browser (on Linux the sandbox's loopback is
  its own and it is not). Bind servers to `127.0.0.1`; one bound to
  `0.0.0.0` answers on the LAN as far as Windows Firewall lets it.
  `sandbox.allowLocalBinding: false` cannot be enforced here
  ([Local binding](#local-binding)).
- Background processes die with the command here too: the runner holds them
  in a job object, so a server has to be started and used within one
  command (`server & sleep 30; curl ...; kill %1`).

`/sandbox` shows the account, the Git Bash in use and the staged helper. The
awareness section tells the model about the account, what is readable, and
the revocation workaround.

## Platforms

| Platform | Sandbox | Notes |
|---|---|---|
| Linux, WSL2 | bubblewrap plus a seccomp write observer | needs `bubblewrap`, `socat`, `ripgrep` on `PATH`; Ubuntu 24.04 and newer need an AppArmor exception ([troubleshooting.md](troubleshooting.md#bubblewrap-namespaces)); programs that sandbox themselves need the [Linux](#linux) switch |
| macOS | `sandbox-exec` | no extra packages; globs allowed in the path lists; [local binding](#local-binding) opens loopback directly; Go TLS verification needs the [macOS](#macos) switch |
| WSL1 | none | no user namespaces; reported as unsupported, the sandboxed modes prompt instead |
| Windows | the runtime's native backend (alpha): a separate local account, a firewall rule keyed on it, NTFS permission entries | needs Git for Windows and one elevated `/sandbox install`; see [Windows](#windows). Until then the sandboxed modes prompt instead |

When the sandbox is unavailable, Default, Plan, and Build show
`(!) <reason>` in the footer, and in-project bash that would have been
sandboxed prompts for confirmation instead. You are never silently
unprotected.
