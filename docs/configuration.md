# Configuration

Modes are data. Everything the extension does is driven by JSON files that
layer on top of each other.

## Files

| Layer | Path | Authority |
|---|---|---|
| Stock defaults | `permission-mode.defaults.json`, shipped with the extension | The baseline: the four built-in modes |
| Global config | `~/.pi/agent/permission-mode/permission-mode.json` | Full authority: redefine built-in modes, add modes, set `defaultMode` and `cycleOrder`, tune plan approval |
| Project config | `<project>/.pi/permission-mode.json` | Tighten-only: may only make an existing mode stricter |

The global path is stable and independent of where `pi install` placed the
extension. All three files share one format; the JSON schema is
`schemas/permission-mode.schema.json` (also published at
`https://raw.githubusercontent.com/wynainfo/pi-permission-modes/main/schemas/permission-mode.schema.json`,
usable as `$schema` for editor completion).

`/perm init` writes a full copy of the stock defaults to the global path, so
you can edit values in place. The file is an overlay: whatever it omits
follows the shipped defaults, so deleting values you never meant to change is
the simplest way back to stock behavior.

A missing or unparsable file is reported at session start and ignored; the
extension never runs without a configuration (a stock copy is embedded as the
last fallback).

## Top-level keys

| Key | Type | Meaning |
|---|---|---|
| `$schema` | string | Editor support; stripped before parsing |
| `$comment` | string | Free-form note. `/perm init` records the copy's provenance here |
| `acknowledgeDefaults` | string | Extension version whose defaults you reviewed this file against; silences outdated-default warnings until the shipped defaults change again. Global only |
| `defaultMode` | string | The mode a fresh session starts in (see [modes.md, Start mode](modes.md#start-mode)). Global only |
| `cycleOrder` | string[] | The `alt+m` cycle order and the display order. Global only |
| `modes` | object | Mode name to mode definition ([modes.md, Mode fields](modes.md#mode-fields)) |
| `plan` | object | Plan approval: `approveMode` (default `build`) and `approveMessage` (`{path}` is replaced by the plan path). Global only ([modes.md, Approving a plan](modes.md#approving-a-plan)) |
| `shells` | object | Background shells: `enabled` (default true), `maxConcurrent` (default 4), `notify` (`wake`, `note`, `none`; default `wake`). A project may only tighten ([shells.md](shells.md#configuration)) |

Each mode holds a `sandbox` block ([sandbox.md](sandbox.md)) and a
`permission` block ([permissions.md](permissions.md)).

## Layers

1. The stock defaults are loaded.
2. The global config is merged over them, mode by mode: a mode you redefine
   replaces the stock mode's fields you set and keeps the rest; a new mode is
   added as written.
3. The project config is applied as a tightening overlay (next section).

The merged result is what `/sandbox` prints and what the awareness section of
the system prompt describes.

## Project config

A `<project>/.pi/permission-mode.json` can only make things stricter, so
opening an untrusted repository can never weaken your protection. The rules,
as the loader enforces them (`src/config-load.ts`, `tightenSandbox` and
`applyProject`):

- It cannot add modes, change `defaultMode` or `cycleOrder`, or set `plan`.
- In `shells` it may turn shells off, lower `maxConcurrent`, or quiet
  `notify` (`wake` to `note` to `none`); anything looser is ignored with a
  warning.
  Each is ignored with a warning.
- Per mode, only `sandbox` and `permission` are read. `label`, `color`,
  `systemPrompt`, `hideTools`, `injectSandboxInfo`, and `bypassProtectedPaths`
  from a project are ignored.
- `sandbox.enabled` cannot change (neither off nor on). `writable` may be set
  to `false`, never back to `true`. `askOnBlockedHost` may be set to `false`,
  never to `true`.
- `allowWrite`, `allowRead`, and `insideRoots` are intersected with the base
  (a project can only remove writable roots, carve-outs, or inside roots). `denyRead` and `denyWrite` are
  unioned (a project can only add denies).
- `network.allowedDomains` is intersected with the base (a project can only
  narrow the allowlist; an overly broad pattern such as `*` is dropped with a
  warning). `network.deniedDomains` is unioned.
- `permission` is attached as a most-restrictive overlay: for every decision,
  the project's rule and the base rule are both resolved and the stricter
  action wins (`deny` over `ask` over `allow`). A project can add `ask` or
  `deny`, never loosen, whatever patterns it uses.
- Interactive grants are your authority: "Allow for session" and "Allow
  forever" can reach past a project's tightened rules, exactly like approving
  an out-of-project command. "Allow forever" writes to the global config
  against the stock+global base; a project's tightening is never baked in.

Warnings from the loader start with `permission-mode:` and name the file and
mode. They never stop the extension: an invalid value fails safe (an unknown
action becomes `deny`, an unknown key is dropped).

## Keeping your global config current

`/perm init` copies every value, so a later change to the stock defaults
(2.3.0 narrowed `allowWrite` from `/tmp` to `/tmp/pi`, for example) does not
reach a copy that still carries the old value. Two safeguards cover that:

- **Outdated-default warnings at session start.** Each value in your global
  file is compared with the current default and with every older default
  shipped since 2.0.0 (`defaults-history.json`, clear-text copies with their
  version ranges). A value equal to the current default is fine; one that
  differs from it but equals an older default is reported by field, with
  both values and the versions it belonged to; one that equals no default is
  your customization and stays silent. Custom modes never trigger it.
- **A one-time notice after an upgrade.** When the extension version changes
  and the stock defaults changed between the two versions, users with a
  global config are told which fields changed. The last version seen is kept
  in `~/.pi/agent/permission-mode/state.json`.

To keep an outdated value knowingly, set `"acknowledgeDefaults": "<version>"`
(the version whose defaults you reviewed against). The warnings stay silent
until the shipped defaults change again.

## Environment variables

| Variable | Effect |
|---|---|
| `PI_PERMISSION_MODE` | Exported by the extension with the current mode so child pi processes (subagents) adopt it. Read at startup only when no flag or session entry applies |
| `PI_PERMISSION_TMPDIR` | Overrides the scratch directory base (default `/tmp/pi`; see [sandbox.md, Scratch directory](sandbox.md#scratch-directory)) |
| `TMPDIR` | Set inside every bash run to the session's scratch directory |

## Shape

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/wynainfo/pi-permission-modes/main/schemas/permission-mode.schema.json",
  "defaultMode": "default",
  "cycleOrder": ["default", "plan", "build", "yolo"],
  "plan": { "approveMode": "build" },
  "modes": {
    "default": {                        // values here are illustrative - run /perm init for the real defaults
      "label": "Default",
      "color": "muted",                 // muted | mdLink | accent | error
      "systemPrompt": "@plan",          // optional; "@plan" = the dated Plan-mode prompt
      "injectSandboxInfo": true,        // the sandbox boundaries go into the system prompt (default true)
      "sandbox": {
        "enabled": true,                // false = bash runs unsandboxed (YOLO-style)
        "writable": true,               // false = bash runs read-only (Plan-style)
        "allowWrite": [".", "/tmp/pi"],
        "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg"],
        "allowRead": [],                // readable again inside denyRead (strict home)
        "denyWrite": [],
        "network": { "allowedDomains": ["github.com", "*.github.com"], "deniedDomains": [] },
        "askOnBlockedHost": true        // live prompt for hosts outside the allowlist (false = silent deny)
      },
      "permission": {
        "path": { "*": "allow", "*.env": "deny" },  // cross-cutting gate (deny overrides per-tool allow)
        "external_directory": "ask",                // the out-of-project boundary
        "read": "allow", "grep": "allow", "find": "allow", "ls": "allow",
        "write": "ask", "edit": "ask",
        "bash": { "*": "ask", "sudo*": "deny" },    // matched per command (name + args)
        "web_search": "ask",
        "tool": "allow",                            // any non-builtin/extension tool, by name
        "skill": "allow"                            // skills, by name
      },
      "hideTools": []                               // tools removed from the model in this mode
    }
  }
}
```
