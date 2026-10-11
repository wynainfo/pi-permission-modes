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
import { FILE_SURFACES, type Action, type ModeDef, type PatternValue, type Surface, type SurfaceValue } from "./schema.ts";

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
 * exactly one character, newline included. A double-star segment (two stars
 * then a slash, at the start of the pattern or right after a slash) matches
 * ZERO or more directories, so a double-star rule for `.env` also matches a
 * bare `.env`, and `a/<double-star>/b` matches `a/b` (it used to require a
 * slash, which left such rules blind to bare relative paths); any other `*`,
 * including two stars inside a name, keeps the `.*` meaning.
 * `~`/`$HOME` are expanded on both pattern and target before matching.
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
  for (let i = 0; i < p.length; i++) {
    if (p.startsWith("**/", i) && (i === 0 || p[i - 1] === "/")) {
      re += "(?:.*/)?"; // a whole `**/` segment: zero or more directories
      i += 2;
    } else if (p[i] === "*") re += ".*";
    else if (p[i] === "?") re += ".";
    else re += p[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  re += "$";
  return new RegExp(re, "s").test(t);
}

/**
 * Resolve one surface value against a target, with the winning rule's reason.
 * String shorthand returns the action with no reason; a pattern-map returns the
 * action AND reason of the LAST matching pattern (definition order, via
 * Object.entries - keep pattern keys non-numeric to preserve order).
 * Returns undefined when the surface is absent or nothing matches.
 */
export function resolveSurfaceDetailed(value: SurfaceValue | undefined, target: string): Decision | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return { action: value };
  let result: Decision | undefined;
  for (const [pattern, rule] of Object.entries(value)) {
    if (matchPattern(pattern, target)) {
      const action = ruleAction(rule);
      const reason = ruleReason(rule);
      result = reason === undefined ? { action } : { action, reason };
    }
  }
  return result;
}

/**
 * Resolve one surface value against a target. String shorthand returns directly;
 * a pattern-map returns the action of the LAST matching pattern (the winning
 * rule's reason is dropped - see resolveSurfaceDetailed to keep it).
 * Returns undefined when the surface is absent or nothing matches.
 */
export function resolveSurface(value: SurfaceValue | undefined, target: string): Action | undefined {
  return resolveSurfaceDetailed(value, target)?.action;
}

/**
 * Most-restrictive of the given detailed layers. The winning action is decided
 * exactly as `mostRestrictive` (deny > ask > allow, single source of truth);
 * on a tie the LAST layer carrying the winning action wins (so a project
 * overlay's reason beats the base policy's, and a surface-specific reason beats
 * the cross-cutting `path` gate's). When that layer carries no reason, the
 * nearest earlier tied layer with one is used.
 */
function mostRestrictiveDetailed(layers: (Decision | undefined)[]): Decision | undefined {
  const best = mostRestrictive(...layers.map((l) => l?.action));
  if (best === undefined) return undefined;
  let reason: string | undefined;
  for (const l of layers) {
    if (l !== undefined && l.action === best && l.reason !== undefined) reason = l.reason;
  }
  return reason === undefined ? { action: best } : { action: best, reason };
}

/** The action carried by a pattern-map entry (bare string or `{ action, … }` object). */
export function ruleAction(rule: PatternValue): Action {
  return typeof rule === "string" ? rule : rule.action;
}

/** The human-readable reason carried by a pattern-map entry, if any. */
export function ruleReason(rule: PatternValue): string | undefined {
  return typeof rule === "string" ? undefined : rule.reason;
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

/** The decided action plus the winning rule's reason, if it carries one. */
export interface Decision {
  action: Action;
  reason?: string;
}

/**
 * Decide the action AND winning reason for a (surface, target) under a mode.
 * Same layer composition as `decide`; the reason travels with the winning
 * rule (a reason never loosens anything). `decide` is `decideDetailed(...).action`.
 */
export function decideDetailed(
  mode: ModeDef,
  surface: Surface,
  target: string,
  opts: { isOutside?: boolean; fallback?: Action } = {},
): Decision {
  const layers: (Decision | undefined)[] = [];

  // The base policy and the project tighten-only overlay are independent sources;
  // composing both with most-restrictive means the overlay can only tighten.
  const sources = mode.projectOverlay ? [mode.permission, mode.projectOverlay] : [mode.permission];
  for (const perm of sources) {
    if (isFileSurface(surface)) layers.push(resolveSurfaceDetailed(perm.path, target));
    if (opts.isOutside) layers.push(resolveSurfaceDetailed(perm.external_directory, target));
    layers.push(resolveSurfaceDetailed(perm[surface], target));
  }

  return mostRestrictiveDetailed(layers) ?? { action: opts.fallback ?? "ask" };
}

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
  return decideDetailed(mode, surface, target, opts).action;
}

/**
 * Decide the action AND winning reason for ONE extracted bash command.
 * Same layer composition as `decideBashCommand`; the reason travels with the
 * winning rule. Returns undefined when no layer matches at all.
 */
export function decideBashCommandDetailed(
  mode: ModeDef,
  name: string,
  args: string[],
  aliases: readonly string[] = [],
  pathTokens: readonly string[] = [],
): Decision | undefined {
  const tokens = [name, ...args, ...pathTokens];
  const joined = tokens.join(" ").trim();
  const layers: (Decision | undefined)[] = [];
  const sources = mode.projectOverlay ? [mode.permission, mode.projectOverlay] : [mode.permission];
  // Layer order is load-bearing for the reason (not the action): the
  // cross-cutting `path` gate goes first so that on a tie the bash-surface
  // reason wins - the same contract `decideDetailed` keeps (surface-specific
  // beats `path`; project overlay beats base policy).
  for (const perm of sources) {
    layers.push(resolveSurfaceDetailed(perm.path, joined));
    for (const tok of tokens) layers.push(resolveSurfaceDetailed(perm.path, tok));
    layers.push(resolveSurfaceDetailed(perm.bash, joined));
    // Alternative spellings (basename of a path head, the command a wrapper
    // runs): a `"sudo*": "deny"` must catch `/usr/bin/sudo id` and `time sudo id`.
    for (const alt of aliases) layers.push(resolveSurfaceDetailed(perm.bash, alt));
  }
  return mostRestrictiveDetailed(layers);
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
export function decideBashCommand(
  mode: ModeDef,
  name: string,
  args: string[],
  aliases: readonly string[] = [],
  pathTokens: readonly string[] = [],
): Action | undefined {
  return decideBashCommandDetailed(mode, name, args, aliases, pathTokens)?.action;
}

/**
 * Decide the action AND winning reason for a whole parsed bash line: every
 * extracted command is judged with `decideBashCommandDetailed` and the chain
 * takes the most restrictive result, carrying its reason.
 */
export function decideBashChainDetailed(
  mode: ModeDef,
  commands: ReadonlyArray<{ name: string; args: string[]; aliases?: readonly string[]; pathTokens?: readonly string[] }>,
  fallback: Action = "ask",
): Decision {
  let result: Decision | undefined;
  for (const c of commands) {
    const d = decideBashCommandDetailed(mode, c.name, c.args, c.aliases ?? [], c.pathTokens ?? []) ?? { action: fallback };
    result = mostRestrictiveDetailed([result, d]);
  }
  return result ?? { action: fallback };
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
  commands: ReadonlyArray<{ name: string; args: string[]; aliases?: readonly string[]; pathTokens?: readonly string[] }>,
  fallback: Action = "ask",
): Action {
  return decideBashChainDetailed(mode, commands, fallback).action;
}
