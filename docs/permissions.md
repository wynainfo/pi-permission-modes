# Permissions

The policy engine decides, for every tool call, whether it passes, prompts,
or is blocked. It is the prompting layer; containment is the OS sandbox
([sandbox.md](sandbox.md)). SECURITY.md spells out the difference.

## Surfaces

A mode's `permission` block has one entry per surface:

| Surface | What it gates | Target matched against the patterns |
|---|---|---|
| `bash` | the bash tool | each command extracted from the line: name plus arguments |
| `read`, `grep`, `find`, `ls` | the read-only file tools | the path argument |
| `write`, `edit` | the mutating file tools | the path argument |
| `path` | a cross-cutting gate over all file access, including bash path tokens | the path (and for bash, the joined command and each token) |
| `external_directory` | the project boundary: any file access outside the project | the path |
| `web_search` | the web search tool | the query |
| `tool` | any non-builtin tool (extensions, MCP-as-tool) | the tool name |
| `skill` | skills, at `/skill:<name>` | the skill name |

## Actions

`allow` passes, `ask` prompts, `deny` blocks. A surface value is either a
single action or a pattern map, `{ "<glob>": <action> }`.

## Pattern syntax

- `*` matches any run of characters, including `/` and newlines, so `*.md`
  matches nested paths and `"*"` is the catch-all.
- A whole `**/` segment (at the start of a pattern or after a `/`) matches
  zero or more directories: `**/.env` also matches a bare `.env`, and
  `a/**/b` matches `a/b`. Two stars inside a name keep the `*` meaning.
- `?` matches exactly one character.
- `~` and `$HOME` expand on both the pattern and the target.
- Regex metacharacters in a pattern are literal.
- Keys are matched in file order, and the last matching pattern wins, so put
  `"*"` first as the default. Do not use bare numbers as keys: JavaScript
  reorders them to the front of the map (the loader warns).

## Resolution

Every decision is the most restrictive of all layers that apply
(`deny` over `ask` over `allow`):

1. the surface's own rule (`read`, `bash`, ...);
2. the `path` gate, for file surfaces and for bash;
3. the `external_directory` gate, when the target lies outside the project;
4. the project config's overlay, resolved the same way and composed in.

A surface with no matching rule at all falls back to `ask`.

The boundary has read-only exceptions for the reference material the system
prompt points at: the mode's sandbox-writable directories, this extension's
shipped `docs/`, and pi's own docs, examples and README (pi names them by
absolute path in its prompt). Reading them is not an out-of-project access
and does not prompt; writing to them still does.

## Bash

The command line is parsed with tree-sitter into a real AST. Every command it
contains, including ones nested in `$(...)`, backticks, subshells, and
`sh|bash -c '...'` scripts (re-parsed recursively), is judged separately
against the `bash` patterns and the `path` gate, against the joined command
and each token, so `"path": { "*.env": "deny" }` blocks `cat .env` wherever
the target appears. The chain's decision is the most restrictive of its
commands. Aliases are considered too: `"sudo*": "deny"` catches
`/usr/bin/sudo id` and `time sudo id`.

