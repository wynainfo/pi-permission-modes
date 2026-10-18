/**
 * Windows path utilities for the bash escape heuristic.
 *
 * Under Git Bash on Windows the model's commands name paths the POSIX token
 * scan never recognizes: drive letters (`C:\x`, `c:/x`), backslashes, Git
 * Bash drive mounts (`/c/x`), UNC shares, `~\x`, and PowerShell or cmd
 * variables (`$env:USERPROFILE\x`, `%APPDATA%\x`). `winPathCandidate` resolves
 * such a token to an absolute win32 path so the escape check can judge it;
 * `isOutsideWin` is the lexical, case-insensitive containment test.
 *
 * Pure and SDK-free: every path operation goes through `path.win32` and the
 * environment is injected, so the whole table is unit-tested on any platform.
 * Based on PR #9 by ammoniak.
 */

import path from "node:path";

/** What `winPathCandidate` needs to expand a token: project root, home, env. */
export interface WinPathCtx {
  /** Absolute win32 project root (relative tokens resolve against it). */
  root: string;
  /** The user's home directory (`~`, `$HOME`). */
  home: string;
  /** Environment for `$env:X` / `%X%` / `$X` (looked up case-insensitively). */
  env: Record<string, string | undefined>;
}

/** PowerShell provider prefixes that still address the filesystem. */
const PROVIDER_PREFIX_RE = /^(?:Microsoft\.PowerShell\.Core\\)?FileSystem::/i;

/** A leading variable reference: `${env:X}`, `$env:X`, `${X}`, `$X`, `%X%`, followed by a separator or alone. */
const LEADING_VAR_RE = /^(?:\$\{env:(\w+)\}|\$env:(\w+)|\$\{(\w+)\}|\$(\w+)|%(\w+)%)(?=$|[\\/])/i;

const DRIVE_PATH_RE = /^[a-zA-Z]:[\\/]/;

function lookupEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === want && v) return v;
  }
  return undefined;
}

/** Expand a variable name to a path; HOME and PWD have shell-level meanings. */
function expandVar(name: string, ctx: WinPathCtx): string | undefined {
  const upper = name.toUpperCase();
  if (upper === "PWD") return ctx.root;
  if (upper === "HOME") return ctx.home;
  return lookupEnv(ctx.env, name);
}

/** `/c/Users/x` (Git Bash drive mount) to `C:\Users\x`. */
function fromGitBashDrive(p: string): string {
  const m = /^\/([a-zA-Z])\//.exec(p);
  if (!m) return p;
  return `${m[1].toUpperCase()}:\\${p.slice(m[0].length).replace(/\//g, "\\")}`;
}

/**
 * Resolve a shell token to an absolute win32 path, or undefined when the
 * token is not Windows-shaped or references a variable we cannot expand (the
 * heuristic only flags what it can see; it is not the enforcement).
 *
 * Recognized: drive paths (`C:\x`, `c:/x`), drive-relative (`D:x`), UNC
 * (`\\srv\share`), Git Bash drive paths (`/c/x`), home (`~`, `~\x`, `~/x`),
 * variables (`$env:X`, `${env:X}`, `$X`, `${X}`, `%X%`), and relative paths
 * with a separator or `..`. Other POSIX-absolute tokens (`/tmp/x`) return
 * undefined so the caller's POSIX rules still handle them.
 */
export function winPathCandidate(tok: string, ctx: WinPathCtx): string | undefined {
  let t = tok.replace(/["'`]/g, "").trim();
  if (!t) return undefined;
  t = t.replace(PROVIDER_PREFIX_RE, "");

  const v = LEADING_VAR_RE.exec(t);
  if (v) {
    const name = v[1] ?? v[2] ?? v[3] ?? v[4] ?? v[5];
    const base = expandVar(name, ctx);
    if (!base) return undefined;
    t = base + t.slice(v[0].length);
  } else if (t === "~" || t.startsWith("~\\") || t.startsWith("~/")) {
    t = ctx.home + t.slice(1);
  }

  if (/^\/[a-zA-Z]\//.test(t)) return path.win32.normalize(fromGitBashDrive(t));
  if (t.startsWith("/")) return undefined; // POSIX-absolute: left to the caller
  if (t.startsWith("\\\\")) return path.win32.normalize(t); // UNC
  if (DRIVE_PATH_RE.test(t)) return path.win32.normalize(t);

  const driveRel = /^([a-zA-Z]):(.*)$/.exec(t);
  if (driveRel) {
    const [, drive, rest] = driveRel;
    const rootDrive = /^[a-zA-Z]:/.exec(ctx.root)?.[0].slice(0, 1);
    if (drive.toUpperCase() !== rootDrive?.toUpperCase()) return path.win32.normalize(`${drive}:\\${rest}`);
    return path.win32.resolve(ctx.root, rest);
  }

  if (t.includes("\\") || t.includes("/") || t === "..") return path.win32.resolve(ctx.root, t);
  return undefined;
}

/**
 * Lexical, case-insensitive containment test for absolute win32 paths: true
 * when `target` is neither `root` nor below it. A sibling sharing the root's
 * prefix (`C:\ws\proj2` vs `C:\ws\proj`) is outside, as is another drive.
 */
export function isOutsideWin(root: string, target: string): boolean {
  const rel = path.win32.relative(root.toLowerCase(), target.toLowerCase());
  return rel === ".." || rel.startsWith("..\\") || path.win32.isAbsolute(rel);
}
