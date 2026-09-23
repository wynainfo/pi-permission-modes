# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **One-step plan approval.** After Plan Mode renders a plan with
  `show_plan`, an Accept / Decline prompt follows the model's handoff line
  as soon as the run ends. Accept switches to the approve mode (Build by
  default) and sends a real user message, "The plan in `<path>` is
  approved. Implement it now.", so the implementing turn starts under
  Build's system prompt rather than under a Plan prompt still in effect.
  Decline (or Esc) keeps Plan Mode and the pending plan. Switching into the
  approve mode by hand while a plan is pending asks once whether to
  implement it; `/plan approve` does it without asking, `/plan status`
  names the pending plan. The pending plan survives reload, resume, and
  branch navigation; an approved plan is never offered again; headless
  sessions get no prompts. New global config block `plan` with
  `approveMode` and `approveMessage` (`{path}` placeholder); a project
  config cannot set it. The Plan Mode prompt's handoff line and the
  `show_plan` result text now point the model at the prompt instead of
  `alt+m`.
- **Deny and block a path for the session.** Every prompt for an
  out-of-project path (bash escapes and the file tools) offers a fourth
  option, "Deny and block `<path>` for this session". Plain Deny only refused
  that one command, and reads outside the project are not contained by the
  sandbox, so an agent that was denied `cat ~/secret.txt` could write a
  Python script into the project and read the file anyway. Deny and block
  adds the path to the session's block list, which every sandboxed command
  from then on carries as extra `denyRead` (the runtime compiles filesystem
  rules per command, so no restart): bash reads of it get nothing (Linux
  masks the file with `/dev/null`,
  macOS returns EPERM), the file tools refuse it without a prompt, a later
  bash command naming it is blocked outright, and the awareness section
  lists it so the model stops probing. Only the exact file or directory is
  blocked, never the home directory, a system root, a direct child of `/`,
  or an ancestor of the project or of a writable root; when nothing can be
  blocked safely the option is not offered. `/perm blocks` lists the
  session's blocks, `/perm unblock <path>` lifts one, `/perm clear-approvals`
  clears them together with the grants. Session lifetime only.

- **`sandbox.allowRead`: carve-outs inside `denyRead`.** A mode can now
  deny a whole region and re-open paths inside it (deny-then-allow, a
  runtime feature since 0.0.77). The README shows a "strict home" mode
  built on it: `denyRead: ["~"]` with the project, the scratch base, and the
  toolchain directories in `allowRead`; everything else under the home
  directory reads as absent inside bash. A more specific `denyRead` or a
  session block inside a carve-out still wins. Project configs may only
  remove carve-outs. The awareness section lists them, `/sandbox` shows
  them, and Deny and block keeps offering paths that a carve-out re-exposes
  while skipping paths a deny already masks.

