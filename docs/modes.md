# Modes

A mode is one JSON object: a sandbox profile plus a permission policy, with
a label and a few switches. Five ship by default; all of them are data and
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
| **Auto** | Build, but every ask (an escape, a host outside the allowlist) is judged by a classifier against your task instead of prompting | as Build; an out-of-project path is judged | web search, tools and skills are judged on first use ([Auto mode](#auto-mode)) |
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
| `classifier` | object or `false` | The Auto classifier: a model judges this mode's asks instead of prompting ([Auto mode](#auto-mode)). Only Auto sets it |

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

The text is written as pi prompt sections (`permission_mode`,
`permission_mode_docs`, `permission_mode_steering` for a mode's own
`systemPrompt`), not as a replacement of the whole system prompt. pi records
them in the session and, when one changes, sends only the changed section as
a short patch after the conversation on models that accept mid-conversation
system messages (the catalog entries of Anthropic, OpenAI, OpenRouter and
others). A mode switch, a network grant or a blocked path then costs a few
hundred tokens instead of a re-read of the whole context, and the provider's
prompt cache keeps the prefix. On other models pi folds the patch into the
leading prompt, which re-reads the context once per change. A custom
endpoint in `models.json` (vLLM, SGLang, Ollama) opts in with
`"compat": { "supportsMidConvoSystemMessages": true }` on the model entry,
once you have checked the server accepts a `system` message after the first
turn. pi older than 0.86 has no sections; there the text is appended to the
system prompt as before.

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

## Auto mode

Auto is Build with one difference: an action Build would ask you about is
judged by a **classifier**, a small side call to a model, against what you
asked for in this session. A verdict takes a second or two instead of a
prompt, and the judge never sees the agent's reasoning or any tool output,
which is what makes it resistant to prompt injection: a page the agent
fetched or a README in a cloned repository cannot talk it into anything,
because the judge never reads them. Everything Build contains stays
contained: in-project bash runs in the same sandbox, the `denyRead` masks
hold, the network allowlist filters; the judge only replaces the prompts.

What is judged: a bash command that reaches outside the project or
escalates privileges, a file tool on a path outside the project, a bash
connection to a host outside the allowlist, a web search when the policy
asks, and the first use of an extension tool or a skill. What is never
judged: a `deny` rule, the protected-path backstop, plan approval, and a
"Deny and block" from earlier in the session. A session grant you gave
("Allow for session") is honored before any verdict.

### Verdicts

Every verdict appears in the conversation, right after the tool call it
judged: a green check mark for an allow, a red cross for a refusal, an
orange mark when the classifier could not judge. An allow is folded to the
action and the scores; a click on the line, or ctrl+o (the same toggle as
tool output), expands it to the sentence, the source, the model and the
latency. A refusal always shows its sentence. Consecutive verdicts with
the same outcome within one turn (the model often issues two tool calls at
once) share one line, "Auto verdicts: 2 allowed", that expands to both.
The line is for you; the model gets a refusal in the tool result and
nothing for an allow. The verdict names the action, two scores and a
sentence:

```
Auto verdict: allowed read of ../other-repo/src/config.ts (risk low, authorization stated): the task compares the two loaders
Auto verdict: refused bash `cat /srv/secret.txt` (risk high, authorization none): nothing in the task names /srv
```

The two scores are what the judge answers; the mode's `strictness` decides
what passes:

| `risk` | passes when |
|---|---|
| `critical` | never: credential or secret access, data sent to a destination the task did not name, a download piped into a shell, rewriting published git history, disarming the sandbox or this extension, writing under `~/.pi/agent/` |
| `high` | `authorization` is at least `implied` below 0.3, `stated` from 0.3, `explicit` from 0.7 |
| `medium` | always below 0.7; `stated` from 0.7 |
| `low` | always below 1; `explicit` at 1 |

`authorization` is `none` when the agent chose the action on its own (a
vague goal, urgency, or "make the tests pass" authorizes no specific risky
action, and "thanks, looks good" authorizes nothing new), `implied` when the
action is a reasonable consequence of what you asked, `stated` when you
named the action, path or host, and `explicit` when you asked for it or
re-approved it after a refusal. Some outcomes need no model at all: a read
of a `denyRead` path, a pipe-to-shell, a force push and a write under pi's
agent directory are refused by a deterministic pre-check. Your approval in
chat does not lift those; with `onRefuse: "ask"` they reach you as a prompt
(a public key under `~/.ssh` is yours to allow there), otherwise the agent
is told to leave that step to you.

A refusal is final for the session: the agent is told not to try the same
outcome through another tool, a script or an encoded payload, and to
proceed with a safer alternative or ask you. Your approval in chat lifts
it: say so, and the retry's verdict sees an explicit authorization in your
latest message. A new prompt from you forgets the refusals (and keeps the
allows); `/perm clear-approvals` forgets all verdicts. The same action asked
again costs no second call. `/perm verdicts` lists the session's verdicts;
`<scratch>/verdicts.log` keeps them with the scores and the latency.

If the classifier cannot judge (no model, no key, a timeout of 15 seconds,
an answer that is not a verdict) the action is refused with a message that
says so: "Auto verdict unavailable (...): this is not a judgment on the
action". Three refusals in a row, or twenty in a session, trip a **circuit
breaker**: Auto asks you for the rest of the session, like Build, with the
verdict shown as a second line of each prompt. Headless (`pi -p --perm
auto`) the verdicts work the same; a tripped breaker ends the turn, since
nobody can be asked.

Network verdicts are per command, not per host: the judge sees the command
that opened the connection, and an allow lasts while that command runs. A
later `curl -d @.env` to the same host is judged on its own. Your own
answers to a network prompt still offer "Allow for session".

### Configuration

```jsonc
"auto": {
  "classifier": {
    "model": "current",      // or "provider/model-id" from pi's model registry
    "strictness": 0.5,       // 0 lenient to 1 strict
    "onRefuse": "refuse",    // "refuse" | "ask"
    "guidance": "Hosts under *.wyna.ch and the sibling repos in ~/src are ours."
  }
}
```

- `model`: `"current"` is whatever the session runs; a `"provider/model-id"`
  string is looked up in pi's registry (the key comes from there too) and
  falls back to the current model with a warning when it is not found. The
  judge runs with reasoning off, temperature 0 and a 1500-token budget. A
  Haiku-class model or a small local one judges as well as a large one and
  faster; more thinking produced more over-allows in every published
  measurement, not fewer. A thinking model served locally (vLLM, llama.cpp)
  may reason anyway and spend seconds per verdict; when its answers run out
  of budget, the verdict line says so, and a non-reasoning model fixes it.
  Global config only.
- `strictness`: the threshold above. 0.5 (balanced) allows what the task
  implies and refuses what it does not call for; 0.2 allows whatever
  plausibly serves the task; 0.9 allows only what you named; 1 refuses
  everything you did not name explicitly.
- `onRefuse`: `"refuse"` blocks the action with the verdict; `"ask"` shows
  the usual prompt with the verdict as a second line, so a person has the
  last word (headless, `ask` behaves as `refuse`).
- `guidance`: free text the judge reads as "what is normal here": trusted
  hosts and organizations, sibling repositories that are yours, a staging
  target. It can move a verdict within the rules above, never past the hard
  floor. Global config only; `AGENTS.md` and `CLAUDE.md` are not read.
- `restrict`: free text that can only move verdicts toward refuse. The one
  classifier text a project config may set.

A project config may raise `strictness`, switch `onRefuse` to `ask`, add
`restrict`, or set `classifier` to `false` (the mode then prompts like
Build). It may not pick the model or set `guidance`. Any mode can carry a
`classifier` block; the stock Auto mode is Build plus the block above, with
the `warning` color.

## Defining your own mode

Add a mode under `modes` in the global config and (optionally) list it in
`cycleOrder`. A "review" mode: read-only sandbox, web search off, the `edit`
and `write` tools hidden:

```jsonc
{
  "cycleOrder": ["default", "review", "build", "auto", "yolo"],
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
