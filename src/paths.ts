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

import { lstatSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome } from "./resolve.ts";
import type { SandboxProfile } from "./schema.ts";

/** Device pseudo-files that are "outside" the project but harmless to allow. */
export const SAFE_OUTSIDE_RE = /^\/dev\/(null|zero|stdin|stdout|stderr|tty|urandom|random)$/;

/** Directory names that are protected anywhere in a path (compared case-insensitively). */
const PROTECTED_DIRS = [".git", "node_modules", ".vscode", ".idea"];
/**
 * Basenames that are protected (shell rc, VCS/npm config, direnv). Mirrors the
 * sandbox-runtime mandatory-deny set plus `.envrc`, which direnv executes on
 * `cd`. Compared case-insensitively: on case-insensitive filesystems (macOS,
 * Windows) `.GIT` IS `.git`, and blocking a same-named directory on Linux is
 * harmless.
 */
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
  ".envrc",
]);

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Normalize a model-supplied file-tool path the way pi's own read/write/
 * edit/ls/grep/find do before opening it (`resolveToCwd` in pi's utils):
 * unicode spaces to plain spaces, a leading `@` stripped, `~`/`~/…` expanded
 * to the home directory, `file://` URLs turned into paths. The guards here
 * must judge the SAME path pi opens: before this, `read ~/.ssh/id_rsa`
 * resolved lexically to `<project>/~/.ssh/id_rsa` (inside, missing) while pi
 * read the real file, and `write @.env` slipped past the protected-path
 * backstop. A NUL byte is kept as is; the dispatcher blocks such paths.
 */
export function normalizeToolPath(raw: string): string {
  let p = raw.replace(UNICODE_SPACES, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) return path.join(os.homedir(), p.slice(2));
  if (/^file:\/\//.test(p)) {
    try {
      return fileURLToPath(p);
    } catch {
      return p; // malformed URL: judged as written (pi would fail to open it)
    }
  }
  return p;
}

/** True when a `path.relative` result denotes the base itself or something under it (`..foo` is a child, not an escape). */
const relInside = (rel: string): boolean => rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));

/**
 * Canonicalize a path by resolving symlinks on its longest existing prefix and
 * appending the remaining (not-yet-created) tail verbatim. A DANGLING symlink
 * on the way is followed to where it points (readlink) rather than treated as
 * a plain missing name: otherwise an in-project link to a not-yet-existing
 * outside path would be judged inside, and a write through it would create
 * the target outside the project. Never throws for missing paths - falls
 * back to the lexical resolution; symlink chains are bounded.
 */
