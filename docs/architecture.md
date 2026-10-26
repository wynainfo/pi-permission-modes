# Architecture

For people who fork the extension or contribute to it. CONTRIBUTING.md has
the branch model, the dev setup, and the test commands; this file has the
shape of the code.

## Modules

| File | Role |
|---|---|
| `src/index.ts` | Wiring: flags, commands, shortcuts, the `tool_call` dispatcher, the `input` hook for skills, `before_agent_start` (system prompt), lifecycle (`session_start`, `session_tree`, `session_shutdown`) |
| `src/schema.ts` | Mode schema types and the Plan-mode prompt. The shipped defaults are data: `permission-mode.defaults.json` |
| `src/prompt-sections.ts` | The mode text as pi prompt sections (`permission_mode`, `permission_mode_docs`, `permission_mode_steering`), with the fallback for a pi without sections |
| `src/resolve.ts` | Pure resolution engine: `matchPattern`, `resolveSurface`, `mostRestrictive`, `decide`, `decideBashChain` |
| `src/bash-parse.ts` | tree-sitter command extraction (pure core), the lazily loaded WASM parser, the heuristic fallback |
| `src/bash-enforce.ts` | Pure bash gate (`bashGate`) and exec plan: how a policy action composes with the sandbox state |
| `src/heuristics.ts` | Regex bash scan, the tree-sitter fallback |
| `src/paths.ts` | Pure path predicates: containment, protected paths, markdown, `.git` helpers, symlink canonicalization |
| `src/config-load.ts` | Layered `permission-mode.json` loader: stock, global (full authority), project (tighten-only); `profileToConfig`; "Allow forever" persistence |
| `src/config-audit.ts` | Outdated-default detection against `defaults-history.json`, the once-per-upgrade notice |
| `src/approvals.ts` | Session-scoped "Allow for session" store and the prompt |
| `src/sandbox.ts` | `SandboxController`: runtime lifecycle, per-mode profile, per-command wrap, violation reporting, placeholder cleanup |
| `src/network.ts` | Session network state: grants, denies, the open toggle, the live host prompt |
| `src/awareness.ts` | The `## Sandbox & permissions` system-prompt section (pure) |
| `src/docs.ts` | Documentation references: the docs directory, the reference table hints point at, the prompt block |
| `src/scratch.ts` | Per-session scratch directory and the age sweep |
| `src/show-plan.ts`, `src/plan-render.ts`, `src/plan-approval.ts` | The `show_plan` tool, its renderer, one-step plan approval |
| `src/auto/verdict.ts` | Auto mode, pure: what the classifier is asked (objective, boundary, trail, action), the answer parser, the strictness table, the cache, the circuit breaker, the messages |
| `src/auto/precheck.ts` | Auto mode: the deterministic checks before the model (denyRead reads, pipe-to-shell, force push, agent-directory writes refuse; resolution and unseen-code facts) |
| `src/auto/classifier.ts` | Auto mode: the model call (registry lookup, auth, the `report_verdict` tool, timeout and retry) |
| `src/status.ts` | Footer indicator |
| `src/modes.ts` | Persisted session state (`PermState`) |
| `src/util.ts` | Tiny SDK-free helpers |

## Decision flow

1. **`tool_call`** (`src/index.ts`): the dispatcher normalizes the path
   argument, applies the protected-path backstop for `edit` and `write`,
   then branches by tool.
2. **bash**: `analyzeBash` parses the command (tree-sitter, or the heuristic)
   into commands with names, arguments, aliases, and path tokens, and
   detects escapes (an out-of-project path beyond the sandbox-writable
   roots, privilege escalation). `decideBashChain` resolves the policy per
   command, most restrictive across the chain. `bashGate` composes the action
   with the escape reason and the sandbox state into allow / prompt / block.
   A prompt goes through `promptAllow` (session grants, "Deny and block").
   In a mode with a `classifier` block, `promptAllow` asks the judge first
   (`src/auto`): cache, pre-checks, then the model; an allow passes, a
   refusal blocks with the verdict or, with `onRefuse: "ask"` or a tripped
   breaker, falls through to the prompt. The network ask callback does the
   same for a host, with the commands in flight.
   An approved escape is remembered by tool call id and runs unsandboxed.
3. **file tools**: a session block refuses first; then `decide` with the
   surface, the `path` gate, and `external_directory` when the path is
   outside the project; `ask` prompts, `deny` blocks.
