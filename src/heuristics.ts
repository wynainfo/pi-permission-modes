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

import { existsSync, lstatSync } from "node:fs";
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
  // `-C/etc`, `-I/usr/include`: a short flag with the value glued on. A token
  // that merely starts with a dash (`--- which node/npm ---`, an echo label) is no flag.
  if (/^-{1,2}[A-Za-z0-9]\S*\//.test(tok)) return tok.slice(tok.indexOf("/"));
  return tok;
}

/**
 * Programs whose program text is passed as an argument: a sed address like
 * `/git-authentication/,/^## /p` or an awk pattern `/x/ {print}` starts with
 * a slash but names no path. `scriptOpt` options take the program as the
 * next argument (also as the last letter of a combined flag, `sed -ne`,
 * `perl -pe`); `fileOpt` options take a file, which stays judged; `valueOpt`
 * options consume the next argument for something that is no path (a field
 * separator, an assignment); `positional` says the first non-option argument is the program when
 * no script option and no `-f` file was given (perl and ruby take a script
 * FILE there, which is a path and stays judged).
 */
const SCRIPT_PROGRAMS: Record<string, { scriptOpt: RegExp; fileOpt: RegExp; valueOpt: RegExp; positional: boolean }> = {
  sed: { scriptOpt: /^(-[a-zA-Z]*e|--expression)$/, fileOpt: /^(-f|--file)$/, valueOpt: /^(-l|--line-length)$/, positional: true },
  awk: { scriptOpt: /^(-[a-zA-Z]*e|--source)$/, fileOpt: /^(-f|--file)$/, valueOpt: /^(-F|-v|--assign|--field-separator)$/, positional: true },
  perl: { scriptOpt: /^-[a-zA-Z0-9]*[eE]$/, fileOpt: /^-I$/, valueOpt: /^$/, positional: false },
  ruby: { scriptOpt: /^-[a-zA-Z0-9]*e$/, fileOpt: /^-I$/, valueOpt: /^$/, positional: false },
};
for (const a of ["gawk", "mawk", "nawk"]) SCRIPT_PROGRAMS[a] = SCRIPT_PROGRAMS.awk;

/**
 * The arguments of `name` that may name paths: the program text of a script
 * program (see SCRIPT_PROGRAMS) is left out. Other commands keep every
 * argument. `name` may be a path to the program.
 */
export function pathArgs(name: string, args: readonly string[]): string[] {
  const prog = SCRIPT_PROGRAMS[path.basename(name).replace(/\.exe$/i, "")];
  if (!prog) return [...args];
  const out: string[] = [];
  let scriptGiven = false;
  let positionalSeen = false;
  let i = 0;
  // Pass one: does a script option or a script file appear anywhere? Then
  // the first positional is an input file, not the program.
  for (const a of args) if (prog.scriptOpt.test(a) || /^(-f|--file)$/.test(a) || /^--(expression|source|file)=/.test(a)) scriptGiven = true;
  while (i < args.length) {
    const a = args[i];
    if (a === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (prog.scriptOpt.test(a)) {
      i += 2; // the option and the program text
      continue;
    }
    if (/^--(expression|source)=/.test(a)) {
      i += 1;
      continue;
    }
    if (prog.fileOpt.test(a)) {
      out.push(a, ...(i + 1 < args.length ? [args[i + 1]] : [])); // `-f file` names a path: judged
      i += 2;
      continue;
    }
    if (prog.valueOpt.test(a)) {
      i += 2;
      continue;
    }
    if (a.startsWith("-") && a !== "-") {
      out.push(a);
      i += 1;
      continue;
    }
    if (prog.positional && !scriptGiven && !positionalSeen) {
      positionalSeen = true; // the program text
      i += 1;
      continue;
    }
    out.push(a);
    i += 1;
  }
  return out;
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
  // Without a parser, quoting is invisible: a script program's text is
  // dropped by pathArgs where it is one word, and a slash-token of its that
  // names nothing on disk (a regex fragment, `/^##` or `/p`) is not a path.
  const words: string[] = [];
  for (const segment of command.split(/[;|&()]+/)) {
    const seg = segment.split(/[\s<>]+/).filter(Boolean);
    const headAt = seg.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    const head = headAt >= 0 ? seg[headAt].replace(/["'`]/g, "") : undefined;
    const kept = head && SCRIPT_PROGRAMS[path.basename(head)] ? [...seg.slice(0, headAt + 1), ...pathArgs(head, seg.slice(headAt + 1).map((w) => w.replace(/^["'`]+|["'`]+$/g, "")))] : seg;
    const scripted = Boolean(head && SCRIPT_PROGRAMS[path.basename(head)]);
    for (const w of kept) {
      if (scripted) {
        const bare = w.replace(/["'`]/g, "");
        // Program text, not a path: a quote inside the word (a quoted script
        // split at its spaces), regex characters, or a one-segment name that
        // does not exist (`/p`, `/d`). A quoted file (`'/etc/hosts'`) stays.
        const quoteInside = !/^["'`]*[^"'`]*["'`]*$/.test(w);
        if (bare.startsWith("/") && (quoteInside || /[\^$*+?|()[\]{}#,\\]/.test(bare) || (!bare.slice(1).includes("/") && !existsSync(bare)))) continue;
      }
      words.push(w);
    }
  }
  for (const raw of words) {
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
