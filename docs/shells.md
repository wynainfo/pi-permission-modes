# Background shells

A bash call runs inside a sandbox that is torn down when the command exits,
so `&`, `nohup` and `setsid` cannot start anything that outlives the call.
A background shell is the way to run a dev server, a watcher, a long build
or a monitor: the model calls bash with `run_in_background: true`, the
command runs as its own process tree under the same sandbox, the same policy
gate and the same prompts as a foreground call, its output goes to a log
file, and the model reads and stops it with two tools. You see and control
every shell with `/shells`.

## Starting one

`bash { command, timeout?, run_in_background: true }`. Before it starts, the
call goes through the usual decision: Default mode asks ("Run in background?"
with the command), a rule or a "Deny and block" refuses, a session grant
covers the same names as for a foreground call. An approved escape (a path
outside the project, `sudo`) runs the shell unsandboxed, as it does for
bash. `timeout` is the shell's kill timer in seconds (none by default).

The call returns within half a second: the shell's id and log path, or the
exit code when the command already ended (a typo, a missing program). The
shell keeps running while the model works on; each shell holds the sandbox
it started with, so an in-place mode switch does not touch it, and a switch
that restarts the runtime asks first ([Lifetime](#lifetime)).

Refused, always with a sentence and never as a silent foreground run: shells
disabled in the config, the concurrency limit reached.

## Reading and stopping

- `bash_output { bash_id, filter?, wait_seconds?, from_byte? }`: the status
  line (running for, exited with, killed by) and the output written since the
  last read; the first read returns the last 200 lines. `wait_seconds` blocks
  until new output arrives or the shell ends (at most 60 s), for "wait until
  the server says it listens". `filter` keeps matching lines only. Sandbox
  violations of the shell (a refused write, a denied host) are appended,
  with the usual hint for a host you could allow.
- `kill_shell { shell_id, signal?, grace_seconds? }`: the model chooses the
  signal (`TERM` by default, `INT` for programs that handle Ctrl-C, `HUP`,
  `KILL`) and the grace period after which SIGKILL follows (10 s by default,
  0 for none). The signal goes to the whole process group. On Windows there
  is no graceful signal: the process tree is ended by force, so a program
  that must shut down cleanly there is better told to through its own means
  (an endpoint, a quit command) before `kill_shell`.

## Completion notice

When a shell ends by itself (exit or timeout) the model is told, per
`shells.notify`: `wake` (default) starts a turn of its own when the agent is
idle, or follows the current one; `note` waits in the context for your next
prompt; `none` leaves it to `bash_output`. A shell you or the model stopped
sends no notice. The notice names the shell, its exit code, its runtime and
the last ten lines of output.

## `/shells`

| Command | What it does |
|---|---|
| `/shells` | List: id, status, runtime, command, log path |
| `/shells stop <id|all> [signal]` | Stop one or every shell (`TERM` by default) |
| `/shells logs <id> [lines]` | Print the last lines of a shell's log |
| `/shells clean` | Remove the folders of finished shells |

The footer shows `Shells: N` while any shell runs. Each shell keeps its
files under the session's scratch directory
([sandbox.md, Scratch directory](sandbox.md#scratch-directory)):
`shells/<id>/output.log`, `violations.log`, `meta.json`. A resumed session
lists the shells of the earlier process as ended; nothing is re-attached.

## Lifetime

Background shells end with the session: on quit, and when the session is
replaced (`/new`, `/resume`, `/fork`). The sandbox they run in cannot
survive a runtime restart (a restart detaches a running sandbox's
protections), so nothing is left behind, and the records show
`killed (session ended)` when the session is resumed later.

A mode switch is applied in place where the runtime allows it, and a shell
keeps the sandbox it started with. A switch that needs a runtime restart
(on Windows every change of the runtime profile, so Default to Plan Mode
asks while Default to Build, whose stock profiles are the same there, does
not; elsewhere one between a mode with a network allowlist and one without,
see [sandbox.md](sandbox.md#how-a-profile-reaches-the-runtime)) asks you
first while shells run. A switch to an unsandboxed mode (YOLO) restarts
nothing and leaves them running under their sandbox. No keeps the mode and the shells; Yes stops them (status
`stopped (sandbox profile changed)`, the model is told in its next turn)
and switches. The same question precedes `/sandbox install` on Windows.
Headless, the shells are stopped without asking.

`/reload` keeps running shells: the new extension instance takes them over
with the runtime they run under, and `/shells` lists them as before. When
the reload picked up a changed configuration whose profile would need a
restart, the shells' profile stays in force for every command until the
last of them ends; the footer says `(sandbox profile pending: N shell(s))`,
`/sandbox` names it, and `/shells stop all` applies the new profile at once.

## Configuration

```jsonc
"shells": { "enabled": true, "maxConcurrent": 4, "notify": "wake" }
```

Global config only; a project may turn shells off, lower `maxConcurrent`,
or quiet `notify` (`wake` to `note` to `none`), never the reverse.

## Network

A background shell's network is the mode's allowlist plus the session
grants at the moment it starts, through the same proxy: a host outside it
prompts you live, exactly as for a foreground command, and a grant covers
both. A later in-place switch to a mode with a narrower allowlist leaves the
shell's network as launched; a switch to a wider one widens it too.

### Reaching a server in a shell: `expose`

On macOS and Windows a server a background shell starts is reachable from
this machine as it binds (with `sandbox.allowLocalBinding` on, the default;
[sandbox.md, Local binding](sandbox.md#local-binding)). On Linux it is not:
the sandbox has a network namespace with a loopback of its own. Bash's
`expose` parameter (with `run_in_background: true`) relays ports into it:

```jsonc
{ "command": "npm run dev", "run_in_background": true, "expose": [5173] }
{ "command": "python3 -m http.server 8123", "run_in_background": true, "expose": ["0.0.0.0:8123"] }
```

An integer `N` listens on `127.0.0.1:N` of this machine and relays each
connection to port `N` inside the shell (where the server should bind
`127.0.0.1`); `"host:port"` listens on that address instead, `"0.0.0.0:N"`
on every interface. A non-loopback address asks you once per port and
session ("Expose on the network"); a headless session cannot ask and
refuses it. The listeners live as long as the shell; a port in use on this
machine, or a relay that does not start, refuses the start with a sentence
and nothing keeps running. `/shells` shows the exposed addresses. On the
other platforms `expose` is accepted and checked, and the result says the
server is reachable directly (on macOS with local binding off, the start is
refused: nothing could listen).

The agent's own commands reach an exposed port too. A foreground command
on Linux has a loopback of its own as well, so while any running shell
exposes ports, every sandboxed command starts with a small listener inside
on those ports; a connection to `127.0.0.1:8123` from the command (`curl`,
a test runner, a browser automation) is handed out of the command and into
the shell that owns the port. Nothing is granted and nothing needs revoking:
the listener lives and dies with the command and is only started for ports
whose shell is running at that moment, so when the shell ends, the next
command finds the port closed again ("connection refused", no prompt).
While a shell exposes a port, that port is taken inside foreground
commands; a second server on it there fails with "address in use". The
start costs node's startup inside the sandbox, about a tenth of a second
per command, only while something is exposed.

How the relay works, and why it is temporary: the sandbox's seccomp filter
blocks the creation of Unix sockets but not their use, so the shell is
started with a node IPC channel on fd 3 that bwrap passes through. A line
in front of the command starts a small relay on the node that runs pi
(`relay.cjs` next to the shell's log; the fd and the variables are gone for
the command itself), which holds the channel and dials `127.0.0.1:<port>`
for each connection the host hands it. The inbound direction is the same
channel the other way round: a foreground command's listener
(`inbound.cjs`, written once per session under the scratch directory) hands
each accepted connection to pi over the command's own channel, and pi pipes
it into a connection to the shell's exposed address on this machine, the
path a browser takes. The node binary's directory is readable
inside the sandbox for that, even under a strict home. All of this
disappears once the runtime relays ports itself (requested upstream in
[anthropics/sandbox-runtime#784](https://github.com/anthropics/sandbox-runtime/issues/784));
the `expose` parameter stays as it is.

## Limits

- The log file grows without a cap; `bash_output` caps what one read
  returns (64 KB) and says how much it skipped. The scratch directory is
  swept with the session's other files.
- The runtime keeps the last 100 violations in memory; the shell's own
  `violations.log` keeps every one that was seen.
- Port exposure (a server inside a shell reachable from this machine) is
  native on Windows and macOS and needs a relay on Linux; see the Linux
  section of [sandbox.md](sandbox.md#linux).
