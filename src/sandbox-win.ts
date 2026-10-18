/**
 * Pure helpers for the native Windows sandbox backend (sandbox-runtime's
 * `srt-win`, which runs commands as the dedicated local user `srt-sandbox`).
 *
 * That backend only ADDS permission entries for the sandbox user, so it is
 * only as tight as the ACLs already on the machine. A folder created at a
 * drive root inherits `Authenticated Users: Modify`, which the sandbox user
 * holds too, and a project parent the sandbox user cannot stat makes git
 * fail. The controller runs `probeScript` inside the sandbox before trusting
 * it and degrades to prompting on either finding.
 *
 * SDK-free and platform-independent (`path.win32`, injected env, exists and
 * exec), so it unit-tests on any host.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { docRef } from "./docs.ts";
import { isOutsideWin } from "./win-paths.ts";

/**
 * Where the `srt-win.exe` helper is staged: `%LOCALAPPDATA%\pi-permission-modes\
 * srt-win-<hash>\`. The folder name carries the helper's content hash, so a
 * staged copy is reused only when it is byte-identical to the bundled one.
 */
export function stagedSrtWinPath(localAppData: string, bundledExe: string, content: Buffer): string {
  const tag = createHash("sha256").update(content).digest("hex").slice(0, 12);
  return path.win32.join(localAppData, "pi-permission-modes", `srt-win-${tag}`, path.win32.basename(bundledExe));
}

/**
 * Stage the bundled `srt-win.exe` where the sandbox user can launch it but
 * nothing inside the sandbox can change it. The runtime spawns the helper a
 * second time AS the sandbox user (its runner hop), so the sandbox user must
 * be able to read it; the bundled copy sits under the extension's
 * `node_modules`, which is inside the user profile and, when the extension
 * repository itself is the project, inside a write grant. The staged folder
 * stays in the profile (no other account can plant files there) and gets one
 * extra ACE: read and execute for Users; the sandbox user reaches it through
 * its bypass-traverse right. The copy is made by the real user, so staging
 * protects the helper from the sandbox, not the bundle from the extension's
 * own install. Returns the staged path.
 */
export function stageSrtWin(bundledExe: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!env.LOCALAPPDATA) throw new Error("cannot stage srt-win: LOCALAPPDATA is not set");
  const content = readFileSync(bundledExe);
  const staged = stagedSrtWinPath(env.LOCALAPPDATA, bundledExe, content);
  if (existsSync(staged) && readFileSync(staged).equals(content)) return staged;
  const dir = path.win32.dirname(staged);
  mkdirSync(dir, { recursive: true });
  execFileSync("icacls", [dir, "/grant", "*S-1-5-32-545:(OI)(CI)RX"], { windowsHide: true, stdio: "ignore" });
  copyFileSync(bundledExe, staged);
  return staged;
}

/**
 * Locate a Git Bash `bash.exe` the sandbox user can run. Candidates come from
 * `git.exe` directories on PATH (`<Git>\cmd`, `<Git>\bin`, `<Git>\mingw64\bin`),
 * then the Program Files defaults. Installs under the user profile count only
 * when `profileReadable` says the applied profile grants the profile read
 * access; otherwise the sandbox user cannot open them. System32's WSL
 * `bash.exe` is never a candidate.
 */
export function findGitBash(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
  profileReadable = false,
): string | undefined {
  const candidates: string[] = [];
  for (const dir of (env.PATH ?? env.Path ?? "").split(";")) {
    if (dir && exists(path.win32.join(dir, "git.exe"))) {
      candidates.push(path.win32.resolve(dir, "..", "bin", "bash.exe"), path.win32.resolve(dir, "..", "..", "bin", "bash.exe"));
    }
  }
  for (const pf of [env.ProgramFiles, env.ProgramW6432]) {
    if (pf) candidates.push(path.win32.join(pf, "Git", "bin", "bash.exe"));
  }
  const profile = env.USERPROFILE;
  const usable = (c: string): boolean => profileReadable || !profile || isOutsideWin(profile, c);
  return candidates.find((c) => exists(c) && usable(c));
}

/**
 * The host user's git `user.name` and `user.email` as seen from `cwd`
 * (undefined when unset). The sandboxed command runs with the sandbox user's
 * profile, so it never sees the host's `~/.gitconfig`; the launcher exports
 * the identity instead (`gitIdentityEnv`).
 */
export function readGitIdentity(
  cwd: string,
  run: (args: string[]) => string = (args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }),
): { name?: string; email?: string } {
  const get = (key: string): string | undefined => {
    try {
      return run(["config", "--get", key]).trim() || undefined;
    } catch {
      return undefined;
    }
  };
  return { name: get("user.name"), email: get("user.email") };
}