### Changed
- **Sandbox runtime upgraded from `@anthropic-ai/sandbox-runtime` 0.0.26 to
  0.0.77.** The runtime moved a long way in between, and several of this
  extension's workarounds became upstream fixes:
  - The `!` quoting bug is fixed in the runtime's own quoter. The
    command-file launcher stays: it also sets `TMPDIR` and keeps long
    heredocs clear of bubblewrap's argument cap.
  - **Git worktrees and submodules sandbox normally on Linux.** The runtime
    protects `.git/hooks` only when `.git` is a directory, so a gitfile no
    longer breaks bubblewrap and the extension no longer degrades those
    projects to prompting. Their git dir and common dir (outside the
    project) are made writable inside the sandbox so `git add`/`commit`
    work, with `hooks` and `config` write-denied as in a normal repository.
  - The extension re-opens the runtime's own package directory inside the
    sandbox: under a `denyRead` that covers it (a strict-home `~`), the
    runtime's seccomp helper would otherwise be unreadable and every command
    would fail with exit 127.
  - An empty network allowlist starts the filtering proxy itself now, so the
    reserved placeholder domain the extension used to inject is gone.
  - The runtime removes the 0-byte mount points bubblewrap leaves for absent
    protected dotfiles after every command; the extension's own sweep
    remains as the fallback for a session that died mid-command.
  - **Sandbox violations reach the model.** A run's output now ends with the
    runtime's `<sandbox_violations>` block when a command tried to write
    outside the writable roots or to reach a refused host (Linux: refused
    write attempts via a seccomp observer; macOS: the system sandbox log).
    Each run is attributed under its own id, with the real command text
    rather than the launcher.
  - Dependency problems are reported precisely: missing tools or a root
    caller without `CAP_SETFCAP` degrade to prompting with the reason in the
    footer; non-fatal findings (no seccomp helper for the architecture, so
    unix sockets stay unrestricted) are shown once and listed by `/sandbox`.
    A wrap-time refusal (`LinuxSandboxProfileError`) fails the command with
    its code instead of a generic error. When bubblewrap itself cannot create
    its namespaces the output says so and points at the Ubuntu 24.04
    `kernel.apparmor_restrict_unprivileged_userns` sysctl (README, Install).
  - Allowed hosts that resolve to loopback, link-local, this host, or a cloud
    metadata address are refused by the runtime (see SECURITY.md).
  - WSL1 is detected and reported as unsupported; native Windows stays
    unsupported on the extension's side (the runtime's Windows sandbox is an
    alpha that needs a separate install and integration).
  - The package grew to about 9 MB on disk: the runtime vendors its seccomp
    helper, a Java proxy agent, and a Windows binary.
- **Default `denyRead` covers more credential files:** `~/.netrc`,
  `~/.git-credentials`, `~/.pypirc`, `~/.gem/credentials`, `~/.vault-token`,
  `~/.password-store`, and pi's own `~/.pi/agent/auth.json` and
  `oauth.json`, in Default, Plan, and Build. Files that tools read from
  inside the sandbox (`~/.config/gh/hosts.yml`, `~/.kube`,
  `~/.docker/config.json`, `~/.npmrc`) are deliberately not included; the
  README shows a stricter "strict home" list to paste. Note that the pi auth
  entry means a `pi` started from inside sandboxed bash cannot authenticate;
  remove it if you spawn nested pi sessions that way. Existing global
  configs get the outdated-default warning for their old `denyRead`.
- The outdated-default audit now reports the whole version span a value
  shipped in (e.g. "the 2.0.0 to 2.3.1 default") instead of only the newest
  range that carried it.

## [2.3.1]

### Security
- **File-tool guards now judge the path pi actually opens.** pi's `read`,
  `write`, `edit`, `ls`, `grep`, and `find` normalize their `path` before
  opening it: `~` and `~/…` expand to the home directory, a leading `@` is
  stripped, and `file://` URLs become paths. The extension's guards judged
  the raw string, so `read ~/.ssh/id_rsa` resolved lexically to a missing
  in-project path and was allowed while pi read the real file, and `write
  @.env` slipped past the protected-path backstop. The dispatcher now applies
  the same normalization first; paths containing a NUL byte are blocked.
- **A session grant never covers an escape.** "Allow for session" was keyed
  on command names, so approving an in-project `cat README.md` let a later
  `cat ~/.ssh/id_rsa` pass without a prompt, and, being an out-of-project
  escape, run UNSANDBOXED; likewise `env FOO=1 ls` covered `env sudo …`.
  Escapes (out-of-project path, privilege escalation) are now keyed on the
  exact command string: an approved escape covers only that command.
- **Protected names match case-insensitively, and `.envrc` is protected.** On
  case-insensitive filesystems `.GIT` and `.ENV` are `.git` and `.env`; the
  backstop compared exact case. `.envrc` (executed by direnv on `cd`) joins
  the protected files.
