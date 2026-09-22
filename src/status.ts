/**
 * Footer status indicator rendering for the current permission mode.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModeDef } from "./schema.ts";
import type { SandboxController } from "./sandbox.ts";

/**
 * Render the `perm` status chip:
 *
 *   Build (sandboxed in project dir, alt+m)  Network: filtered (alt+n)
 *   Build (sandboxed (path confinement), alt+m)  Network: open
 *   YOLO (alt+m)  Network: open
 *
 * The shortcut hints are always shown — toggling is the least discoverable
 * part of the extension. The network state is color-coded: green while the
 * domain allowlist filters bash traffic, orange when it's open (via alt+n /
 * `/net open`, or because nothing sandboxes in this mode). A degraded sandbox
 * additionally shows a `(!)` warning.
 */
export function updateStatus(ctx: ExtensionContext, mode: ModeDef, sandbox: SandboxController, networkOpen: boolean): void {
  const t = ctx.ui.theme;
  const enforcing = mode.sandbox.enabled && sandbox.ready;
  let status = t.fg(mode.color, mode.label);
  let label = enforcing ? "(sandboxed in project dir, alt+m)" : "(alt+m)";
  // On Windows, indicate the type of sandboxing (path confinement vs OS-level)
  if (enforcing && process.platform === "win32") {
    label = "(sandboxed (path confinement), alt+m)";
  }
  status += " " + t.fg("dim", label);
  if (mode.sandbox.enabled && sandbox.warn && !sandbox.disabled) status += " " + t.fg("error", `(!) ${sandbox.warn}`);
  if (enforcing) {
    status +=
      "  " + (networkOpen ? t.fg("warning", "Network: open (alt+n)") : t.fg("success", "Network: filtered (alt+n)"));
  } else {
    status += "  " + t.fg("dim", "Network: open");
  }
  ctx.ui.setStatus("perm", status);
}
