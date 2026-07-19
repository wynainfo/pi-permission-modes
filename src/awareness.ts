/**
 * Sandbox awareness — the factual "these are your enforcement boundaries"
 * system-prompt section injected each turn (via before_agent_start) while a
 * sandboxed mode is active.
 *
 * Without it the model discovers the sandbox by crashing into it: writes to
 * $HOME, installs into ~/.npm, fetches from non-allowlisted domains — then
 * wastes turns probing variants of a command the kernel will never allow.
 * This section is generated from the ACTIVE mode's merged profile (so global
 * overrides and project tighten-only overlays are reflected truthfully) and
 * states where writes work, which reads are denied, which domains are
 * reachable, and how the prompt flow handles everything else.
 *
 * Tone matters: boundary-crossing commands (out-of-project paths, sudo) are
 * NOT discouraged — the policy layer prompts the user automatically and
 * approved commands run outside the sandbox. Only silent sandbox denials
 * (non-allowlisted domains, undetected out-of-boundary writes) warrant
 * "ask the user" guidance.
 *
 * Pure and SDK-free (like schema.ts/resolve.ts) so it unit-tests without the
 * host.
 */

import type { ModeDef } from "./schema.ts";

export interface AwarenessOptions {
  /** Whether the OS sandbox is actually enforcing (ready and not --no-sandbox). */
  active: boolean;
  /** Why it isn't, when a sandboxed mode runs degraded (warn text / --no-sandbox). */
  reason?: string;
}

/** Render an allowWrite entry for the prompt ("." is the project root). */
const renderWritePath = (p: string): string => (p === "." || p === "./" ? "the project directory" : p);

/**
 * The sandbox-boundary section for `mode`, or undefined when there is nothing
 * to inject: the mode opted out (`injectSandboxInfo: false`) or doesn't
 * sandbox at all (`sandbox.enabled: false` — full permissions need no
 * boundary briefing).
 */
export function sandboxAwarenessPrompt(mode: ModeDef, opts: AwarenessOptions): string | undefined {
  if (mode.injectSandboxInfo === false) return undefined;
  const sb = mode.sandbox;
  if (!sb.enabled) return undefined;

  const header = `## Sandbox & permissions (${mode.label})`;

  if (!opts.active) {
    return [
      header,
      "",
      `This mode normally runs bash inside an OS sandbox, but the sandbox is unavailable here${opts.reason ? ` (${opts.reason})` : ""}.`,
      "Bash commands run with full user permissions and ask for the user's confirmation instead — issue them normally",
      "and let the prompt do the gating.",
    ].join("\n");
  }

  const lines = [header, "", "Bash runs inside an OS-level sandbox with these boundaries:", ""];

  if (!sb.writable) {
    lines.push(
      "- Bash is READ-ONLY: filesystem writes from bash fail regardless of path (no mkdir, no redirects, no installs). Use the Write/Edit tools for the file changes this mode permits.",
    );
  } else {
    const writable = (sb.allowWrite ?? []).map(renderWritePath);
    lines.push(
      `- Writable paths: ${writable.join(", ") || "(none)"}. Use them for installs, temp files, and downloads (./node_modules, an in-project venv, /tmp/...).`,
    );
  }
  if (sb.denyWrite?.length) {
    lines.push(`- Additionally write-denied: ${sb.denyWrite.join(", ")}.`);
  }
  if (sb.denyRead?.length) {
    lines.push(`- Reads are broadly allowed EXCEPT: ${sb.denyRead.join(", ")}.`);
  }
  const domains = sb.network?.allowedDomains ?? [];
  lines.push(
    domains.length
      ? `- Network is limited to these domains: ${domains.join(", ")}. Other hosts are unreachable from bash.`
      : "- No network access from bash (no domains are allowlisted).",
  );
  lines.push(
    "- Commands beyond these boundaries (out-of-project paths, sudo/doas) are fine to issue: the user is asked for permission automatically, and approved commands run outside the sandbox.",
    mode.bypassProtectedPaths
      ? "- File tools (read/edit/write/…) are policy-gated rather than OS-sandboxed."
      : "- File tools (read/edit/write/…) are policy-gated rather than OS-sandboxed; writes to protected paths (.git/, .env*, dotfiles) are blocked.",
    "",
    "If a command fails with a permission or network error without a prompt having appeared, the sandbox blocked it silently — ask the user for that step instead of retrying variants.",
  );
  return lines.join("\n");
}
