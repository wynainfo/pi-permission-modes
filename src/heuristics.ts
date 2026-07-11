/**
 * Bash command heuristics.
 *
 * A best-effort scan of a bash command string for privilege escalation and
 * out-of-project path tokens. This is NOT a real shell parser and can be fooled
 * (`bash -c '...'`, command substitution, variable-built paths). It drives the
 * Build-mode confirmation UX only; the OS sandbox is the real enforcement.
 *
 * Pure (no `pi`/`ctx`) so the known-gap behavior can be locked down with tests.
 */

import os from "node:os";
import path from "node:path";
import { isOutside, SAFE_OUTSIDE_RE } from "./paths.ts";

/** Privilege escalation / run-as-other-user. */
export const PRIVILEGE_RE = /\b(sudo|su|doas|pkexec|runuser|setpriv|chroot)\b/i;

/**
 * Returns a human-readable reason to prompt before running `command`, or
 * undefined when the heuristic finds nothing concerning. `root` is the project
 * directory used to classify path tokens as in/out of project.
 */
export function bashConfirmReason(command: string, root: string): string | undefined {
  if (PRIVILEGE_RE.test(command)) return "privilege escalation";
  for (const raw of command.split(/[\s;|&()<>]+/).filter(Boolean)) {
    const tok = raw.replace(/^['"]+|['"]+$/g, "");
    if (!tok) continue;
    let target: string | undefined;
    if (tok.startsWith("/")) target = tok;
    else if (tok === "~" || tok.startsWith("~/")) target = path.join(os.homedir(), tok.slice(1));
    else if (tok.includes("/") || tok === "..") target = path.resolve(root, tok);
    else continue;
    if (SAFE_OUTSIDE_RE.test(target)) continue;
    if (isOutside(root, target)) return `path outside project: ${tok}`;
  }
  return undefined;
}
