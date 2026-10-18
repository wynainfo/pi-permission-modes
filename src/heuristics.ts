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

import { lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bashPathEscapes, SAFE_OUTSIDE_RE } from "./paths.ts";
import { isOutsideWin, winPathCandidate } from "./win-paths.ts";

/** Privilege escalation / run-as-other-user (Windows: `runas`, `gsudo`). */
export const PRIVILEGE_RE = /\b(sudo|su|doas|pkexec|runuser|setpriv|chroot|runas|gsudo)\b/i;

/** Platform and environment the path check runs against (injected in tests). */
export interface PathCheckOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  home?: string;
}

/**
 * On win32, the judgement of a token that is Windows-shaped (`C:\x`, `~\x`,
 * `$env:X\x`, `%X%\x`, `/c/x`, `..\x`): its absolute path and whether it
 * escapes the project and every `alsoInside` root. Undefined off win32 and
 * for tokens that are not Windows-shaped, which the POSIX rules then judge
 * (`/x`, `~/x`, `a/b`, `..`). A single-letter switch (`cmd /c`, `dir /s`,
 * `findstr /i`) is not a path.
 */
export function winTokenEscape(
  tok: string,
  root: string,
  alsoInside: readonly string[],
  opts: PathCheckOptions,
): { target: string; escapes: boolean } | undefined {
  if ((opts.platform ?? process.platform) !== "win32") return undefined;
  if (/^\/[a-zA-Z?]$/.test(tok)) return { target: tok, escapes: false };
  // Git Bash maps `/tmp` to the temp folder of the account running the
  // command: the sandbox account's own inside the sandbox, the user's
  // outside. Neither is a place worth a prompt, and a prompt would run the
  // command unsandboxed once approved.
  if (/^\/tmp(\/|$)/.test(tok.replace(/["'`]/g, ""))) return { target: tok, escapes: false };
  const target = winPathCandidate(tok, { root, home: opts.home ?? os.homedir(), env: opts.env ?? process.env });
  if (target === undefined) return undefined;
  const inside = [root, ...alsoInside].some((dir) => !isOutsideWin(dir, target));
  // Lexical check always; on a real Windows host also the canonical one, so
  // a junction inside the project cannot hide an escape.
  const escapes = !inside || (process.platform === "win32" && bashPathEscapes(root, target, alsoInside));
  return { target, escapes };
}

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
/**
 * The absolute path a (normalized) bash token names, or undefined when it
 * names none worth judging: absolute paths, `~`/`~/x`, anything with a `/`,
 * `..`, and - with `bare` - a plain word that is a SYMLINK in the project
 * root (`cat data` with `data -> ~/secret.txt`; a plain in-project file
 * or directory is in-project by definition, so only links cost an lstat).
 * Flags are never bare paths; `~user` is handled by the callers.
 */
export function tokenTarget(tok: string, root: string, bare: boolean): string | undefined {
  const p = pathPartOfToken(tok);
  if (p.startsWith("/")) return p;
  if (p === "~" || p.startsWith("~/")) return path.join(os.homedir(), p.slice(1));
  if (p.includes("/") || p === "..") return path.resolve(root, p);
  if (!bare || !p || p.startsWith("-") || p === "." || /[*?[\]{}$`\0]/.test(p)) return undefined;
  try {
    return lstatSync(path.join(root, p)).isSymbolicLink() ? path.resolve(root, p) : undefined;
  } catch {
    return undefined;
  }
}

export function bashConfirmReason(
  command: string,
  root: string,
  alsoInside: readonly string[] = [],
  opts: PathCheckOptions = {},
): string | undefined {
  if (PRIVILEGE_RE.test(command)) return "privilege escalation";
  if (/(^|[;&|(]\s*)(cd|pushd)(\s+-)?\s*($|[;&|)])/.test(command)) return "path outside project: cd";
  for (const raw of command.split(/[\s;|&()<>]+/).filter(Boolean)) {
    const tok = normalizeBashToken(raw);
    if (!tok) continue;
    const win = winTokenEscape(raw, root, alsoInside, opts); // raw: normalizeBashToken would eat the backslashes
    if (win) {
      if (win.escapes) return `path outside project: ${raw}`;
      continue;
    }
    if (/^~[^/]/.test(tok)) return `path outside project: ${raw}`;
    const target = tokenTarget(tok, root, true);
    if (target === undefined || SAFE_OUTSIDE_RE.test(target)) continue;
    if (bashPathEscapes(root, target, alsoInside)) return `path outside project: ${raw}`;
  }
  return undefined;
}
