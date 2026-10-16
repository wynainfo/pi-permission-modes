# Modes

A mode is one JSON object: a sandbox profile plus a permission policy, with
a label and a few switches. Four ship by default; all of them are data and
can be retuned or replaced in the global config
([configuration.md](configuration.md)).

## Stock modes

Cycle with `alt+m` (in `cycleOrder`) or switch with `/perm <mode>`. The
footer shows the mode, the network state, and their shortcuts, for example
`Build (sandboxed in project dir, alt+m)  Network: filtered (alt+n)`.

| Mode | Bash | File tools | Other |
|---|---|---|---|
| **Default** | `ask` for every command; approved in-project commands run sandboxed | reads free; `write` and `edit` ask | `web_search`, tools, and skills ask on first use |
| **Plan Mode** | `allow`, but the sandbox is read-only, so only read commands work | reads free; only Markdown (`*.md`, `*.markdown`) may be written or edited | the `@plan` system prompt steers the model to write a plan file and render it with `show_plan`; tools and skills ask |
| **Build** | `allow`, sandboxed | all allowed inside the project | everything allowed |
| **YOLO** | unsandboxed, never prompts | no protected-path backstop | can do anything the current user can |

In every mode except YOLO:

- out-of-project access prompts (`external_directory: ask`);
- bash that reaches outside the project or escalates privileges
  (`su`, `sudo`, `doas`, `pkexec`, `runuser`, `setpriv`, `chroot`, detected
  through wrappers like `env`, `nice`, `xargs` and inside `bash -c '...'`)
  prompts and runs unsandboxed once you approve it;
