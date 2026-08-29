/**
 * Footer status indicator rendering for the current permission mode.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModeDef } from "./schema.ts";
import type { SandboxController } from "./sandbox.ts";

export interface StatusOptions {
  /** Full replacement template. Undefined preserves the historical layout. */
  format?: string;
  modeShortcut: string;
  networkShortcut: string;
}

/** Render a template while keeping dynamic values semantically colored. */
function renderTemplate(
  ctx: ExtensionContext,
  mode: ModeDef,
  enforcing: boolean,
  networkOpen: boolean,
  options: StatusOptions,
): string {
  const t = ctx.ui.theme;
  const filtered = enforcing && !networkOpen;
  const networkState = filtered
    ? t.fg("success", "filtered")
    : t.fg(enforcing ? "warning" : "dim", "open");
  const replacements: Record<string, string> = {
    "%m": t.fg(mode.color, mode.label),
    "%M": t.fg("dim", options.modeShortcut),
    "%n": networkState,
    "%N": t.fg("dim", options.networkShortcut),
  };
  return options.format!.replace(/%[mMnN]/g, (token) => replacements[token]);
}

/**
 * Render the `perm` status chip. The default layout remains backward-compatible;
 * `statusFormat` can replace it with %m/%M/%n/%N placeholders. A degraded
 * sandbox warning is always visible, including when a custom format omits the
 * mode or network placeholders.
 */
export function updateStatus(
  ctx: ExtensionContext,
  mode: ModeDef,
  sandbox: SandboxController,
  networkOpen: boolean,
  options: StatusOptions,
): void {
  const t = ctx.ui.theme;
  const enforcing = mode.sandbox.enabled && sandbox.ready;
  const warning = mode.sandbox.enabled && sandbox.warn && !sandbox.disabled ? `(!) ${sandbox.warn}` : undefined;

  let status: string;
  if (options.format !== undefined) {
    status = renderTemplate(ctx, mode, enforcing, networkOpen, options);
    if (warning) status += `${status ? " " : ""}${t.fg("error", warning)}`;
  } else {
    status = t.fg(mode.color, mode.label);
    const modeHint = enforcing
      ? `sandboxed in project dir${options.modeShortcut ? `, ${options.modeShortcut}` : ""}`
      : options.modeShortcut;
    if (modeHint) status += " " + t.fg("dim", `(${modeHint})`);
    if (warning) status += " " + t.fg("error", warning);

    if (enforcing) {
      const shortcut = options.networkShortcut ? ` (${options.networkShortcut})` : "";
      status +=
        "  " +
        (networkOpen
          ? t.fg("warning", `Network: open${shortcut}`)
          : t.fg("success", `Network: filtered${shortcut}`));
    } else {
      status += "  " + t.fg("dim", "Network: open");
    }
  }
  ctx.ui.setStatus("perm", status);
}
