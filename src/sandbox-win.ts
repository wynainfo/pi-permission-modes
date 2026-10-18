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
import type { SandboxProfile } from "./schema.ts";
import { isOutsideWin } from "./win-paths.ts";

const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
/** A Windows path as Git Bash reads it (`C:/dir/file`). */
export const bashPath = (p: string): string => p.replace(/\\/g, "/");

/**
 * Where the `srt-win.exe` helper is staged: `%LOCALAPPDATA%\pi-permission-modes\
 * srt-win-<hash>\`. The folder name carries the hash of the helper's content
 * and of the grantee, so a staged copy is reused only when it is byte-identical
 * to the bundled one and carries the same permission entry.
 */
export function stagedSrtWinPath(localAppData: string, bundledExe: string, content: Buffer, grantee = USERS_SID): string {
  const tag = createHash("sha256").update(content).update(`\0${grantee}`).digest("hex").slice(0, 12);
  return path.win32.join(localAppData, "pi-permission-modes", `srt-win-${tag}`, path.win32.basename(bundledExe));
}

/** `BUILTIN\Users`, the grantee when the sandbox user's own SID is not known yet. */
export const USERS_SID = "*S-1-5-32-545";

/**
 * Give `grantee` (an account SID with a leading `*`, or a name) read and
 * execute on `dir` and everything created in it, once per process and pair.
 * Used for the staged helper and the command-file directory: both live in the
 * user profile, which the sandbox user cannot open otherwise.
 */
const granted = new Set<string>();
export function grantReadExecute(
  dir: string,
  grantee: string,
  run: (args: string[]) => void = (args) => {
    execFileSync("icacls", args, { windowsHide: true, stdio: "ignore" });
  },
): void {
  const key = `${dir.toLowerCase()}|${grantee.toLowerCase()}`;
  if (granted.has(key)) return;
  run([dir, "/grant", `${grantee}:(OI)(CI)RX`]);
  granted.add(key);
}

/**
 * Stage the bundled `srt-win.exe` where the sandbox user can launch it but
 * nothing inside the sandbox can change it. The runtime spawns the helper a
 * second time AS the sandbox user (its runner hop), so the sandbox user must
 * be able to read it; the bundled copy sits under the extension's
 * `node_modules`, which is inside the user profile and, when the extension
 * repository itself is the project, inside a write grant. The staged folder
 * stays in the profile (no other account can plant files there) and gets one
 * extra ACE: read and execute for the sandbox user (`grantee`, its SID); it
 * reaches the folder through its bypass-traverse right. The copy is made by the real user, so staging
 * protects the helper from the sandbox, not the bundle from the extension's
 * own install. Returns the staged path.
 */
export function stageSrtWin(bundledExe: string, grantee = USERS_SID, env: NodeJS.ProcessEnv = process.env): string {
  if (!env.LOCALAPPDATA) throw new Error("cannot stage srt-win: LOCALAPPDATA is not set");
  const content = readFileSync(bundledExe);
  const staged = stagedSrtWinPath(env.LOCALAPPDATA, bundledExe, content, grantee);
  if (existsSync(staged) && readFileSync(staged).equals(content)) return staged;
  const dir = path.win32.dirname(staged);
  mkdirSync(dir, { recursive: true });
  grantReadExecute(dir, grantee);
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
 * Variables the sandbox provides itself, so the caller's values must not
 * travel: the sandbox user's identity and profile paths (the child runs as
 * another account, with its own profile), the temp dirs (set to the scratch
 * dir instead), PATH and PATHEXT (the runtime passes the broker's), the proxy
 * and CA variables (the runtime's point at its proxy; the caller's would send
 * traffic around it or break TLS), and the runtime's own git settings.
 * Compared case-insensitively, as Windows does.
 */
export const WIN_ENV_EXCLUDE = new Set(
  [
    "USERNAME", "USERDOMAIN", "USERDOMAIN_ROAMINGPROFILE", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOMESHARE", "HOME",
    "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC",
    "LOGONSERVER", "SESSIONNAME", "PWD", "OLDPWD", "SHLVL", "_",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "FTP_PROXY", "NO_PROXY",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO",
    "REQUESTS_CA_BUNDLE", "CARGO_HTTP_CAINFO", "PIP_CERT", "NPM_CONFIG_CAFILE", "DENO_CERT", "AWS_CA_BUNDLE",
  ].map((n) => n.toUpperCase()),
);
const WIN_ENV_EXCLUDE_PREFIXES = ["GIT_CONFIG_", "SRT_"];
const BASH_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `NAME='value'` tokens carrying the caller's environment into the sandbox,
 * minus `WIN_ENV_EXCLUDE`; `extra` (the git identity, the temp dirs) comes
 * last and wins. Names bash cannot export (`ProgramFiles(x86)`) are skipped.
 */
export function windowsEnvExports(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): string[] {
  const out = new Map<string, string>();
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !BASH_NAME_RE.test(name)) continue;
    const upper = name.toUpperCase();
    if (WIN_ENV_EXCLUDE.has(upper) || WIN_ENV_EXCLUDE_PREFIXES.some((p) => upper.startsWith(p))) continue;
    out.set(name, value);
  }
  for (const [name, value] of Object.entries(extra)) if (BASH_NAME_RE.test(name)) out.set(name, value);
  return [...out].map(([n, v]) => `${n}=${sq(v)}`);
}