- **A malformed project config could take the loader down and with it the
  sandbox.** A repository's `.pi/permission-mode.json` with a wrong-typed
  value (`"modes": {"default": null}`, `"allowWrite": 5`, a `"__proto__"`
  mode) threw inside the loader; pi swallowed the exception, so the session
  continued on the STOCK defaults with the user's global config ignored and
  the OS sandbox never initialized, and every in-project command then ran
  unsandboxed after a "sandbox unavailable" prompt. Every field of both
  layers is now type-checked and dropped with a warning instead of thrown
  on, prototype names (`__proto__`, `constructor`, `prototype`) are never
  treated as modes anywhere, a project file that is not a regular file or
  exceeds 1 MiB is ignored, and the session start keeps the previous
  configuration if loading fails for any other reason.
- **"Allow forever" no longer replaces an unparsable global config.** A
  stray comma in `permission-mode.json` made the persist step start from an
  empty object and overwrite the file, losing custom modes and settings.
  It now refuses with an error naming the file; the session grant still
  applies. The seeded `"*"` entry comes from the effective stock+global
  surface value rather than a blanket `ask`, so a project's tightened
  overlay is never baked into the global file and other tools keep their
  mode's default.
- **An invalid action inside a pattern map now coerces to `deny`** like the
  string form did; it was dropped, so a typo in a deny rule became allow.
- **A new global mode is validated:** missing `sandbox.enabled`/`writable`
  default to `true` with a warning instead of silently running bash
  unsandboxed, and a missing `permission` block defaults to `{}` (every
  surface asks) instead of crashing every tool call.
- **A headless child never starts in YOLO** even when the global
  `cycleOrder` lists only YOLO: the fallback now searches every mode.
- **A dangling in-project symlink pointing outside the project was judged
  inside.** The containment check resolves symlinks on the longest existing
  prefix of a path; a link whose target does not exist yet failed that
  resolution and fell back to its lexical, in-project location. The file
  tools are not OS-sandboxed, so a `write` through such a link would have
  created the target file outside the project without a prompt. Dangling
  links are now followed to where they point (bounded against cycles).

### Fixed
- **Sandbox lifecycle hardening.** An abort that landed while the runtime was
  still wrapping a command (or a call that was already cancelled) did not
  stop it; the command ran to completion. The wrapper now refuses to spawn a
  cancelled call, hands the signal to the runtime, and kills a run whose
  abort arrived during the wrap. Profile switches are serialized and the
  controller tracks whether the runtime is initialized separately from
  `ready`, so overlapping `alt+m` presses or a re-run of session start can
  no longer leave the runtime enforcing an older profile than the footer
  shows. If the sandbox becomes unavailable between a command's approval and
  its execution, the call fails with a message instead of running
  unsandboxed. The command-file directory is a private `mkdtemp` under `/tmp`
  rather than under an inherited `TMPDIR`.
- **Network prompts work with an empty allowlist, and an absent one is called
  what it is.** The runtime starts its filtering proxy only for a non-empty
  `allowedDomains`, so a mode with `[]` got no proxy: the live prompts, `/net
  allow`, `/net open`, and `request_network_access` were inert while the
  footer said "filtered". A reserved `.invalid` placeholder now keeps the
  proxy path alive for that case. A mode with no `allowedDomains` at all is
  not filtered by the runtime; the footer, the awareness section, and the
  request tool now say "unrestricted" instead of claiming filtering. The
  "network open" wording mentions denied domains, which `/net open` cannot
  lift. Session grants and remembered denies compare hostnames
  case-insensitively.
- **`TMPDIR` points at the scratch directory in every sandboxed run**, set by
  the launcher itself rather than relying on the runtime's proxy env block;
  read-only modes (Plan) keep the scratch directory writable so `mktemp` and
  Python's `tempfile` work there as they did before 2.3.0.
- **The scratch directory refuses a planted symlink.** A link at
  `/tmp/pi/<session-id>` (the base is shared and world-writable by design)
  was followed: its target would have been made mode 0700, added to
  `allowWrite`, and used as `TMPDIR`. The session folder must now be a real
  directory owned by the current user, and a base that has become a symlink
  is refused. A blank `PI_PERMISSION_TMPDIR` no longer suppresses the sticky
  bit on the shared base.
