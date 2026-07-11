/**
 * Path containment & protected-path predicates.
 *
 * Pure functions (no `pi`/`ctx`) so they can be unit-tested in isolation —
 * these are the security-critical guards that decide whether a tool touches
 * something outside the project or a protected file.
 *
 * `isOutside` resolves symlinks (via realpath) before the containment test so a
 * symlink *inside* the project that points outside is correctly treated as an
 * escape — file tools (read/edit/write) are not OS-sandboxed, so this is their
 * only containment guard.
 */

import { realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/** Device pseudo-files that are "outside" the project but harmless to allow. */
export const SAFE_OUTSIDE_RE = /^\/dev\/(null|zero|stdin|stdout|stderr|tty|urandom|random)$/;

/** Directory names that are protected anywhere in a path. */
const PROTECTED_DIRS = [".git", "node_modules", ".vscode", ".idea"];
/** Basenames that are protected (shell rc, VCS/npm config). Mirrors the sandbox-runtime mandatory-deny set. */
const PROTECTED_FILES = new Set([
  ".gitconfig",
  ".gitmodules",
  ".npmrc",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
]);

/**
 * Canonicalize a path by resolving symlinks on its longest existing prefix and
 * appending the remaining (not-yet-created) tail verbatim. Never throws for
 * missing paths — falls back to the lexical resolution.
 */
function canonicalize(p: string): string {
  let current = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return tail.length ? path.join(current, ...tail) : current;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * True when `p`, resolved against `root` (with symlinks followed), escapes the
 * project directory. Empty/undefined paths are treated as in-project (tools
 * default to cwd).
 */
export function isOutside(root: string, p?: string): boolean {
  if (!p) return false;
  const target = canonicalize(path.resolve(root, p));
  const realRoot = canonicalize(root);
  const rel = path.relative(realRoot, target);
  return rel.startsWith("..") || path.isAbsolute(rel);
}

/** True when the path is a Markdown file (planning files allowed in Read mode). */
export function isMarkdown(p: string): boolean {
  return /\.(md|markdown)$/i.test(p);
}

/** Normalize a model-supplied path: trim and strip a leading `@` (some models add it). */
export function resolvePlanPath(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .replace(/^@/, "");
}

/**
 * The OS sandbox write-protects a fixed set of dotfiles/dirs at the project root
 * (its mandatory-deny list — `@anthropic-ai/sandbox-runtime`'s `DANGEROUS_FILES`
 * + `DANGEROUS_DIRECTORIES` + the `.claude/{commands,agents}` denies). When such
 * a path is ABSENT, the runtime denies it by mounting `/dev/null` over the first
 * missing component, and because the project is writable in Default/Build,
 * bubblewrap materializes that mountpoint as a **0-byte, read-only file** that
 * survives teardown — littering the project (and, for `.git`, breaking the next
 * run). These are the paths to clean up around every sandboxed run.
 */
export const SANDBOX_PLACEHOLDER_PATHS = [
  ".git",
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
  ".mcp.json",
  ".vscode",
  ".idea",
  ".claude",
  ".claude/commands",
  ".claude/agents",
];

/**
 * Delete any 0-byte placeholder files the sandbox left at the project root.
 * Only removes a path that is a **0-byte regular file** — a legitimate version
 * of any of these is a directory (`.git`, `.vscode`, `.idea`, `.claude`) or a
 * non-empty file (`.gitmodules`, `.mcp.json`, shell rc files), so real files and
 * dirs are never touched. Called before & after each sandboxed run; best-effort.
 * Returns the number of placeholders removed.
 */
export function removeSandboxPlaceholders(root: string): number {
  let removed = 0;
  for (const rel of SANDBOX_PLACEHOLDER_PATHS) {
    const p = path.join(root, rel);
    try {
      const st = statSync(p);
      if (st.isFile() && st.size === 0) {
        rmSync(p, { force: true });
        removed++;
      }
    } catch {
      // absent / unreadable → nothing to clean
    }
  }
  return removed;
}

/**
 * True when `<root>/.git` is a **real gitfile** (a non-empty file) — i.e. a git
 * worktree or submodule. bubblewrap can't bind `.git/hooks` under a file, and
 * unlike the 0-byte placeholder this file is legitimate and must NOT be deleted,
 * so the sandbox degrades to prompting for these projects. (A 0-byte `.git`
 * placeholder returns false here — it's cleaned up instead, see `removeSandboxPlaceholders`.)
 */
export function gitFileBlocksSandbox(root: string): boolean {
  try {
    const st = statSync(path.join(root, ".git"));
    return !st.isDirectory() && !(st.isFile() && st.size === 0);
  } catch {
    return false; // no .git → normal non-git project, sandbox is fine
  }
}

/**
 * True when `p` is a Markdown file inside the project's `plan/` directory — the
 * files Plan Mode writes and `show_plan` renders. Lexical (no realpath); this is
 * a UI-routing predicate, not a security boundary.
 */
export function isPlanFile(root: string, p?: string): boolean {
  if (!p || !isMarkdown(p)) return false;
  const rel = path.relative(path.resolve(root, "plan"), path.resolve(root, p));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * True when a write target is a protected path. Segment-aware (not a loose
 * substring): matches protected directory names anywhere in the path, `.env`
 * and `.env.*` files, known dotfiles, and `.claude/{commands,agents}`.
 * Purely lexical — see `isProtectedWrite` for the symlink-resolving backstop.
 */
export function isProtectedPath(p: string): boolean {
  const segments = p.split(/[/\\]+/).filter(Boolean);
  if (segments.length === 0) return false;
  const base = segments[segments.length - 1];

  if (segments.some((s) => PROTECTED_DIRS.includes(s))) return true;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (PROTECTED_FILES.has(base)) return true;
  for (let i = 0; i + 1 < segments.length; i++) {
    if (segments[i] === ".claude" && (segments[i + 1] === "commands" || segments[i + 1] === "agents")) return true;
  }
  return false;
}

/**
 * The protected-path backstop for `edit`/`write` targets: the raw path is
 * matched lexically (so a textual `.git/…` is blocked even before it exists),
 * AND its canonical form — resolved against `root` with symlinks followed — is
 * matched too, so an in-project symlink pointing at `.git`/a dotfile can't
 * smuggle a write past the backstop (file tools aren't OS-sandboxed; this
 * check is their only guard).
 *
 * The canonical form is judged *project-relative* when it lands inside the
 * project: a project that itself lives under a directory named e.g.
 * `node_modules` (debugging a dependency in place) must not have every write
 * blocked just because the project's own absolute path contains a protected
 * segment. Targets resolving outside the project are judged by their full
 * canonical path.
 */
export function isProtectedWrite(root: string, p: string): boolean {
  if (isProtectedPath(p)) return true;
  const target = canonicalize(path.resolve(root, p));
  const realRoot = canonicalize(root);
  const rel = path.relative(realRoot, target);
  const inProject = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  return isProtectedPath(inProject ? rel : target);
}
