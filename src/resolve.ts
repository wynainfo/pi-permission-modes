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
 * Glob match: `*` matches any run of characters INCLUDING `/` (so `*` is a true
 * universal fallback and `*.md` matches nested paths); `?` matches exactly one
 * character. `~`/`$HOME` are expanded on both pattern and target before matching.
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
  return new RegExp(re).test(t);
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
