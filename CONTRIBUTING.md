# Contributing

Thanks for your interest in improving `permission-mode`!

## Dev setup

```bash
git clone https://github.com/wynainfo/pi-permission-modes.git
cd pi-permission-modes
npm install            # installs @anthropic-ai/sandbox-runtime + dev tooling
```

The pi SDK packages (`@earendil-works/pi-coding-agent`, `…/pi-ai`, `…/pi-tui`)
are **host-bundled** — declared as `peerDependencies` and provided by pi at load
time. You need pi installed to run the extension.

Try it without installing into your config:

```bash
pi -e ./src/index.ts
```

## Tests & typecheck

```bash
npm test          # node --test ./src/*.test.ts  (no SDK needed — pure modules)
npm run typecheck # tsc --noEmit  (needs the pi SDK types resolvable, i.e. pi present)
```

CI runs the test suite on Node 22; typecheck runs best-effort.

## Code layout (`src/`)

| File | Role |
|---|---|
| `index.ts` | Wiring: flags, commands, shortcuts, `tool_call` dispatcher, `input`/skill, lifecycle |
| `schema.ts` | Mode definitions (types + built-in `DEFAULT_CONFIG`) + Plan-mode prompt |
| `resolve.ts` | Pure resolution engine: `matchPattern`, `resolveSurface`, `mostRestrictive`, `decide` |
| `bash-enforce.ts` | Pure bash gate + exec plan (sandbox composition) |
| `bash-parse.ts` | tree-sitter command extraction (pure core) + lazy WASM parser + heuristic fallback |
| `config-load.ts` | Layered `permission-mode.json` loader (global full-authority, project tighten-only) |
| `approvals.ts` | Session-scoped "Allow for session" store + prompt |
| `paths.ts` | Pure path predicates (containment, protected, markdown, `.git` helpers) |
| `heuristics.ts` | Regex bash scan — the tree-sitter fallback |
| `sandbox.ts` | `SandboxController` — runtime lifecycle, per-mode profile, placeholder cleanup |
| `show-plan.ts` / `plan-render.ts` | `show_plan` tool + its (testable) renderer |
| `status.ts` | Footer indicator |
| `modes.ts` | Persisted session state (`PermState`) |
| `util.ts` | Tiny SDK-free helpers |

## Conventions

- **Keep decision logic pure and SDK-free** (`paths`, `policy`, `config`,
  `util`, `plan-render`) so it's unit-testable with plain `node --test`. SDK
  imports in those modules must be **type-only**.
- The extension loads via jiti — relative imports use explicit `.ts` extensions.
- Node runs TypeScript in **strip-only** mode: no `enum`s and no constructor
  parameter properties (use plain fields).
- Add tests for any new pure helper. Security boundaries belong in the OS sandbox
  / path checks, not in prompt text (see `SECURITY.md`).