4. **web_search, tools, skills**: `decide` on their surfaces; first-use
   prompts can persist "Allow forever" into the global config.
5. **Execution**: the extension replaces pi's bash tool with one whose
   operations come from `SandboxController.bashOps`. A sandboxed run writes
   the command to a file, wraps a launcher with the runtime
   (`wrapWithSandbox`, with a per-command id and the per-run extras), streams
   output, and afterwards appends the runtime's violation block for that id
   and the grantable-host hint, then calls `cleanupAfterCommand`.
6. **System prompt**: `before_agent_start` writes three pi prompt sections
   (`src/prompt-sections.ts`): the awareness section built from the
   effective profile (mode profile plus scratch dir plus session blocks),
   the docs pointer, and the mode's `systemPrompt` (`@plan` expands to the
   dated Plan-mode prompt). pi diffs them per turn and patches the changed
   ones in the transcript, so a switch does not rewrite the request head;
   a pi without sections gets the text appended to the system prompt.

## Invariants

- **Gating is not containment.** The policy engine and the bash analysis
  decide whether to prompt and whether an approved command runs
  unsandboxed. The sandbox is the boundary for in-project bash; a missed
  detection is a missed prompt, not a filesystem escape. Never make a
  security property depend on the parser alone.
- **Fail closed.** An unknown action becomes `deny`; an unknown key is
  dropped with a warning; a config that cannot load keeps the previous one;
  an unavailable sandbox prompts instead of running bash unprotected; a
  command no layer matches falls back to `ask`.
- **A project config only tightens.** Every merge of a project value goes
  through `tightenSandbox` or the most-restrictive overlay. Anything that
  could loosen (labels, prompts, hidden tools, reasons shown to the model)
  is ignored from a project.
- **Pure, SDK-free decision logic.** `resolve`, `config-load`, `paths`,
  `bash-enforce`, `heuristics`, `approvals`, `awareness`, `docs`,
  `plan-render`, `util` import the SDK as types only, so `node --test` runs
  them without pi. `index.ts` is the only place that talks to pi's runtime
  API; `sandbox.ts` is the only place that talks to the runtime.
- **The session scratch directory is always writable and in-bounds**, even
  when a config drops `/tmp/pi`; the awareness text must stay truthful.
- **Hints carry documentation references.** Every message that explains a
  limit points at a `docs/<file>#<section>` through `src/docs.ts`
  (`DOC_REFS`), and `src/docs.test.ts` fails when a reference does not
  resolve to an existing heading.

## Tests

- `node --test ./src/*.test.ts`; `tsc --noEmit` for types. Node runs the
  TypeScript directly in strip-only mode: no `enum`, no constructor
  parameter properties.
- **Pure tests** per module (`resolve.test.ts`, `paths.test.ts`, ...).
- **Fake runtime** (`sandbox.test.ts`): a `SandboxManager` stand-in records
  `initialize`, `wrapWithSandbox`, `cleanupAfterCommand`, and
  `annotateStderrWithSandboxFailures` calls, so the controller's lifecycle
  and the per-run hints are tested without bubblewrap.
- **Harness** (`index.test.ts`): a fake `pi` and `ctx` drive the real
  extension through `session_start` and `tool_call` with `--no-sandbox`,
  asserting prompts, blocks, footer text, and session entries. It self-skips
  when the pi SDK is not installed.
- **Docs guard** (`docs.test.ts`): references, schema coverage, index links,
  and the hyphen rule for `docs/`.

## Adding a config key

1. `src/schema.ts`: the type (`SandboxProfile`, `ModeDef`, or the top-level
   config).
2. `schemas/permission-mode.schema.json`: the key with a description.
3. `src/config-load.ts`: accept it in `sanitizeSandbox` or the mode cleaner,
   decide its tighten-only rule in `tightenSandbox` or `applyProject`, and
   forward it in `profileToConfig` if the runtime consumes it.
4. `docs/sandbox.md`, `docs/modes.md`, or `docs/configuration.md`: the row
   (the docs test fails until the key appears).
5. If the stock defaults change: append the previous content to
   `defaults-history.json` (CONTRIBUTING.md, "Changing the shipped defaults").
6. `src/awareness.ts` when the model should know about it; `src/index.ts`
   `/sandbox` when the user should see it.
7. Tests for the loader and the projection; CHANGELOG under `[Unreleased]`.
