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
it started with, so an in-place mode switch does not touch it
([sandbox.md, How a profile reaches the runtime](sandbox.md#how-a-profile-reaches-the-runtime)).

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

Background shells end with the session: on quit, on switching or forking
the session, and on `/reload`. The sandbox they run in cannot survive a
runtime restart (a restart detaches a running sandbox's protections), so
nothing is left behind. A mode switch that needs such a restart asks you
first while shells run ([sandbox.md](sandbox.md#how-a-profile-reaches-the-runtime)).

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

## Limits

- The log file grows without a cap; `bash_output` caps what one read
  returns (64 KB) and says how much it skipped. The scratch directory is
  swept with the session's other files.
- The runtime keeps the last 100 violations in memory; the shell's own
  `violations.log` keeps every one that was seen.
- Port exposure (a server inside a shell reachable from this machine) is
  native on Windows and macOS and needs a relay on Linux; see the Linux
  section of [sandbox.md](sandbox.md#linux).
