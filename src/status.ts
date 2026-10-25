/**
 * Footer status indicator rendering for the current permission mode.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModeDef } from "./schema.ts";
import { networkFiltered, type SandboxController } from "./sandbox.ts";

/**
 * Render the `perm` status chip:
 *
 *   Build (sandboxed in project dir, alt+m)  Network: filtered (alt+n)
 *   YOLO (alt+m)  Network: open
 *
 * The shortcut hints are always shown — toggling is the least discoverable
 * part of the extension. The network state is color-coded: green while the
 * domain allowlist filters bash traffic, orange when it's open (via alt+n /
 * `/net open`, or because nothing sandboxes in this mode). A degraded sandbox
 * additionally shows a `(!)` warning.
 */
export function updateStatus(
  ctx: Pick<ExtensionContext, "ui">,
  mode: ModeDef,
  sandbox: Pick<SandboxController, "ready" | "warn" | "disabled"> & { switching?: boolean },
  networkOpen: boolean,
  /** A long-running sandbox step in flight (the Windows install and its profile grant), with its elapsed time; shown instead of the warn. */
  busy?: string,
): void {
  const t = ctx.ui.theme;
  const enforcing = mode.sandbox.enabled && sandbox.ready;
  let status = t.fg(mode.color, mode.label);
  // A profile switch in flight (the runtime re-initializes; on Windows it
  // re-stamps permission entries over the project) is marked: the mode has
  // changed, the sandbox follows in a moment.
  if (busy) status += " " + t.fg("warning", `(sandbox: ${busy})`);
  else if (enforcing && sandbox.switching) status += " " + t.fg("warning", "(applying sandbox profile...)");
  else status += " " + t.fg("dim", enforcing ? "(sandboxed in project dir, alt+m)" : "(alt+m)");
  if (!busy && mode.sandbox.enabled && sandbox.warn && !sandbox.disabled) status += " " + t.fg("error", `(!) ${sandbox.warn}`);
  if (enforcing && networkFiltered(mode.sandbox)) {
    status +=
      "  " + (networkOpen ? t.fg("warning", "Network: open (alt+n)") : t.fg("success", "Network: filtered (alt+n)"));
  } else if (enforcing) {
    status += "  " + t.fg("dim", "Network: unrestricted"); // no allowlist configured: the runtime does not filter
  } else {
    status += "  " + t.fg("dim", "Network: open");
  }
  ctx.ui.setStatus("perm", status);
}
