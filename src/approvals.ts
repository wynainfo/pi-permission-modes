/**
 * Session-scoped approvals — "Allow for session" memory.
 *
 * When an `ask` is granted "for session", the (mode, surface, target) is
 * remembered so the same action isn't re-prompted for the rest of the session.
 * The store is keyed per-mode (switching Build → Default → Build restores
 * Default's grants), session-lifetime only (never persisted to disk), and
 * cleared on session shutdown.
 *
 * The store is pure and unit-tested; `askWithSession` is the thin UI glue (a
 * three-way Allow once / Allow for session / Deny prompt).
 */

import path from "node:path";
import type { Surface } from "./schema.ts";

export class SessionApprovals {
  private store = new Map<string, Map<Surface, Set<string>>>();

  has(mode: string, surface: Surface, target: string): boolean {
    return this.store.get(mode)?.get(surface)?.has(target) ?? false;
  }

  remember(mode: string, surface: Surface, target: string): void {
    let bySurface = this.store.get(mode);
    if (!bySurface) {
      bySurface = new Map();
      this.store.set(mode, bySurface);
    }
    let set = bySurface.get(surface);
    if (!set) {
      set = new Set();
      bySurface.set(surface, set);
    }
    set.add(target);
  }

  clearMode(mode: string): void {
    this.store.delete(mode);
  }

  clearAll(): void {
    this.store.clear();
  }
}

/**
 * Session-scoped out-of-project paths the user chose to BLOCK ("Deny and
 * block <path> for this session"). Canonical absolute paths; a path is
 * covered when it equals a blocked path or lies under a blocked directory.
 * The dispatcher folds the list into the active profile's `denyRead` (so the
 * OS sandbox masks the paths for bash) and checks it directly for the file
 * tools (which aren't sandboxed). Session lifetime only.
 */
export class BlockedPaths {
  private paths = new Set<string>();

  add(p: string): void {
    this.paths.add(p);
  }

  remove(p: string): boolean {
    return this.paths.delete(p);
  }

  covers(p: string): boolean {
    for (const b of this.paths) {
      if (p === b || p.startsWith(b.endsWith(path.sep) ? b : b + path.sep)) return true;
    }
    return false;
  }

  list(): string[] {
    return [...this.paths];
  }

  clear(): void {
    this.paths.clear();
  }
}

/** An extra prompt option that denies AND runs a side effect (e.g. block the path for the session). */
export interface DenyOption {
  label: string;
  run: () => void | Promise<void>;
}

/** Minimal UI surface needed by `askWithSession` (a subset of ctx.ui + hasUI). */
export interface ApprovalUI {
  hasUI: boolean;
  select(title: string, options: string[]): Promise<string | undefined>;
}

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow for session";
const ALLOW_FOREVER = "Allow forever";
const DENY = "Deny";

/**
 * Prompt for approval, honoring prior "Allow for session" grants. Returns true
 * to allow, false to deny. With no UI, denies (most-restrictive).
 *
 * `target` may be a single key or a list (e.g. every command name extracted
 * from a bash chain). The prompt is skipped only when EVERY target is already
 * granted — so "allow git this session" never silently covers
 * `git status && curl ... | sh`. Granting for session (or forever) remembers
 * ALL targets, so re-running the exact same approved chain passes silently.
 * An empty list never auto-allows.
 *
 * When `onForever` is provided, a fourth "Allow forever" option appears; choosing
 * it records the session grant AND invokes `onForever` (which persists the rule
 * to the user's config). Used for first-seen extension tools / skills.
 */
export async function askWithSession(
  ui: ApprovalUI,
  approvals: SessionApprovals,
  mode: string,
  surface: Surface,
  target: string | string[],
  title: string,
  onForever?: () => void | Promise<void>,
  denyAnd?: DenyOption,
): Promise<boolean> {
  if (!ui.hasUI) return false; // no way to confirm → deny
  const targets = Array.isArray(target) ? target : [target];
  // Already granted this session - every target must be covered.
  if (targets.length > 0 && targets.every((t) => approvals.has(mode, surface, t))) return true;

  const options = onForever ? [ALLOW_ONCE, ALLOW_SESSION, ALLOW_FOREVER, DENY] : [ALLOW_ONCE, ALLOW_SESSION, DENY];
  if (denyAnd) options.push(denyAnd.label); // "Deny and block … for this session"
  const choice = await ui.select(title, options);
  if (denyAnd && choice === denyAnd.label) {
    await denyAnd.run();
    return false;
  }
  if (choice === ALLOW_FOREVER) {
    for (const t of targets) approvals.remember(mode, surface, t); // cover the rest of this session immediately
    await onForever?.();
    return true;
  }
  if (choice === ALLOW_SESSION) {
    for (const t of targets) approvals.remember(mode, surface, t);
    return true;
  }
  return choice === ALLOW_ONCE;
}
