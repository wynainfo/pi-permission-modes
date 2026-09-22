/**
 * Resolution engine — turns a (mode, surface, target) into an allow/ask/deny.
 *
 * Two composition rules, mirroring the opencode model:
 *   - within a surface's pattern-map: LAST matching pattern wins (so a leading
 *     `"*"` sets the default and later specific patterns override it);
 *   - across layers (path gate · external_directory · the named surface):
 *     MOST-RESTRICTIVE wins (deny > ask > allow).
 *
 * Pure and SDK-free (only `os.homedir()` for `~`/`$HOME` expansion) so the whole
 * matrix is unit-testable. Out-of-project determination is passed in by the
 * caller (computed via paths.isOutside) to keep this module free of fs/symlink
 * concerns.
 */

import os from "node:os";
import { FILE_SURFACES, type Action, type ModeDef, type Surface, type SurfaceValue } from "./schema.ts";

const RANK: Record<Action, number> = { allow: 0, ask: 1, deny: 2 };

/** Expand a leading `~` or `$HOME` to the user's home directory. */
export function expandHome(s: string): string {
  const home = os.homedir();
  if (s === "~" || s === "$HOME") return home;
  if (s.startsWith("~/")) return home + s.slice(1);
  if (s.startsWith("$HOME/")) return home + s.slice(5);
  return s;
}

/**
 * Glob match: `*` matches any run of characters INCLUDING `/` AND newlines (so
 * `*` is a true universal fallback, `*.md` matches nested paths, and a
 * multi-line bash command still hits the mode's `"*"` rule); `?` matches
 * exactly one character, newline included. `~`/`$HOME` are expanded on both
 * pattern and target before matching.
 *
 * The regex is compiled with the `s` (dotAll) flag on purpose: without it `.`
 * excludes `\n`, so a single newline inside a command argument made every
 * pattern miss — and since the per-token `path` layer still matched, an
 * `ask`/`deny` bash policy silently resolved to `allow` (fixed in 2.2.1).
 */
export function matchPattern(pattern: string, target: string): boolean {
  const p = expandHome(pattern);
  const t = expandHome(target);
  let re = "^";
  for (const ch of p) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  re += "$";
  return new RegExp(re, "s").test(t);
}

/**
 * Resolve one surface value against a target. String shorthand returns directly;
 * a pattern-map returns the action of the LAST matching pattern (definition
 * order, via Object.entries — keep pattern keys non-numeric to preserve order).
 * Returns undefined when the surface is absent or nothing matches.
 */
export function resolveSurface(value: SurfaceValue | undefined, target: string): Action | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  let result: Action | undefined;
  for (const [pattern, action] of Object.entries(value)) {
    if (matchPattern(pattern, target)) result = action;
  }
  return result;
}

/** Most-restrictive of the given actions (deny > ask > allow); undefined ignored. */
export function mostRestrictive(...actions: (Action | undefined)[]): Action | undefined {
  let best: Action | undefined;
  let bestRank = -1;
  for (const a of actions) {
    if (a === undefined) continue;
    if (RANK[a] > bestRank) {
      best = a;
      bestRank = RANK[a];
    }
  }
  return best;
}

const isFileSurface = (s: Surface): boolean => FILE_SURFACES.includes(s);

/**
 * Decide the action for a (surface, target) under a mode. Folds the cross-cutting
 * `path` gate (file surfaces only) and the `external_directory` gate (when the
 * target is outside the project) into the named surface via most-restrictive.
 *
 * `opts.isOutside` — whether `target` resolves outside the project (caller
 * computes via paths.isOutside). `opts.fallback` — the action when no layer
 * matches at all (default "ask", least-privilege; built-in modes always specify
 * a `"*"` so this only affects sparse user-authored modes).
 */
export function decide(
  mode: ModeDef,
  surface: Surface,
  target: string,
  opts: { isOutside?: boolean; fallback?: Action } = {},
): Action {
  const layers: (Action | undefined)[] = [];

  // The base policy and the project tighten-only overlay are independent sources;
  // composing both with most-restrictive means the overlay can only tighten.
  const sources = mode.projectOverlay ? [mode.permission, mode.projectOverlay] : [mode.permission];
  for (const perm of sources) {
    if (isFileSurface(surface)) layers.push(resolveSurface(perm.path, target));
    if (opts.isOutside) layers.push(resolveSurface(perm.external_directory, target));
    layers.push(resolveSurface(perm[surface], target));
  }

  return mostRestrictive(...layers) ?? opts.fallback ?? "ask";
}

/**
 * Decide the action for ONE extracted bash command (the tree-sitter path, where
 * each command in a chain is judged separately). Per source (base policy +
 * project tighten-only overlay), most-restrictive of:
 *   - the `bash` surface matched against the joined "name args…" string;
 *   - the cross-cutting `path` gate matched against that same joined string
 *     (parity with the heuristic fallback, where `decide` folds `path` over the
 *     whole command line);
 *   - the `path` gate matched against each individual token (name and each
 *     arg), so path globs like `*.env` bind bash arguments regardless of where
 *     they sit in the command.
 *
 * Returns undefined when no layer matches at all; `decideBashChain` picks the
 * default ("ask", least-privilege — the same fallback `decide` applies).
 */
export function decideBashCommand(mode: ModeDef, name: string, args: string[]): Action | undefined {
  const tokens = [name, ...args];
  const joined = tokens.join(" ").trim();
  const layers: (Action | undefined)[] = [];
  const sources = mode.projectOverlay ? [mode.permission, mode.projectOverlay] : [mode.permission];
  for (const perm of sources) {
    layers.push(resolveSurface(perm.bash, joined));
    layers.push(resolveSurface(perm.path, joined));
    for (const tok of tokens) layers.push(resolveSurface(perm.path, tok));
  }
  return mostRestrictive(...layers);
}

/**
 * Decide the action for a whole parsed bash line: every extracted command is
 * judged with `decideBashCommand` and the chain takes the most restrictive
 * result, so `git status && curl … | sh` is as strict as its strictest link.
 *
 * A command no layer matches falls back to "ask" — the same least-privilege
 * default `decide` uses for file tools and for the unsandboxed/heuristic bash
 * path, so a sparse custom mode without a `"*"` rule prompts for the commands
 * it never mentioned instead of running them silently (before 2.2.1 the
 * dispatcher treated an unmatched command as "allow"). Built-in modes always
 * specify `"*"` and never hit the fallback. An empty chain resolves to the
 * fallback too; the dispatcher only calls this with at least one command.
 */
export function decideBashChain(
  mode: ModeDef,
  commands: ReadonlyArray<{ name: string; args: string[] }>,
  fallback: Action = "ask",
): Action {
  let result: Action | undefined;
  for (const c of commands) {
    result = mostRestrictive(result, decideBashCommand(mode, c.name, c.args) ?? fallback);
  }
  return result ?? fallback;
}