/** Characters a path cannot have inside the script's quoting (see `windowsScript`). */
const SCRIPT_UNSAFE = /['!"$`\\\r\n]/;

/**
 * The script the inner Git Bash runs. With files: source the env file, then
 * run the command file as a `bash -c` script of its own, so the command keeps
 * the semantics of pi's own bash tool (same $0, same "bash: line N" error
 * prefixes, same exit status) and never meets a quoting pass or a command
 * line limit. Without files, or when a path contains a character the quoting
 * cannot carry, the exports are inlined ahead of the command text.
 */
export function windowsScript(command: string, files: { env: string; cmd: string } | undefined, exports: readonly string[]): string {
  if (files) {
    const env = bashPath(files.env);
    const cmd = bashPath(files.cmd);
    if (!SCRIPT_UNSAFE.test(env) && !SCRIPT_UNSAFE.test(cmd)) return `. '${env}'; bash -c "$(<"${cmd}")"`;
  }
  return exports.length ? `export ${exports.join(" ")}; ${command}` : command;
}

/** Content of the env file `windowsScript` sources. */
export function windowsEnvFile(exports: readonly string[]): string {
  return exports.map((t) => `export ${t}`).join("\n") + "\n";
}

/** True for a profile entry that names the user profile itself (`~`, `$HOME`, `~/`). */
const isHomeEntry = (p: string): boolean => p === "~" || p === "$HOME" || /^~[\\/]$/.test(p);

/**
 * The Windows default for reads: the sandbox user has no rights on the
 * caller's files, so without a grant nothing of the user profile is readable
 * (no `~/.gitconfig`, no `~/.npmrc`, no per-user tool). Granting `~` read
 * access with the credential `denyRead` list on top gives the Linux result:
 * home readable, secrets masked. Left alone when an `allowRead` entry already
 * names the profile, or when a `denyRead` entry does (the strict-home shape,
 * whose carve-outs are listed explicitly).
 */
export function withHomeRead(profile: SandboxProfile): SandboxProfile {
  if (!profile.enabled) return profile;
  if ((profile.allowRead ?? []).some(isHomeEntry) || (profile.denyRead ?? []).some(isHomeEntry)) return profile;
  return { ...profile, allowRead: ["~", ...(profile.allowRead ?? [])] };
}

/**
 * Inside the fence, schannel cannot fetch revocation lists (the lookup goes
 * out over WinHTTP, past the proxy variables), so git over HTTPS and cargo
 * would fail with CRYPT_E_REVOCATION_OFFLINE. Both read these variables; the
 * caller's own `GIT_CONFIG_PARAMETERS` stay ahead.
 */
export function windowsRevocationEnv(callerEnv: NodeJS.ProcessEnv): Record<string, string> {
  const existing = callerEnv.GIT_CONFIG_PARAMETERS?.trim();
  const param = "'http.schannelCheckRevoke=false'";
  return { GIT_CONFIG_PARAMETERS: existing ? `${existing} ${param}` : param, CARGO_HTTP_CHECK_REVOKE: "false" };
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
