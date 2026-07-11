/**
 * Footer status indicator rendering for the current permission mode.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModeDef } from "./schema.ts";
import type { SandboxController } from "./sandbox.ts";

/**
 * Render the `perm` status chip: the mode label (text only, no icon), plus a
 * dim `(sandboxed in project dir)` when the sandbox is active, or a `(!)`
 * warning when it's degraded. Both are suppressed for modes that don't sandbox
 * (e.g. YOLO, `sandbox.enabled:false`).
 */
export function updateStatus(ctx: ExtensionContext, mode: ModeDef, sandbox: SandboxController): void {
  const t = ctx.ui.theme;
  let status = t.fg(mode.color, mode.label);
  if (mode.sandbox.enabled) {
    if (sandbox.ready) status += " " + t.fg("dim", "(sandboxed in project dir)");
    if (sandbox.warn && !sandbox.disabled) status += " " + t.fg("error", `(!) ${sandbox.warn}`);
  }
  ctx.ui.setStatus("perm", status);
}