- `edit` and `write` to protected paths are hard-blocked
  ([permissions.md, Protected paths](permissions.md#protected-paths));
- the sandbox-writable directories (`allowWrite`, the session's scratch
  directory, the runtime's `/tmp/claude`) count as in-bounds: a temp file
  there is not an escape.

All sandboxed modes share the same `denyRead` list (credential files and pi's
own `auth.json` and `oauth.json`) and the same network allowlist (package
registries and GitHub). See `permission-mode.defaults.json` for the exact
values; the README's table is the summary.

## Mode fields

| Field | Type | Meaning |
|---|---|---|
| `label` | string | Footer label |
| `color` | `muted`, `mdLink`, `accent`, `error` | Footer label color |
| `systemPrompt` | string | Appended to the system prompt while the mode is active. The sentinel `"@plan"` resolves to the dated Plan-mode prompt |
| `injectSandboxInfo` | boolean (default true) | Inject the mode's sandbox boundaries into the system prompt each turn. Unsandboxed modes never inject |
| `sandbox` | object | The OS sandbox profile ([sandbox.md](sandbox.md)) |
| `permission` | object | The allow / ask / deny policy ([permissions.md](permissions.md)) |
| `hideTools` | string[] | Tools removed from the model in this mode ([permissions.md, Hiding tools](permissions.md#hiding-tools)) |
| `bypassProtectedPaths` | boolean | Skip the protected-path write backstop. Only YOLO sets it |

A mode must have `sandbox.enabled` and `sandbox.writable` and a `permission`
block; the loader warns about an incomplete mode and fills the gaps with
safe values.

## Start mode

Which mode pi starts in, in order:

1. the `--perm <mode>` flag;
2. the mode a resumed session was last used in (a `perm-mode` session entry);
3. a mode forwarded by a parent pi in `PI_PERMISSION_MODE`;
4. `defaultMode` from the global config.

`/new`, `/resume`, `/fork`, and `/reload` keep the mode you are in, and
record it in the session they move to, so `pi -c` later restores it. A
headless child (`pi -p`, a subagent) with none of the above starts in the
most restrictive sandboxed mode, never YOLO, and without the mode's
`systemPrompt`.

The mode is persisted per session and shown in the footer.

## Sandbox awareness in the system prompt

While a sandboxed mode is active, a `## Sandbox & permissions` section is
added to the system prompt each turn: the writable paths, the denied reads
(including this session's blocks), the network allowlist with session grants,
the scratch directory, and how the prompt flow works. The model then picks
paths and hosts that work, and knows a boundary-crossing command is fine to
issue because you will be asked. When the sandbox is degraded, the section
says so and points at the confirmation prompts instead. Every mode also gets
a short pointer to this documentation. Opt a mode out of the boundary section
with `"injectSandboxInfo": false`.

## Approving a plan

When a run in Plan Mode (any mode whose `systemPrompt` is `"@plan"`) has
rendered a plan with `show_plan`, applying it is one action. As soon as the
model's handoff line is on screen, a prompt appears:

```
Plan ready: plan/2026-09-24_feature.md
  > Accept: switch to Build and implement it
    Decline: keep refining in Plan Mode
```

- **Accept** switches to the approve mode (`plan.approveMode`, Build by
  default) and sends a real user message (`plan.approveMessage`, with
  `{path}` replaced), so the implementing turn starts under Build's system
  prompt. The message is visible in the transcript.
- Approval covers what you saw: if the plan file changes after it was shown,
  approving is refused until the model shows it again.
- **Decline** (or Esc) costs nothing. The plan stays pending and is not
  offered again until the next `show_plan`.
- Switching into the approve mode by hand (`alt+m`, `/perm build`) while a
  plan is pending asks `Implement plan/... now?`; No leaves you in Build
  with nothing sent.
- `/plan approve` switches and sends without asking; `/plan status` names
  the pending plan.

The pending plan survives `/reload`, resume, and branch navigation. Headless
sessions get no prompts and no automatic switch. A `show_plan` in any other
mode only displays the file. If `approveMode` names a mode that does not
exist, approval is off with a one-time warning.

## Defining your own mode

Add a mode under `modes` in the global config and (optionally) list it in
`cycleOrder`. A "review" mode: read-only sandbox, web search off, the `edit`
and `write` tools hidden:

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

A mode that reuses the stock `denyRead` and network lists has to repeat them
(there is no shared section yet); copy them from `permission-mode.defaults.json`.

## Strict home

Reads outside the project are deny-listed, not allow-listed: the sandbox
blocks only `denyRead` and lets everything else under `~` be read so
toolchains work. `allowRead` turns that around for a mode: deny the whole home
directory, then re-open only what the toolchain needs. Paste into a mode's
`sandbox` and trim the list:

```jsonc
"denyRead": ["~"],
"allowRead": [".", "/tmp/pi", "~/.gitconfig",
              "~/.cache", "~/.config", "~/.local", "~/.npm", "~/.nvm",
              "~/.cargo", "~/.rustup", "~/go", "~/.pyenv", "~/.gem"]
```

- Keep `.` in the list: a read-only mode (Plan) does not re-expose the
  project through `allowWrite`, and without it the project itself reads as
  empty.
- Keep `~/.gitconfig`, or every `git commit` inside the sandbox fails with
  "Author identity unknown" (the sandbox reports the file as absent, not as
  denied).
- The extension re-opens its own runtime directory automatically (the
  sandbox's seccomp helper lives there). The interpreter that runs pi does
  not need to be listed, only what the agent's commands execute (`~/.nvm`,
  `~/.cargo`, a venv outside the project).
- Everything under `~` that is not listed reads as absent inside bash (Linux
  mounts an empty directory over it; no error, no prompt), so a tool that
  needs a home path you left out fails silently. `/sandbox` shows the lists,
  and the awareness section tells the model what is masked.
- `~/.config` and `~/.local` are where most CLIs keep both their settings and
  their tokens; leave them out only if the agent never needs those tools.
- A more specific `denyRead` or a session block inside a carve-out still
  wins. A project config may remove carve-outs, never add them.
- `~/.pi/agent/auth.json` in the default `denyRead` means a `pi` started from
  inside sandboxed bash cannot authenticate; remove it if you spawn nested pi
  sessions that way.
