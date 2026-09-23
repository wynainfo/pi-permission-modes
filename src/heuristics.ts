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
import { bashPathEscapes, SAFE_OUTSIDE_RE } from "./paths.ts";

/** Privilege escalation / run-as-other-user. */
export const PRIVILEGE_RE = /\b(sudo|su|doas|pkexec|runuser|setpriv|chroot)\b/i;

/**
 * Normalize a bash word for path judgement, undoing the spellings that hid a
 * path from the detector: `$'/etc/x'` (ANSI-C string), `\/etc/x` (escaped
 * slash), `"$HOME"/.bashrc` (quotes glued around an expansion), `$HOME` and
 * `${HOME}`. Other variables are left as is (they can't be resolved here).
 */
export function normalizeBashToken(raw: string): string {
  let t = raw;
  if (t.startsWith("$'")) t = t.slice(2).replace(/'$/, ""); // the parser may already have stripped the closing quote
  t = t.replace(/\\(.)/g, "$1"); // \x → x
  t = t.replace(/["']/g, "");
  const home = os.homedir();
  t = t.replace(/^\$\{HOME\}|^\$HOME(?=$|\/)/, home);
  return t;
}

/**
 * The path-carrying part of a token: `--git-dir=/x` → `/x`, `if=/x` → `/x`,
 * `-C/etc` → `/etc`; anything else unchanged.
 */
export function pathPartOfToken(tok: string): string {
  const eq = tok.match(/^-{0,2}[A-Za-z0-9_.-]+=(.+)$/);
  if (eq) return eq[1];
  if (tok.startsWith("-") && tok.includes("/")) return tok.slice(tok.indexOf("/"));
  return tok;
}

/**
 * Returns a human-readable reason to prompt before running `command`, or
 * undefined when the heuristic finds nothing concerning. `root` is the project
 * directory used to classify path tokens as in/out of project; `alsoInside`
 * lists further in-bounds roots (the sandbox-writable dirs, e.g. `/tmp`).
 */
export function bashConfirmReason(command: string, root: string, alsoInside: readonly string[] = []): string | undefined {
  if (PRIVILEGE_RE.test(command)) return "privilege escalation";
  if (/(^|[;&|(]\s*)(cd|pushd)(\s+-)?\s*($|[;&|)])/.test(command)) return "path outside project: cd";
  for (const raw of command.split(/[\s;|&()<>]+/).filter(Boolean)) {
    const tok = normalizeBashToken(raw);
    if (!tok) continue;
    if (/^~[^/]/.test(tok)) return `path outside project: ${raw}`;
    const p = pathPartOfToken(tok);
    let target: string | undefined;
    if (p.startsWith("/")) target = p;
    else if (p === "~" || p.startsWith("~/")) target = path.join(os.homedir(), p.slice(1));
    else if (p.includes("/") || p === "..") target = path.resolve(root, p);
    else continue;
    if (SAFE_OUTSIDE_RE.test(target)) continue;
    if (bashPathEscapes(root, target, alsoInside)) return `path outside project: ${raw}`;
  }
  return undefined;
}