- An explicit `--perm` flag now wins over the persisted session mode on
  resume, as documented.
- **Bash escape detection sees what it used to miss.** Redirect targets
  (`echo x > /etc/evil`, `cat < /etc/hostname`, `$(< /etc/hostname)`), the
  words of `[[ -f /etc/shadow ]]`, heredocs fed to a shell (`bash <<EOF`),
  `eval` strings, `bash -o pipefail -c …`, `find … -exec sudo …`, `coproc`,
  escaped and ANSI-C spellings (`\/etc/x`, `$'/etc/x'`), `$HOME`-built
  paths, `~user`, glued flag values (`if=/etc/x`, `--git-dir=/etc/x`,
  `-C/etc`), and a bare `cd`/`cd -`/`pushd` (which go to the home or an
  unknown directory) all prompt now. A `bash` policy rule is also matched
  against the basename of a path head, the command a wrapper runs, and the
  quote-normalized spelling, so `"sudo*": "deny"` catches `/usr/bin/sudo`,
  `time sudo`, and `\git push` catches `"git push*"`. Shell globs and brace
  expansion remain matched as written (documented).
- `/perm init` and "Allow forever" write the public `$schema` URL; the stock
  file's relative path did not resolve from the agent directory. The schema
  no longer requires `enabled`/`writable` on every `sandbox` block, since
  partial overrides are what the loader supports and the extension writes.
- A directory named `..foo` inside the project was treated as outside it
  (the containment check tested for a `..` prefix rather than a `..`
  segment), prompting on every access.
- **A venv's `bin/python` no longer prompts (and no longer runs unsandboxed
  once approved).** The bash escape detector follows symlinks, so an
  in-project interpreter that links to the system Python - which is what
  `python -m venv` creates - resolved outside the project and prompted on
  every run; approving it lifted the sandbox for a command that was entirely
  in-project by intent. An in-project path whose symlink target is an
  executable file outside the project is now not an escape, in both the
  tree-sitter and the heuristic path. Symlinks to outside directories or
  non-executable files, dangling links, and paths named by their outside
  location still prompt as before; the file tools still follow symlinks.
- **The awareness section now says that background processes die with the
  command.** Each bash call runs in its own sandbox (a fresh PID namespace on
  Linux) that is torn down when the command exits, so `&`, `nohup`, and
  `setsid` cannot start anything long-running; a job either kept the call
  hanging until the timeout or was gone by the next turn, and the model found
  out by wasting turns. The section tells it up front to run long tasks in
  the foreground with an adequate timeout, or to ask the user.
- **Exclamation marks no longer arrive as `\!` in sandboxed bash.** The
  sandbox runtime embeds the command in a `bash -c` string that it quotes with
  the shell-quote package, up to three times over on Linux. Whenever the
  command contains a single quote, shell-quote uses its double-quoted form
  and escapes `!` as `\!`, which bash keeps literally inside double quotes.
  So every heredoc, `python3 -c '...'`, or `printf` with a `!` ran with
  corrupted bytes: no error, just `\!` in the output or on disk (the write
  tool, which bypasses bash, was unaffected). The command text is now kept
  out of that quoting entirely: it is written to a private host-side file
  (outside every `allowWrite`, mode 0600) and the runtime receives a launcher
  without single quotes or exclamation marks, `bash -c "$(<"file")"`, which
  survives the quoting unchanged; the innermost bash runs the file content
  as an ordinary `bash -c` script with the same `$0`, error prefixes, and
  exit status. Tests run the launcher through a real bash and through the
  runtime's nested shell-quote passes, with a control proving the raw path
  is mangled.

## [2.3.0]