Independently of the policy, the analysis detects escapes: a path outside
the project (and outside the sandbox-writable roots and the mode's
`sandbox.insideRoots`, [sandbox.md, Inside roots](sandbox.md#inside-roots)),
or privilege escalation. An escape always prompts, and an approved escape runs
unsandboxed, since you authorized it. The gate then composes with the
sandbox state:

| Policy | Sandbox | Result |
|---|---|---|
| `deny` | any | blocked: "bash command denied by policy" |
| `allow`, in project | ready | runs sandboxed, no prompt |
| `ask`, in project | ready | prompts "Allow bash?", runs sandboxed |
| any, escape | ready | prompts "Allow bash? (path outside project ...)", runs unsandboxed |
| `allow` or `ask`, in project | unavailable | prompts "Allow bash? (sandbox unavailable)", runs unsandboxed |
| `ask` | disabled for the mode | prompts "Allow bash? (sandbox disabled; ...)" |

Every bash prompt ends with the command it is about, on one line and cut at
80 characters. A mode with `sandbox.enabled: false` judges the same
per-command chain; only the escape detection is skipped, since there is no
sandbox to escape from. When you refuse a prompt, the model is told that the
user denied the call and not to retry or rephrase it; a rule reason, if the
matching rule has one, replaces that text.

If the tree-sitter grammar cannot load, a token-scan heuristic stands in; it
is not a shell parser (SECURITY.md lists what it misses). A bare filename that
is a symlink out of the project is resolved and treated as an escape; names
after a `cd` or behind a glob are judged as written. An in-project symlink to
an executable outside the project (a venv's `bin/python`) is not an escape.

## File tools

`read`, `grep`, `find`, `ls`, `edit`, and `write` are governed by the policy
engine and the path checks, not by the sandbox. Each call resolves its
surface, the `path` gate, and the project boundary, then:

- `deny` blocks with `Path "<p>" is blocked by <mode>`; in a read-only mode
  (`sandbox.writable: false`) a denied `edit` or `write` says
  `<mode> allows editing Markdown files only`;
- `ask` prompts: `Allow read? (<p>)`, or `Outside project - allow read?
  (<p>)` for a path beyond the boundary, which also offers "Deny and
  block";
- a path blocked for the session is refused without a prompt.

Paths are normalized the way pi's own tools open them (`~` expansion, a
leading `@` stripped, `file://` URLs), so the guard judges the same file pi
opens. Symlinks are followed.

## Protected paths

Unless a mode sets `bypassProtectedPaths` (only YOLO does), `edit` and
`write` to protected paths are hard-blocked (`Path "<p>" is protected`)
before any policy rule runs. The set mirrors the sandbox runtime's mandatory
denies: the directories `.git`, `node_modules`, `.vscode`, `.idea` anywhere in
a path; `.env` and `.env.*`; `.claude/commands` and `.claude/agents`; and the
dotfiles `.gitconfig`, `.gitmodules`, `.npmrc`, `.bashrc`, `.bash_profile`,
`.zshrc`, `.zprofile`, `.profile`, `.ripgreprc`, `.envrc`. Matching is by
path segment, case-insensitively, on both the literal target and its
symlink-resolved canonical path, so a link cannot smuggle a write past the
backstop. This matters most in Build, where the file tools do not prompt.

## Rule reasons

A pattern entry can carry a reason that explains the block and says what to
do instead:

```jsonc
"bash": {
  "*": "allow",
  "grep *": { "action": "deny", "reason": "Use the grep tool instead of grep in bash; pipes like cmd | grep are fine" }
}
```

- The bare `"pattern": "deny"` form keeps working and produces the generic
  message. `{ "action": ..., "reason": ... }` is accepted on every surface;
  the reason is trimmed and capped at 500 characters.
- On a `deny` rule the reason replaces the generic block message. On an
  `ask` rule it is used only when the prompt is refused, or auto-refused in
  a headless session; an approval just proceeds and the reason is never
  shown.
- The reason travels with the winning rule (last match wins within a
  surface, most restrictive across layers; on a tie the more specific layer's
  reason wins). It never changes the decision.
- Prompts caused by an escape or an unavailable sandbox report their own
  cause, and Plan mode's "Markdown files only" message keeps priority over a
  pattern reason.
- Only the global config may set reasons. A project config's reasons are
  dropped with a warning: a reason is text put in front of the model, and a
  cloned repository must not get that power.

## Session approvals

When a mode asks, the prompt offers **Allow once / Allow for session / Deny**
(plus **Allow forever** for tools and skills). "Allow for session" remembers
that action per mode for the rest of the session. For bash the grant is keyed
on the command names extracted from the chain, and every name must already be
granted for a command to pass silently: approving `git` does not cover a
later `git status && curl ... | sh`; approving that chain grants `git` and
`curl`. An approved escape is keyed on the exact command string, so a grant
earned by `cat README.md` never lets `cat ~/.ssh/id_rsa` through. Clear the
grants with `/perm clear-approvals`.

Session grants are user authority: they can reach past a project config's
tightened rules.

## Deny and block

A prompt for an out-of-project path (bash or a file tool) offers a fourth
option, **Deny and block `<path>` for this session**. Plain Deny refuses that
one call; the agent may try another way, and reads outside the project are
not contained by the sandbox, so a script that opens the file would succeed.
Deny and block adds the path to the session's block list: every sandboxed
command from then on carries it as extra `denyRead` (Linux masks a file with
`/dev/null`, macOS returns a permission error), the file tools refuse it
without a prompt, and the awareness section lists the block so the model
stops probing.

Only the exact file or directory named is blocked, never the home directory,
a system root, or an ancestor of the project or of a writable root; when a
path cannot be blocked safely the option is not offered. A block is by path:
a hardlink or an earlier copy elsewhere is not covered. `/perm blocks` lists
the session's blocks, `/perm unblock <path>` lifts one, `/perm
clear-approvals` clears them with the grants.

## Tools and skills

Any non-builtin tool (an extension's tool, MCP-as-tool in a host that adds
them) is gated by name on the `tool` surface; skills on the `skill` surface at
`/skill:<name>`. In Default and Plan a tool or skill with no rule yet prompts
on first use: Allow once / Allow this session / Allow forever / Deny. "Allow
forever" persists `<mode>.permission.<tool|skill>.<name>: "allow"` to the
global config. Build and YOLO allow all tools and skills. Set a mode's `tool`
or `skill` to `"allow"` to opt out of the first-use prompt, or to `"deny"` to
block.

The extension's own `request_network_access` prompts on its own and is never
gated here.

## Hiding tools

A mode's `hideTools` list removes those tools from the model before it
reasons (via pi's active-tools list), so it never attempts them. It only ever
removes: tools you have off yourself stay off, and switching modes restores
exactly what the previous mode hid. The list is honored literally, including
this extension's `show_plan`; a mode with the `"@plan"` prompt that hides it
gets a warning at load, since that prompt tells the model to call it.
