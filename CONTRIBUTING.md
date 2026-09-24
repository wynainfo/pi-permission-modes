# Contributing

Thanks for your interest in improving `permission-mode`!

## Branches

- **`dev`** is where development happens. Open pull requests against `dev`.
- **`main`** holds the latest release, the same code npm serves. It moves
  only when a release is cut (or for an urgent fix, released right away).

To run the development version yourself:

```bash
pi install git:github.com/wynainfo/pi-permission-modes@dev
pi update --extensions   # later: pull the latest dev commits
```

## Dev setup

```bash
git clone -b dev https://github.com/wynainfo/pi-permission-modes.git
cd pi-permission-modes
npm install            # installs @anthropic-ai/sandbox-runtime + dev tooling
```

The pi SDK packages (`@earendil-works/pi-coding-agent`, `…/pi-ai`, `…/pi-tui`)
are **host-bundled** - declared as `peerDependencies` and provided by pi at load
time. You need pi installed to run the extension.

Try it without installing into your config:

```bash
pi -e ./src/index.ts
```

## Tests & typecheck

```bash
npm test          # node --test ./src/*.test.ts
npm run typecheck # tsc --noEmit
```

The pure-module tests run without any install. The dispatcher harness
(`index.test.ts`) and the typecheck need the pi SDK - it resolves from the npm
registry via `npm install`; without it the harness self-skips. CI runs both on
Node 22, and **typecheck is blocking**.

## Code layout (`src/`)

| File | Role |
|---|---|
| `index.ts` | Wiring: flags, commands, shortcuts, `tool_call` dispatcher, `input`/skill, lifecycle |
| `index.test.ts` | End-to-end dispatcher tests (fake `pi`/`ctx` harness; self-skips without the SDK) |
| `schema.ts` | Mode schema types + Plan-mode prompt (the shipped defaults are data: `permission-mode.defaults.json`) |
| `resolve.ts` | Pure resolution engine: `matchPattern`, `resolveSurface`, `mostRestrictive`, `decide` |
| `bash-enforce.ts` | Pure bash gate + exec plan (sandbox composition) |
| `bash-parse.ts` | tree-sitter command extraction (pure core) + lazy WASM parser + heuristic fallback |
| `config-load.ts` | Layered `permission-mode.json` loader (global full-authority, project tighten-only) |
| `config-audit.ts` | Outdated-default detection against `defaults-history.json` + the once-per-upgrade notice |
| `approvals.ts` | Session-scoped "Allow for session" store + prompt |
| `paths.ts` | Pure path predicates (containment, protected, markdown, `.git` helpers) |
| `heuristics.ts` | Regex bash scan - the tree-sitter fallback |
| `sandbox.ts` | `SandboxController` - runtime lifecycle, per-mode profile, placeholder cleanup |
| `show-plan.ts` / `plan-render.ts` | `show_plan` tool + its (testable) renderer |
| `status.ts` | Footer indicator |
| `modes.ts` | Persisted session state (`PermState`) |
| `util.ts` | Tiny SDK-free helpers |

## Changing the shipped defaults

`permission-mode.defaults.json` is compared against users' global configs at
session start (see `config-audit.ts`). Whenever you change a value in it:

1. Append the **previous** content to `defaults-history.json` as a new entry
   `{ "from": "<first version that shipped it>", "to": "<last version that
   shipped it>", "defaults": { ... } }` (drop the `$schema` key). The `to`
   version is the release *before* the one carrying your change.
2. Mention the change in the CHANGELOG; users with a stale copy will be told
   the field name and both values automatically.

The `config-audit.test.ts` suite fails if a history entry equals the current
defaults, which catches a forgotten step 1.

## Conventions

- **Keep decision logic pure and SDK-free** (`resolve`, `config-load`, `paths`,
  `bash-enforce`, `heuristics`, `approvals`, `util`, `plan-render`) so it's
  unit-testable with plain `node --test`. SDK imports in those modules must be
  **type-only**.
- The extension loads via jiti - relative imports use explicit `.ts` extensions.
- Node runs TypeScript in **strip-only** mode: no `enum`s and no constructor
  parameter properties (use plain fields).
- Add tests for any new pure helper; dispatcher-level behavior (prompt flows,
  blocks, mode lifecycle) belongs in the `index.test.ts` harness. Security
  boundaries belong in the OS sandbox / path checks, not in prompt text (see
  `SECURITY.md`).