function canonicalize(p: string): string {
  let current = path.resolve(p);
  const tail: string[] = [];
  for (let hops = 0; hops < 40; hops++) {
    try {
      const real = realpathSync(current);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      try {
        if (lstatSync(current).isSymbolicLink()) {
          // The name exists but its target doesn't: continue from the target.
          current = path.resolve(path.dirname(current), readlinkSync(current));
          continue;
        }
      } catch {
        // not a symlink (or unreadable): treat as a missing name below
      }
      const parent = path.dirname(current);
      if (parent === current) return tail.length ? path.join(current, ...tail) : current;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
  return tail.length ? path.join(current, ...tail) : current;
}

/** True when canonical `target` is `dir` itself or nested under it. */
function isWithin(dir: string, target: string): boolean {
  return relInside(path.relative(canonicalize(dir), target));
}

/**
 * True when `p`, resolved against `root` (with symlinks followed), escapes the
 * project directory AND every directory in `alsoInside` — the mode's
 * sandbox-writable roots (see `sandboxAllowedRoots`), which count as
 * in-bounds: a temp dir the sandbox already lets bash write to is not an
 * escape, so it neither prompts nor runs unsandboxed. Empty/undefined paths
 * are treated as in-project (tools default to cwd).
 */
export function isOutside(root: string, p?: string, alsoInside: readonly string[] = []): boolean {
  if (!p) return false;
  const target = canonicalize(path.resolve(root, p));
  if (isWithin(root, target)) return false;
  return !alsoInside.some((dir) => isWithin(dir, target));
}

/** True when `p` resolved against `root` is inside it WITHOUT following symlinks. */
function isLexicallyInside(root: string, p: string): boolean {
  return relInside(path.relative(path.resolve(root), path.resolve(root, p)));
}

/**
 * The bash-token variant of `isOutside`: an in-project path whose symlink
 * target is an EXECUTABLE FILE outside the project - a venv's `bin/python`
 * (a symlink to the system interpreter), a tool shim - is not an escape.
 * Running it is exactly what the project intends, and the OS sandbox still
 * governs what it may touch; treating it as an escape prompted on every
 * in-project Python run and, once approved, ran it UNSANDBOXED. Symlinks to
 * directories or to non-executable files (a link to /etc, to ~/.bashrc)
 * still count as escapes, as do dangling links and every path that is
 * outside lexically.
 */
export function bashPathEscapes(root: string, p: string, alsoInside: readonly string[] = []): boolean {
  if (!isOutside(root, p, alsoInside)) return false;
  if (!isLexicallyInside(root, p)) return true;
  try {
    const st = statSync(path.resolve(root, p)); // follows the link
    if (st.isFile() && (st.mode & 0o111) !== 0) return false;
  } catch {
    // dangling or unreadable link: judge it by where it points
  }
  return true;
}

/** Canonical absolute form of `p` resolved against `root` (symlinks followed, dangling links too). */
export function canonicalPath(root: string, p: string): string {
  return canonicalize(path.resolve(root, p));
}

/** Top-level locations a session block must never cover (masking them would break the machine or the project). */
const UNBLOCKABLE = ["/", "/tmp", "/private", "/private/tmp", "/usr", "/etc", "/var", "/opt", "/home", "/Users", "/bin", "/sbin", "/lib", "/lib64", "/dev", "/proc", "/sys", "/run"];

/**
 * The canonical path a user may block for the session after denying an
 * escape to `p`, or undefined when blocking it would be unsafe or pointless:
 * the root or a top-level system directory, any direct child of `/`, the
 * home directory itself, an ancestor (or equal) of the project root or of a
 * sandbox-writable root (`alsoInside`), a path already covered by `denyRead`,
 * or a path inside the project (not an escape). A denied `cd ~` must never
 * mask the home; a denied `cat ~/secret.txt` should mask exactly that file.
 */
export function blockablePath(
  root: string,
  p: string,
  opts: { alsoInside?: readonly string[]; denyRead?: readonly string[]; allowRead?: readonly string[] } = {},
): string | undefined {
  const target = canonicalPath(root, p);
  const home = canonicalize(os.homedir());
  if (target === home || UNBLOCKABLE.some((u) => target === u || target === canonicalize(u))) return undefined;
  if (path.dirname(target) === path.parse(target).root) return undefined; // a direct child of "/"
  const realRoot = canonicalize(root);
  if (relInside(path.relative(realRoot, target))) return undefined; // inside the project: not an escape
  if (relInside(path.relative(target, realRoot))) return undefined; // ancestor of the project
  for (const r of opts.alsoInside ?? []) {
    if (relInside(path.relative(target, canonicalize(path.resolve(root, expandHome(r)))))) return undefined; // ancestor of a writable root
  }
  // An allowRead entry re-exposes what a denyRead above it hides: a path
  // under one is readable (blockable, a deeper deny wins), an ancestor of one
  // could not be masked completely (like an ancestor of a writable root).
  const allowRead = (opts.allowRead ?? []).map((a) => canonicalize(path.resolve(root, expandHome(a))));
  if (allowRead.some((a) => a !== target && relInside(path.relative(target, a)))) return undefined;
  const reExposed = allowRead.some((a) => a === target || relInside(path.relative(a, target)));
  for (const d of opts.denyRead ?? []) {
    if (!reExposed && relInside(path.relative(canonicalize(expandHome(d)), target))) return undefined; // already masked
  }
  return target;
}

/** Render a path with the home directory as `~` (for prompts and notices). */
export function displayPath(p: string): string {
  const home = os.homedir();
  return p === home ? "~" : p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

/**
 * Temp dir the sandbox runtime allows writes to unconditionally, on top of a
 * profile's `allowWrite` (it also points TMPDIR there inside sandboxed
 * commands; macOS canonicalizes /tmp to /private/tmp). Its other built-ins
 * (~/.npm/_logs, ~/.claude/debug) stay prompt-gated — nothing targets them
 * deliberately.
 */
export const SANDBOX_RUNTIME_TMP_PATHS = ["/tmp/claude", "/private/tmp/claude"];

/**
 * The directories a sandboxed mode lets bash write to, as absolute paths: the
 * profile's `allowWrite` entries (`.`/relative resolved against `root`,
 * `~`/`$HOME` expanded, glob entries skipped — the Linux runtime drops those
 * too) plus the runtime's own temp dir. They are the extra in-bounds roots for
 * the bash escape detector and the file-tool project boundary, so `/tmp/...`
 * stops prompting as "outside project" while the sandbox permits it anyway.
 * Empty when the mode doesn't sandbox (`enabled:false`): its `allowWrite` is
 * then meaningless and the mode's `external_directory` policy alone applies.
 * `writable:false` (Plan) still counts — reads there are fine and the sandbox
 * blocks writes itself, exactly as it does in-project.
 */
export function sandboxAllowedRoots(root: string, profile: SandboxProfile): string[] {
  if (!profile.enabled) return [];
  const out: string[] = [];
  for (const raw of [...(profile.allowWrite ?? []), ...SANDBOX_RUNTIME_TMP_PATHS]) {
    if (/[*?[\]{}]/.test(raw)) continue;
    const abs = path.resolve(root, expandHome(raw));
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
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
 * The OS sandbox write-protects a fixed set of dotfiles/dirs at the project
 * root (the runtime's mandatory-deny list: its `DANGEROUS_FILES` +
 * `DANGEROUS_DIRECTORIES` + the `.claude/{commands,agents}` denies). When such
 * a path is ABSENT, the runtime denies it by mounting `/dev/null` over the
 * first missing component, and because the project is writable in
 * Default/Build, bubblewrap materializes that mountpoint as a 0-byte,
 * read-only file that survives teardown. The runtime removes its own mount
 * points after every run (`cleanupAfterCommand`); this list is the fallback
 * sweep for what a pi that died mid-command left behind (a stale `.git`
 * would break the next run).
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
 * Only removes a path that is a **0-byte regular file** - a legitimate version
 * of any of these is a directory (`.git`, `.vscode`, `.idea`, `.claude`) or a
 * non-empty file (`.gitmodules`, `.mcp.json`, shell rc files), so real files and
 * dirs are never touched. Called at init and around each sandboxed run as the
 * crash fallback (the runtime cleans up after itself); best-effort.
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
 * True when `p` is a Markdown file inside the project's `plan/` directory — the
 * files Plan Mode writes and `show_plan` renders. Lexical (no realpath); this is
 * a UI-routing predicate, not a security boundary.
 */
export function isPlanFile(root: string, p?: string): boolean {
  if (!p || !isMarkdown(p)) return false;
  const rel = path.relative(path.resolve(root, "plan"), path.resolve(root, p));
  return rel !== "" && relInside(rel);
}

/**
 * True when a write target is a protected path. Segment-aware (not a loose
 * substring): matches protected directory names anywhere in the path, `.env`
 * and `.env.*` files, known dotfiles, and `.claude/{commands,agents}`.
 * Purely lexical — see `isProtectedWrite` for the symlink-resolving backstop.
 */
export function isProtectedPath(p: string): boolean {
  const segments = p
    .split(/[/\\]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
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
  return isProtectedPath(relInside(rel) ? rel : target);
}
