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
 * Prompt for approval, honoring a prior "Allow for session" grant. Returns true
 * to allow, false to deny. With no UI, denies (most-restrictive). Choosing
 * "Allow for session" records the grant so the next identical action passes
 * silently.
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
  target: string,
  title: string,
  onForever?: () => void | Promise<void>,
): Promise<boolean> {
  if (!ui.hasUI) return false; // no way to confirm → deny
  if (approvals.has(mode, surface, target)) return true; // already granted this session

  const options = onForever ? [ALLOW_ONCE, ALLOW_SESSION, ALLOW_FOREVER, DENY] : [ALLOW_ONCE, ALLOW_SESSION, DENY];
  const choice = await ui.select(title, options);
  if (choice === ALLOW_FOREVER) {
    approvals.remember(mode, surface, target); // cover the rest of this session immediately
    await onForever?.();
    return true;
  }
  if (choice === ALLOW_SESSION) {
    approvals.remember(mode, surface, target);
    return true;
  }
  return choice === ALLOW_ONCE;
}
