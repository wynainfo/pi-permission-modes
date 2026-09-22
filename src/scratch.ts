/**
 * Session scratch directory — the per-session temp folder the agent is told
 * to use for throwaway files, so temporary work lands neither in the project
 * nor on top of whatever else is going on in /tmp.
 *
 * Layout: `<base>/<session-id>/`. The base is `/tmp/pi` on Linux and macOS
 * (macOS canonicalizes it to /private/tmp/pi; the runtime handles both) and
 * `<os.tmpdir()>/pi` elsewhere (Windows has no /tmp — and no OS sandbox, so
 * there the folder is instruction + policy bounds only). PI_PERMISSION_TMPDIR
 * overrides the base (e.g. a noexec /tmp).
 *
 * Sandbox-wise the base is shared by every pi session on the host: it is in
 * the shipped `allowWrite`. Instruction-wise each session gets its own folder:
 * the awareness prompt names it, and TMPDIR points there inside bash — the
 * runtime's CLAUDE_TMPDIR hook for sandboxed commands, the bash tool's spawn
 * hook for unsandboxed ones.
 *
 * The session folder is ALWAYS sandbox-writable and in-bounds — appended to
 * the active profile by `withScratchDir` — even when a global or project
 * config drops the shared base from `allowWrite`: the instruction to use it
 * must stay truthful. Keyed on pi's session id, a resumed session finds its
 * earlier scratch files; nothing is deleted at shutdown (/reload and resume
 * would lose their files). Instead `sweepScratchDirs` removes sibling folders
 * untouched for SCRATCH_MAX_AGE_MS at every session start, and the current
 * folder is touched on start so a long-lived session isn't swept by a peer.
 *
 * Platform and env are injected so the naming rules unit-test on any OS; only
 * ensure/sweep touch the filesystem, and both are best-effort (never throw).
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SandboxProfile } from "./schema.ts";

/** Env var overriding the scratch base directory. */
export const SCRATCH_BASE_ENV = "PI_PERMISSION_TMPDIR";

/** Sibling session folders untouched this long are removed at session start. */
export const SCRATCH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The shared scratch base for this platform (or the env override). */
export function scratchBase(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[SCRATCH_BASE_ENV]?.trim();
  if (override) return path.resolve(override);
  return platform === "linux" || platform === "darwin" ? "/tmp/pi" : path.join(os.tmpdir(), "pi");
}

/**
 * Folder name for a session: the session id reduced to a safe charset (no
 * separators, no leading dots), or a pid+time name when there is no id.
 */
export function scratchDirName(sessionId: string | undefined, fallback: () => string = () => `${process.pid}-${Date.now().toString(36)}`): string {
  const safe = (sessionId ?? "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "");
  return safe || fallback();
}

/**
 * Create the session folder (mode 0700) and, when the base is one of ours and
 * doesn't exist yet, the base too — sticky and world-writable like /tmp, so
 * other users on the host can create their own session folders beside it
 * (`sharedBase:false` for a user-overridden base: plain mkdir, no chmod).
 * Touches the folder so the age sweep sees it as live. Returns false when
 * the folder can't be created; nothing throws.
 */
export function ensureScratchDir(dir: string, opts: { sharedBase?: boolean } = {}): boolean {
  try {
    const base = path.dirname(dir);
    if (!existsSync(base)) {
      mkdirSync(base, { recursive: true });
      if (opts.sharedBase) {
        try {
          chmodSync(base, 0o1777);
        } catch {
          // Windows / unsupported: ignore
        }
      }
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700); // umask-proof
    } catch {
      // Windows / unsupported: ignore
    }
    const now = new Date();
    utimesSync(dir, now, now);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove sibling session folders under `base` whose mtime is older than
 * `maxAgeMs`, skipping `keep` (the current session), files, and symlinks (not
 * ours — never follow them). Best-effort per entry (another user's folder or
 * a race just skips). Returns the names removed.
 */
export function sweepScratchDirs(
  base: string,
  keep: string,
  opts: { maxAgeMs?: number; now?: number } = {},
): string[] {
  const maxAge = opts.maxAgeMs ?? SCRATCH_MAX_AGE_MS;
  const now = opts.now ?? Date.now();
  const keepName = path.basename(keep);
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (name === keepName) continue;
    const p = path.join(base, name);
    try {
      const st = lstatSync(p);
      if (!st.isDirectory()) continue;
      if (now - st.mtimeMs < maxAge) continue;
      rmSync(p, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // permission / race: leave it
    }
  }
  return removed;
}

/**
 * The active profile with the session scratch folder appended to `allowWrite`
 * — the "effective" profile the sandbox is initialized with, the bounds are
 * computed from, and `/sandbox` displays. Unchanged when the mode doesn't
 * sandbox (its allowWrite is meaningless) or there is no scratch folder.
 */
export function withScratchDir(profile: SandboxProfile, dir: string | undefined): SandboxProfile {
  if (!dir || !profile.enabled) return profile;
  const allowWrite = profile.allowWrite ?? [];
  if (allowWrite.includes(dir)) return profile;
  return { ...profile, allowWrite: [...allowWrite, dir] };
}