/** Environment carrying the host git identity into the sandbox (empty when unset). */
export function gitIdentityEnv(name?: string, email?: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (name) {
    env.GIT_AUTHOR_NAME = name;
    env.GIT_COMMITTER_NAME = name;
  }
  if (email) {
    env.GIT_AUTHOR_EMAIL = email;
    env.GIT_COMMITTER_EMAIL = email;
  }
  return env;
}

/**
 * Folders that must NOT be writable from inside the sandbox: the project's
 * parent (sibling projects), the drive root, and the folder holding the
 * staged `srt-win.exe` (a writable helper would let the sandbox rewrite the
 * program that launches it).
 */
export function probeTargets(cwd: string, srtWinExe: string): string[] {
  const norm = (p: string) => path.win32.normalize(p);
  const root = path.win32.parse(norm(cwd)).root;
  const targets = [path.win32.dirname(norm(cwd)), root, path.win32.dirname(norm(srtWinExe))];
  return [...new Set(targets.map(norm))];
}

const PROBE_TAG = "PI-SRT-PROBE";
const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const bashPath = (p: string): string => p.replace(/\\/g, "/");

/**
 * Bash script run inside the sandbox: reports each target it can create a
 * file in, and whether it can stat the project's parent (git needs to).
 */
export function probeScript(cwd: string, targets: string[], nonce: string): string {
  const lines: string[] = [];
  const parent = path.win32.dirname(path.win32.normalize(cwd));
  if (parent !== path.win32.normalize(cwd)) {
    lines.push(`ls -ld ${sq(bashPath(parent))} >/dev/null 2>&1 || echo ${sq(`${PROBE_TAG} HIDDEN ${parent}`)}`);
  }
  for (const t of targets) {
    const f = bashPath(path.win32.join(t, `.pi-srt-probe-${nonce}`));
    lines.push(`if ( : > ${sq(f)} ) 2>/dev/null; then rm -f ${sq(f)}; echo ${sq(`${PROBE_TAG} WRITABLE ${t}`)}; fi`);
  }
  lines.push(`echo ${PROBE_TAG} DONE`);
  return lines.join("\n");
}

export interface ProbeResult {
  /** The probe ran to completion. */
  done: boolean;
  /** Targets the sandbox user could create files in. */
  writable: string[];
  /** The project's parent, when the sandbox user cannot stat it. */
  hiddenParent?: string;
}

export function parseProbe(output: string): ProbeResult {
  const result: ProbeResult = { done: false, writable: [] };
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(PROBE_TAG + " ")) continue;
    const rest = line.slice(PROBE_TAG.length + 1);
    if (rest === "DONE") result.done = true;
    else if (rest.startsWith("WRITABLE ")) result.writable.push(rest.slice("WRITABLE ".length));
    else if (rest.startsWith("HIDDEN ")) result.hiddenParent = rest.slice("HIDDEN ".length);
  }
  return result;
}

/** Footer-sized reason the probe rejects the sandbox, or undefined when it passes. */
export function probeProblem(r: ProbeResult): string | undefined {
  if (!r.done) return "Windows sandbox self-check did not complete";
  if (r.writable.length) return `Windows sandbox off: ${r.writable.join(", ")} writable by the sandbox user`;
  if (r.hiddenParent) return `Windows sandbox off: sandbox user can't see ${r.hiddenParent} (git would fail)`;
  return undefined;
}

/** Longer explanation plus fix for a failed probe, for the one-time notification. */
export function probeAdvice(r: ProbeResult): string {
  const ref = `see ${docRef("windowsSelfCheck")}`;
  if (!r.done) return `The Windows sandbox self-check did not complete; ${ref}. Bash asks before every command.`;
  if (r.writable.length) {
    return (
      `The sandbox user can write to ${r.writable.join(", ")}. The Windows sandbox only adds permissions for ` +
      "its own user, and a folder created at a drive root grants every local user Modify rights, so sibling " +
      `projects (or the sandbox helper itself) would be writable. Tighten the folder's ACL or move the project; ${ref}. ` +
      "Until then bash asks before every command."
    );
  }
  if (r.hiddenParent) {
    return (
      `The sandbox user can't read ${r.hiddenParent}, so git and other tools fail inside the sandbox. ` +
      `The mode's profile grants no read access to the folders above the project; add the parent to sandbox.allowRead or move the project; ${ref}. ` +
      "Until then bash asks before every command."
    );
  }
  return `The Windows sandbox self-check passed; ${ref}.`;
}