### Added
- **Per-session scratch directory.** Every session gets `/tmp/pi/<session-id>/`
  (Linux/macOS; `<os.tmpdir()>/pi/<session-id>/` on Windows; base overridable
  with `PI_PERMISSION_TMPDIR`). The awareness section names it, `TMPDIR`
  points there inside bash (sandboxed runs via the runtime's `CLAUDE_TMPDIR`,
  unsandboxed runs via the bash tool's spawn hook; Windows also gets
  `TEMP`/`TMP`), it is always sandbox-writable and in-bounds - appended to
  the active profile, so a config that narrows the shared base can't make
  the instruction untrue - and `/sandbox` shows it. Keyed on pi's session id,
  so `/reload` and resume find their files; nothing is deleted at shutdown.
  Instead sibling folders untouched for 7 days are swept at session start
  (directories only; files/symlinks never touched; the current folder is
  touched on start). YOLO, otherwise silent, now gets a short "scratch
  directory" pointer so temp files stay per-session there too.

- **Outdated-default warnings for the global config.** `/perm init` writes a
  full copy of the stock defaults, which silently pins users to that version's
  values: a later default change never reaches a copy that still carries the
  old value (this release's `/tmp` narrowing being the first case). At every
  session start, each value in the global file is now compared with the
  current default and with every older default shipped since 2.0.0
  (`defaults-history.json`, clear-text with version ranges): a value that
  differs from the current default but equals an older one is reported by
  field with both values and its version range; customizations and custom
  modes stay silent. After an upgrade that changed the defaults, users with a
  global config get a one-time notice naming the changed fields (last seen
  version kept in `~/.pi/agent/permission-mode/state.json`). Set
  `"acknowledgeDefaults": "<version>"` to keep an outdated value knowingly;
  `/perm init` now stamps the copy's origin in a `$comment`.

### Changed
- **Shipped `allowWrite` narrowed from `/tmp` to `/tmp/pi`** in Default, Plan,
  and Build. The sandbox no longer lets bash write anywhere under `/tmp`, only
  under the shared pi base and the session folder - so sessions can't clobber
  each other's or other tools' temp files. A tool that hardcodes `/tmp` and
  ignores `TMPDIR` now fails inside the sandbox (silently - the awareness
  prompt tells the model to ask); add `/tmp` back to a mode's `allowWrite`
  if you depend on one. Existing global configs that list `/tmp` keep it.
- The awareness section's writable-paths bullet no longer suggests `/tmp/...`
  for temp files; the scratch-directory bullet does.
- **`hideTools` may now hide `show_plan`.** It was hard-exempted, so an
  explicit entry was silently swallowed; setups that never use Plan mode had
  no way to drop the tool from the model's list. The list is now honored
  literally. Stock modes are unchanged; a mode with the `"@plan"` system
  prompt that hides `show_plan` gets a loader warning, since that prompt
  instructs the model to call it. Proposed and first implemented by
  [@trtyr](https://github.com/trtyr) in
  [#8](https://github.com/wynainfo/pi-permission-modes/pull/8).
- README and SECURITY.md now say plainly that **native Windows has no
  sandbox**: the sandboxed modes prompt only, the network allowlist is not
  enforced, and WSL2 is the way to get OS-level containment there.
- SECURITY.md documents the temp-dir caveats: in-bounds dirs are shared and
  world-readable, the runtime's own unconditional write paths (`/tmp/claude`,
  `~/.npm/_logs`, `~/.claude/debug`, macOS `$TMPDIR`), and that narrowing is
  enforced on Linux, partial on macOS, policy-only on Windows.

## [2.2.1]

### Security
- **A newline inside a bash argument bypassed `ask`/`deny` bash policy.** The
  glob matcher compiled `*` to a regex `.*` without the dotAll flag, and `.`
  excludes `\n` in JavaScript - so any command whose joined `name args…`
  string spanned lines matched no `bash` pattern at all, not even `"*"`. In
  the sandboxed modes the per-token `path` layer still matched and contributed
  `allow`, so most-restrictive resolved to `allow`: `sudo sh -c "\nid\n"`
  skipped a `"sudo *": "deny"` rule, and in the shipped Default mode a
  multi-line argument turned `bash: {"*": "ask"}` into a silent run with no
  prompt. The OS sandbox still contained in-project writes, so this is a
  prompting/policy failure rather than a containment escape (see
  SECURITY.md, "Gating ≠ containment") - but `deny` is documented as a hard
  boundary and could be skipped with a single newline. Affected 2.0.0 to 2.2.0.
  The same miss made unsandboxed modes fall through to the `ask` fallback,
  so YOLO prompted on every heredoc or multi-line script. Fix: the matcher
  now uses the dotAll flag, so `*` and `?` span newlines and `"*"` is a true
  universal fallback for multi-line targets. Regression tests added at the
  matcher, resolver, and dispatcher levels.

  Reported by [dyoon98-creator](https://github.com/dyoon98-creator). Independently
  found and fixed earlier, as a wildcard bug, in
  [#5](https://github.com/wynainfo/pi-permission-modes/pull/5) by
  [@BeLeap](https://github.com/BeLeap) (dotAll flag) and in
  [#6](https://github.com/wynainfo/pi-permission-modes/pull/6) by
  [@hsiangron](https://github.com/hsiangron) (`[\s\S]` classes) - the security
  angle was not visible from those reports.

### Fixed
- **A bash command matched by no rule now falls back to `ask`, not `allow`.**
  In the sandboxed modes each command extracted from a chain is judged
  separately, and one that matched neither a `bash` pattern nor the `path`
  gate was treated as `allow` - while the file-tool resolver and the
  unsandboxed/heuristic bash path already fell back to `ask`. A sparse custom
  mode such as `"bash": { "git *": "allow" }` with no `"*"` rule therefore ran
  the commands it never mentioned silently. Both paths now share the same
  least-privilege default. The shipped modes all specify `"*"` and are
  unaffected; `decideBashChain` in `resolve.ts` holds the chain logic and its
  fallback, unit-tested.
- **Temp-dir paths no longer prompt as "outside project" (and no longer run
  unsandboxed on approval).** The bash escape detector and the file-tool
  project boundary knew nothing about the sandbox profile, so a path under
  the mode's own `allowWrite` - `/tmp` in every shipped sandboxed mode, plus
  the runtime's `/tmp/claude` where it points `TMPDIR` - prompted as an
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
  path - `sandbox-exec` denies the `.git/hooks`/`.git/config` paths in its
  profile instead. The guard is now Linux-only. Reported by
  [@pafuent](https://github.com/pafuent) in [#4](https://github.com/wynainfo/pi-permission-modes/issues/4).
- **The extension no longer enables every built-in tool.** Tool hiding
  rebuilt the active set from *all* registered tools minus `hideTools`, which
  silently re-enabled `grep`, `find`, `ls`, and `powershell` for everyone and
  overrode `defaultTools` in `settings.json`. It now starts from pi's current
  active set, remembers only what it hid, and restores only that on a mode
  switch - your own tool selection stays in force. Reported by
  [@sunzx](https://github.com/sunzx) in [#2](https://github.com/wynainfo/pi-permission-modes/issues/2).

## [2.2.0]

### Added
- **Blocked network hosts now ask instead of silently failing.** The sandbox
  proxy consults a live callback for any host outside the domain allowlist -
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
  apply instantly - the callback reads live session state, no sandbox
  re-init. "Allow forever" persists to the active mode's allowlist in the
  global config, computed against the stock+global base so a project's
  tightened list is never baked in.
- **`/net` command and `alt+n`**: `/net status | allow <domain…> | open |
  restrict | reset`; `alt+n` toggles filtering for the session. The footer
  now always shows the state and the shortcuts:
  `Build (sandboxed in project dir, alt+m)  Network: filtered (alt+n)` -
  green when filtered, orange when open.
- **Sandbox awareness in the system prompt.** Sandboxed modes now inject a
  factual `## Sandbox & permissions` section each turn, generated from the
  active mode's **merged** profile: writable paths, denied reads, the network
  allowlist, and how the prompt flow works (boundary-crossing commands are
  fine to issue - the user is asked automatically). Previously the model
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
  YOLO-class, this ran the next bash command unsandboxed with no confirmation -
  defeating the "opening an untrusted repo can't weaken your protection"
  guarantee. Affected 2.0.0 to 2.1.1. Two fixes: project-local tighten-only config
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
  harness drives the real registered handlers - prompt flows and blocks per
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
  prompt - "write a plan file, ask the user to press alt+m" - is not injected
  into a headless worker it would misdirect. The implicit fallback is also not
  re-exported via `PI_PERMISSION_MODE` as if it were an explicit choice;
  grandchildren derive the same safe fallback themselves. An explicitly
  forwarded or flagged mode behaves as before, prompt included.
- **The protected-path backstop now resolves symlinks.** `edit`/`write` targets
  are matched lexically AND on their canonical (symlink-resolved) path, so an
  in-project link pointing at `.git/`, `.env`, a shell rc file, etc. no longer
  smuggles a write past the backstop - this matters most in Build, where file
  tools don't prompt and aren't OS-sandboxed. In-project targets are judged
  root-relative, so a project that itself lives under a directory named
  `node_modules` (debugging a dependency in place) isn't spuriously
  write-blocked.
- **Privilege escalation is now detected through wrappers and shell `-c`
  scripts in the tree-sitter path.** `env PATH=/x sudo …`, `nice -n 10 sudo …`,
  `timeout 5 doas …`, `xargs sudo …` unwrap to their effective command head,
  and `sh|bash|… -c '<script>'` scripts are re-parsed recursively
  (depth-limited) so their inner commands are visible to privilege/escape
  detection *and* policy/path matching - closing the `bash -c 'sudo …'` gap the
  AST path had while the regex fallback (whole-string scan) caught it. As a
  bonus, the AST path no longer false-positives on mere mentions
  (`grep sudo README.md` is not "privilege escalation").
- **Bash session approvals now cover the whole chain, not just its first
  command.** A grant is keyed on every command name tree-sitter extracts, and a
  chain passes silently only when ALL of its names are already granted -
  "Allow `git` for session" no longer silently approves
  `git status && curl … | sh`. Approving a chain remembers each of its names;
  when no parse is available (heuristic fallback), the key is the exact command
  string.
- **The cross-cutting `path` gate now binds bash in the tree-sitter path.** Each
  extracted command is judged against the `path` patterns - the joined
  `name args…` string *and* every individual token - via `decideBashCommand`, so
  a rule like `"path": { "*.env": "deny" }` blocks `cat .env extra-arg` no matter
  where the target sits in the command. Previously the AST path only consulted
  the `bash` surface (the `path` gate applied to bash only in the regex
  fallback, and only against the whole command line), contradicting the
  documented "gate over ALL file access (incl. bash args)" semantics. Project
  tighten-only overlays fold in the same way.

## [2.0.0]

Declarative mode engine. Modes are now **data** - each a JSON bundle of a sandbox
profile and an allow/ask/deny policy - so they can be retuned and user-defined.

### Added
- **Declarative modes** in `permission-mode.json`: define your own modes (label,
  color, sandbox profile, per-surface policy, hidden tools) or retune the
  built-ins. JSON Schema at `schemas/permission-mode.schema.json`.
- **Stock defaults ship as data** - `permission-mode.defaults.json` (same format
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
- **Tool hiding** per mode (`hideTools`) - removes tools from the model before it
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
- **BREAKING - config format & path.** `sandbox.json` is replaced by
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
  `.mcp.json`, `.ripgreprc`, …) when those paths were absent - not just `.git`.
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
- Four switchable permission modes - **Default**, **Plan Mode**, **Build**,
  **YOLO** - cycled with `alt+m` or set via `/perm <mode>`; persisted per session.
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
