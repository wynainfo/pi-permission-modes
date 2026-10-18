# Troubleshooting

One section per message you or the model can see. Each names the cause and
the fix. Messages from the extension start with `permission-mode:` or
`[permission-mode]`.

## Bubblewrap namespaces

```
[permission-mode] sandbox: bubblewrap could not set up its namespaces, so the command did not run.
bwrap: setting up uid map: Permission denied
bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
```

Ubuntu 24.04 and newer (desktop and server; WSL2 images usually do not) set
`kernel.apparmor_restrict_unprivileged_userns=1`, which strips the
capabilities bubblewrap and the runtime's seccomp helper need. Every
sandboxed command then fails before it starts, and nothing runs unsandboxed.
Two fixes; the AppArmor profile is the narrower one:

```sh
sudo tee /etc/apparmor.d/bwrap >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/bwrap
```

Or disable the restriction system-wide:
`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, persisted in
`/etc/sysctl.d/60-userns.conf`. Check with
`bwrap --unshare-user --unshare-pid --unshare-net --ro-bind / / --proc /proc --dev /dev true`,
which must exit 0.

## Sandbox unavailable

```
permission-mode: OS sandbox unavailable - protection is heuristic-only.
sandbox-runtime missing (run npm install in the extension dir)
sandbox dependencies: ...
sandbox init failed: ...
```

The footer shows `(!) <reason>` and in-project bash prompts for every
command instead of running sandboxed. Causes, in the order the extension
checks them:

- **`sandbox-runtime missing`**: the npm dependency is not installed. Run
  `npm install` in the extension directory (the notification prints the exact
  `cd ... && npm install`). `pi install` normally does this for you.
- **`sandbox dependencies`**: on Linux `bubblewrap`, `socat`, or `ripgrep`
  is missing from `PATH`: `sudo apt install -y bubblewrap socat ripgrep`
  (the package is `bubblewrap`, the binary is `bwrap`). A root caller without
  `CAP_SETFCAP` is reported here too.
- **`sandbox init failed`**: the runtime threw while starting its proxy or
  its mounts; the message carries the runtime's error.
- **`sandbox unsupported on this platform`**: WSL1 (no user namespaces) or
  another platform the runtime does not know. On Windows the message is
  `sandbox unsupported on Windows (run pi under WSL2)`.

`/sandbox` prints the reason as well. `pi --no-sandbox` produces the same
degraded state on purpose.

## First command network denial

On runtime versions before 0.0.79 the first network call of a sandboxed
command could be refused because the command started before the in-sandbox
relays listened. Retrying worked. Upgrade the extension (it ships 0.0.79 or
newer since 2.5.0).

## macOS Go TLS

```
Post "https://api.github.com/graphql": tls: failed to verify certificate: x509: OSStatus -26276
gh: The token in keyring is invalid.
deny(1) mach-lookup com.apple.trustd.agent
```

`gh`, `kubectl`, `terraform`, `gcloud`, and other Go programs cannot verify
TLS certificates inside the macOS sandbox, while `curl` and `git` work in the
same sandbox. Go on macOS asks the system's `trustd` daemon for the verdict,
and the sandbox profile denies that lookup; `gh` then reports the token as
invalid, which it is not. Setting `SSL_CERT_FILE` does not help: Go ignores it
on macOS. The fix is the mode's `sandbox.macos.enableWeakerNetworkIsolation`
switch, with the cost described in
[sandbox.md, macOS](sandbox.md#macos). Without it, drive the API with
`curl` and a token, or run the tool with pi's `!` prefix.

## macOS loopback services

```
could not connect to server: Operation not permitted
deny network-outbound ... 127.0.0.1:5432
deny network-bind
```

A mode with `sandbox.allowLocalBinding` set to `false` (it is on unless
set; a project config may turn it off). On macOS the sandbox then allows
direct TCP only to its proxy, so a raw TCP client (a database driver,
`psql`, `redis-cli`) cannot reach a service on loopback, and nothing can
listen on a port. No allowlist entry changes that (`localhost` included).
The fix is `true` again, with the costs described in
[sandbox.md, Local binding](sandbox.md#local-binding). On Linux this does
not apply: the sandbox's network namespace has its own loopback, and a
service on the host's loopback is unreachable by design.

## Nested sandboxes on Linux

```
Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted
browserType.launch: Target page, context or browser has been closed
Error: cannot clone: Operation not permitted
unshare: unshare failed: Operation not permitted
```

Chromium and Electron (Playwright, Puppeteer), rootless podman and buildah,
a nested bubblewrap, or `unshare -r` fail inside a sandboxed mode while the
same command works outside it. Since sandbox-runtime 0.0.80 a sandboxed
command cannot create a user namespace or a mount namespace of its own, so a
program that builds its own sandbox that way is refused. Two ways out: run
the program without its own sandbox where it offers that (`chromium
--no-sandbox`, Playwright's `chromiumSandbox: false`, podman is not among
them), since the OS sandbox contains it either way; or set the mode's
`sandbox.linux.allowNestedUserNamespaces` switch, with the cost described
in [sandbox.md, Linux](sandbox.md#linux). The restriction needs the
runtime's seccomp helper or a bubblewrap 0.8 or newer that is not setuid;
where neither applies, nothing limits namespaces and the runtime says so
under `SRT_DEBUG=1`.

## Windows sandbox install

On Windows the sandbox is the runtime's native backend: commands run as the
local user `srt-sandbox` behind a Windows Filtering Platform fence keyed on
that account, and the mode's profile becomes NTFS permission entries for it.
It needs a one-time, elevated install per machine. Run `/sandbox install` in
pi (one UAC prompt): it creates the account with a random password, stored
encrypted machine-wide, and installs the firewall filter set. No logout is
needed and your own network is unaffected. `/sandbox uninstall` removes all
of it again.

Commands run in Git Bash, so Git for Windows must be installed for all users
(under Program Files), or the mode's profile must grant read access to a
per-user install (the stock defaults grant `%USERPROFILE%` read access).
Until the backend is installed, or when one of its checks fails, the
sandboxed modes ask before every bash command; the footer shows the reason
and `/sandbox` the details.

`file_id changed since prior grant - path was substituted (refusing)`: a
folder this pi process granted earlier was replaced on disk since, which
`srt-win` treats as a possible path swap. The usual cause is
`pi update --extensions` followed by `/reload`: the extension's own files
were reinstalled while the entries of the previous load were still held.
The extension retries the initialize once after releasing them; should the
message stay, restart pi.

## Windows sandbox self-check

On Windows the sandbox runs each command as the local user `srt-sandbox`
(the runtime's native backend). That backend only adds permission entries for
the sandbox user, so it is only as tight as the folder ACLs already on the
machine. When the sandbox initializes, the extension therefore runs a short
probe as the sandbox user: it tries to create a file in the project's parent
folder, at the drive root, and next to the staged `srt-win.exe`, and checks
that it can list the project's parent. Until the probe passes, bash asks
before every command, as it does when the sandbox is unavailable.

`... writable by the sandbox user`: a folder created directly at a drive root
(`C:\src`) inherits `Authenticated Users: Modify`, which the sandbox user
holds too, so sibling projects would be writable from inside the sandbox.
Keep that folder to yourself, once, from an elevated Command Prompt:

```
icacls C:\src /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" /grant:r "SYSTEM:(OI)(CI)F" /grant:r "Administrators:(OI)(CI)F"
```

Projects under your user profile (`C:\Users\<you>\...`) do not have this
problem: the profile grants other local users nothing.

`inside another sandboxed folder`: the project's parent is writable because
the sandbox account already holds a permission entry on it, which is how a
running pi session marks its own project (the entry is removed when that
session ends). Two sessions share the one sandbox account, so a project
inside another session's project cannot be kept apart from it: Plan mode in
the inner session could not stop writes the outer grant allows. Run pi in
one of the two folders, not both. A grant left behind by a session that did
not end cleanly is released from an administrator prompt, when no pi
session is running there:

```
icacls "C:\Users\<you>\outer" /remove:g srt-sandbox /T
```

`The sandbox user cannot read <parent>`: a notice, not a refusal. The
project's parent folder is not readable for the sandbox user (the usual
case for a project inside your user profile, which grants other accounts
nothing), so the sandbox is tighter than on Linux, where the parent would be
readable. The sandbox stays active. Should git or another tool fail inside
it with a permission error on that path, add the parent to the mode's
`allowRead` (a read grant is copied onto every file below the folder, so
prefer a small parent) or move the project.

`self-check did not complete`: the probe produced no result. `/sandbox`
shows the runtime's own status and the last error.

## SSH in the sandbox

`ssh` and git over SSH (`git@` remotes) cannot authenticate from sandboxed
bash: `~/.ssh` is in `denyRead`, so inside the sandbox the directory is
empty. `ssh -v` still prints `Trying private key: ~/.ssh/id_*` for every
default path; those lines do not mean a key was found. The model is told not
to try. Use HTTPS with a token, or run the step with pi's `!` prefix
([network.md, Git authentication](network.md#git-authentication)).

## Blocked by policy

```
bash command denied by policy
Path "<p>" is blocked by <mode>
Path "<p>" is protected
Access outside project blocked
Tool "<name>" blocked by <mode>
web search blocked by <mode>
<mode> allows editing Markdown files only
```

A `deny` rule of the active mode matched, or you answered Deny to a prompt.
`"blocked by <mode>"` comes from the mode's own `permission` block (or a
project overlay); `"is protected"` is the protected-path backstop, which no
rule can lift except `bypassProtectedPaths`; the Markdown-only message is
Plan mode's read-only sandbox. Which rule matched: compare the target with
the surface's patterns and the `path` gate, remembering last-match-wins and
most-restrictive-across-layers ([permissions.md, Resolution](permissions.md#resolution)).
One denied command does not mean the surface is off; the model should try
the intended step another way or ask.

```
Path <p> is blocked for this session (Deny and block); /perm unblock lifts it
```

You chose "Deny and block" for that path earlier in the session
([permissions.md, Deny and block](permissions.md#deny-and-block)).

## Silent failures inside the sandbox

A command fails with a permission or network error and no prompt appeared:
the sandbox refused it. Typical cases:

- a write outside `allowWrite` (for example a tool that hardcodes `/tmp` and
  ignores `TMPDIR`): use the scratch directory or add the path to
  `allowWrite` ([sandbox.md, Temp directories per platform](sandbox.md#temp-directories-per-platform));
- a read under `denyRead` or outside an `allowRead` carve-out: the file
  reads as absent, no error ([modes.md, Strict home](modes.md#strict-home));
- a host outside the allowlist with `askOnBlockedHost: false`, or a prompt
  that was dismissed ([network.md, Requesting access](network.md#requesting-access));
- Plan mode: every write fails, the sandbox is read-only.

The `<sandbox_violations>` block at the end of the output names the path or
host when the observer caught it ([sandbox.md, Violations reported to the model](sandbox.md#violations-reported-to-the-model)).

## git add fails on masked dotfiles

```
error: .bashrc: can only add regular files
```

Inside the sandbox the absent protected dotfiles at the project root are
character devices (the runtime's `/dev/null` masks). Add files by name, or
list the names (`.bashrc`, `.bash_profile`, `.zshrc`, `.zprofile`,
`.profile`, `.gitconfig`, `.gitmodules`, `.ripgreprc`, `.mcp.json`) in the
repository's `.git/info/exclude`
([sandbox.md, Placeholders and masked dotfiles](sandbox.md#placeholders-and-masked-dotfiles)).

## EBUSY when removing a directory

`mv` or `rm -rf` of a directory that holds a protected path fails with
`EBUSY` inside the sandbox: every ancestor of a protected path is a mount
point on Linux. Run the removal outside the sandbox; it prompts.

## Author identity unknown

`git commit` inside a strict-home mode fails with "Author identity unknown":
`~/.gitconfig` is masked. Add it to `allowRead`
([modes.md, Strict home](modes.md#strict-home)).

On Windows the sandbox account has no `.gitconfig` of yours, whatever the
profile grants, so the extension copies your global git config
(`~/.gitconfig` and `~/.config/git/config`) into the sandbox's command
folder and points `GIT_CONFIG_GLOBAL` at the copy: aliases, `core.autocrlf`
and your credential helper apply inside the sandbox as they do on Linux.
The copy is made when the sandbox initializes (a mode switch refreshes it)
and withheld in a mode whose `denyRead` masks `~/.gitconfig`; your
`user.name` and `user.email` travel as `GIT_AUTHOR_*` and `GIT_COMMITTER_*`
regardless, so commits carry your identity either way.

## Git asks for a username inside the sandbox

`fatal: could not read Username for 'https://github.com': terminal prompts
disabled` (or a hang on a username prompt on Linux): the remote wants
credentials and no credential helper could provide any. Inside the sandbox
nothing can prompt: there is no terminal, and on Windows Git Credential
Manager runs as the sandbox account, whose store is empty and which cannot
show a window. The model is told to stop and tell you. Set up a fine-grained
token read by a credential helper
([network.md, Git authentication](network.md#git-authentication)), or run
the step yourself with pi's `!` prefix (`!git clone ...`), which runs on
the host with your own credentials.

## TLS revocation on Windows

Inside the Windows sandbox, schannel (the TLS stack of System32 `curl`,
default-backend `git`, .NET and PowerShell) fetches certificate revocation
lists over WinHTTP, outside the proxy variables, and the firewall rule
blocks that. Tools that check revocation by default fail with
`CRYPT_E_REVOCATION_OFFLINE` (`0x80092013`). The extension exports
`GIT_CONFIG_PARAMETERS='http.schannelCheckRevoke=false'` and
`CARGO_HTTP_CHECK_REVOKE=false` into every sandboxed command, so git and
cargo work; for System32 curl pass `--ssl-no-revoke`. Git is also set to
`http.proxyAuthMethod=basic`: its libcurl otherwise sends the first CONNECT
to the sandbox proxy without credentials, gets a 407 and a closed
connection, and fails with "Proxy CONNECT aborted". Git also runs with
`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` and `GCM_PROVIDER=generic`
there: a remote that wants credentials fails at once instead of waiting on
a prompt the sandbox account cannot show (use a token, see
[network.md, Git authentication](network.md#git-authentication)), and Git
Credential Manager does not spend two seconds detecting a host provider
for the proxy when git hands it the proxy credentials to store. `gh`, PowerShell's
`Invoke-WebRequest` and .NET do not check revocation by default, and tools
on OpenSSL (Node, Python, cargo's own TLS) are unaffected.

## Per-user tools on Windows

The sandboxed command runs as `srt-sandbox`, not as you. A tool installed
for your user only (`%LOCALAPPDATA%\Programs`, Scoop, nvm or fnm Node,
`pip install --user`, `winget` without `--scope machine`) is on the
inherited `PATH` but fails with "command not found" or "Access is denied"
unless the mode's profile lets the sandbox account read it. The stock
profiles grant the common per-user tool roots that exist on the machine
([sandbox.md, Windows](sandbox.md#windows) lists them; `/sandbox` shows the
ones in effect). For a tool elsewhere, add its folder to the mode's
`allowRead` (which then replaces the stock list, so repeat the roots you
need), or install the tool for all users. Toolchains that need a writable
home of their own (rustup, cargo's registry) run from the sandbox account's
profile, not yours.

## Mapped drive or UNC project on Windows

The Windows backend refuses to start a command whose working directory is
on a mapped network drive (`subst`, `net use`) or a UNC path: srt-win exits
16 with its `mapped_drive_cwd` error. Drive mappings belong to your logon
session and the sandbox account has none. The self-check hits it first, so
the sandbox turns itself off at startup with the runtime's message in the
footer (`Windows sandbox off: ...`) and bash asks before every command; a
command run later in such a directory reports the same line after its
output. Work on a local drive, or start pi from the real path behind the
mapping.

## Outdated defaults notice

```
permission-mode: N value(s) in ~/.pi/agent/permission-mode/permission-mode.json still hold an outdated default:
permission-mode: updated X -> Y; the stock defaults changed for ...
```

Your global config carries a value that an older release shipped as its
default and the current release changed. Update the value, delete it so the
shipped default applies, or set `"acknowledgeDefaults": "<version>"` to keep
it knowingly ([configuration.md, Keeping your global config current](configuration.md#keeping-your-global-config-current)).

## Loader warnings

```
permission-mode: project config cannot ...
permission-mode: ignoring unknown sandbox field "..."
permission-mode: invalid action "..." for ...; treating as deny
```

A config value was dropped or coerced. Project warnings list what a project
config may not do ([configuration.md, Project config](configuration.md#project-config));
the others name the key and file. Fix the file and `/reload`.

## The sandbox became unavailable after this command was approved

The runtime failed between the prompt and the run (a `/reload` or a mode
switch in between). Run the command again.
