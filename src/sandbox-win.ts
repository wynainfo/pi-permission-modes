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
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { docRef } from "./docs.ts";
import { githubTokenGitParams } from "./git-auth.ts";
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
 * when they sit inside one of `readableRoots` (the applied profile's read and
 * write grants, absolute); otherwise the sandbox user cannot open them.
 * System32's WSL `bash.exe` is never a candidate.
 */
export function findGitBash(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
  readableRoots: readonly string[] = [],
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
  const usable = (c: string): boolean => !profile || isOutsideWin(profile, c) || readableRoots.some((r) => !isOutsideWin(r, c));
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

/**
 * The files git reads as the user's global config on Windows, in git's order
 * (a later file wins): `$XDG_CONFIG_HOME/git/config` or
 * `~/.config/git/config`, then `~/.gitconfig` (`HOME`, else `USERPROFILE`).
 */
export function globalGitConfigSources(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME || env.USERPROFILE;
  if (!home) return [];
  const xdg = env.XDG_CONFIG_HOME || path.win32.join(home, ".config");
  return [path.win32.join(xdg, "git", "config"), path.win32.join(home, ".gitconfig")];
}

/**
 * Copy the user's global git config into `dir` (the command dir, readable by
 * the sandbox account) as one file for `GIT_CONFIG_GLOBAL`: the sandbox
 * account's HOME is its own, so nothing of the user's profile is read
 * otherwise, and the credential helper, `core.autocrlf` and the rest would
 * not apply inside the sandbox as they do on Linux. Returns the copy's path,
 * or undefined when there is no global config.
 */
export function stageGitConfig(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
  fs: { exists: (p: string) => boolean; read: (p: string) => string; write: (p: string, s: string) => void } = {
    exists: existsSync,
    read: (p) => readFileSync(p, "utf8"),
    write: (p, s) => writeFileSync(p, s),
  },
): string | undefined {
  const parts = globalGitConfigSources(env)
    .filter((p) => fs.exists(p))
    .map((p) => `# from ${p}\n${fs.read(p).replace(/\r?\n$/, "")}\n`);
  if (parts.length === 0) return undefined;
  const out = path.join(dir, "gitconfig");
  fs.write(out, `# Your global git config, copied by pi-permission-modes for the sandbox account (GIT_CONFIG_GLOBAL).\n${parts.join("")}`);
  return out;
}

/**
 * Whether the profile masks `~/.gitconfig`: the most specific entry among
 * `denyRead` and `allowRead` that covers it decides, as on Linux. Entries are
 * compared in `~` form (`$HOME` and the expanded profile count as `~`).
 */
export function gitConfigMasked(profile: Pick<SandboxProfile, "denyRead" | "allowRead">, env: NodeJS.ProcessEnv = process.env): boolean {
  const home = (env.USERPROFILE ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const norm = (p: string): string => {
    let s = p.replace(/\\/g, "/").replace(/\/+$/, "");
    if (s === "$HOME" || s.startsWith("$HOME/")) s = `~${s.slice(5)}`;
    const lower = s.toLowerCase();
    if (home && (lower === home || lower.startsWith(`${home}/`))) s = `~${s.slice(home.length)}`;
    return s.toLowerCase();
  };
  const target = "~/.gitconfig";
  const depth = (p: string): number => {
    const d = norm(p);
    return target === d || target.startsWith(`${d}/`) ? d.split("/").length : -1;
  };
  const deepest = (list: readonly string[] | undefined): number => Math.max(-1, ...(list ?? []).map(depth));
  const deny = deepest(profile.denyRead);
  return deny >= 0 && deepest(profile.allowRead) < deny;
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

/**
 * Per-user tool roots the stock profiles grant read access to on Windows,
 * as `%VAR%` templates. The sandbox user has no rights on the caller's
 * files, and an entry on the profile root itself is out of the question:
 * the runtime writes inheriting permission entries, which NTFS copies onto
 * every file below, and a whole profile exceeds the runtime's 60 s limit.
 * So reads are a short list of folders that hold programs installed for the
 * user only. Configuration files in the profile are not listed: HOME inside
 * the sandbox is the sandbox account's, so git, npm and friends would not
 * read them anyway (the git identity travels as environment instead).
 */
/**
 * How an absolute Windows path stands to one entry of the profile read
 * grant's exclusion list (runtime 0.0.81): entries are absolute, may carry
 * the `\\?\` prefix, `*` stands for one name and a trailing `*` for a
 * prefix. Pure: no path is resolved or listed (the runtime does that at
 * initialize, and refuses with `profile_exclusion_read_grant`); this is the
 * cheap answer the session needs for every path of the mode.
 */
export function profileExclusionRelation(abs: string, exclusion: string): "equal" | "inside" | "above" | undefined {
  const parts = (p: string) =>
    p
      .replace(/^\\\\\?\\/, "")
      .toLowerCase()
      .split(/[\\/]+/)
      .filter(Boolean);
  const a = parts(abs);
  const x = parts(exclusion);
  const matches = (name: string, pat: string) => pat === "*" || (pat.endsWith("*") ? name.startsWith(pat.slice(0, -1)) : name === pat);
  const n = Math.min(a.length, x.length);
  for (let i = 0; i < n; i++) if (!matches(a[i], x[i])) return undefined;
  if (a.length === x.length) return "equal";
  return a.length > x.length ? "inside" : "above";
}

/**
 * The deny paths of the global config's sandboxed modes that lie inside the
 * user's profile, absolute: what `/sandbox install` records as exclusions of
 * the profile read grant (runtime 0.0.81). A deny the grant excludes costs a
 * session nothing; one it does not, the runtime writes at every initialize
 * and removes at every reset, several seconds each. Project-relative entries
 * (`./.env`) are left out: an exclusion is machine-wide and lasting. The
 * project overlay is not consulted for the same reason.
 */
export function profileExclusions(modes: Iterable<SandboxProfile>, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.USERPROFILE;
  if (!home) return [];
  const out = new Map<string, string>();
  for (const sb of modes) {
    if (!sb.enabled) continue;
    for (const d of [...(sb.denyRead ?? []), ...(sb.denyWrite ?? [])]) {
      let e = expandWinEnv(d, env);
      if (e === "~" || e.startsWith("~/") || e.startsWith("~\\")) e = home + e.slice(1);
      if (!path.win32.isAbsolute(e)) continue;
      const abs = path.win32.resolve(e);
      if (isOutsideWin(home, abs) || abs.toLowerCase() === home.toLowerCase()) continue;
      if (!out.has(abs.toLowerCase())) out.set(abs.toLowerCase(), abs);
    }
  }
  return [...out.values()];
}

/**
 * The docs section for a runtime error code (`WindowsSandboxError.code`,
 * runtime 0.0.81) when one helps: the install for setup and account
 * states, the loopback and profile sections for theirs. Undefined for codes
 * that explain themselves (a mapped drive, a session that ended).
 */
export function windowsErrorRef(code: string | undefined): string | undefined {
  switch (code) {
    case "reinstall_required":
    case "seclogon_disabled":
    case "install_config_conflict":
    case "kept_grants_in_use":
    case "srt_win_outdated":
      return docRef("windowsInstall");
    case "wfp_loopback_mismatch":
      return docRef("windowsLoopback");
    case "profile_grant_outdated":
    case "profile_grant_failed":
    case "profile_operation_in_progress":
    case "profile_grant_blocked_by_session":
      return docRef("windowsProfile");
    default:
      return undefined;
  }
}

/** Title of the question `/sandbox install` asks before the runtime's profile read grant. */
export const PROFILE_GRANT_QUESTION = "Read your user profile inside the sandbox?";

/**
 * The trade behind the profile read grant, for the install question. The
 * runtime (0.0.81) grants the sandbox account read access to the user's
 * profile minus its exclusion list; the grant is per machine and user, not
 * per project, and takes minutes the first time.
 */
export function profileGrantText(): string {
  return (
    "Yes makes your user profile readable to sandboxed commands, so per-user tools (nvm, pyenv, cargo, go, .NET, VS Code) and feed sign-ins " +
    "(.npmrc, pip, NuGet, Maven, Gradle, .gitconfig) work like outside the sandbox. Credential stores stay unreadable: .ssh, .gnupg, .aws, .azure, .kube, .docker, " +
    ".config\\gh, browser profiles, Windows credential vaults and the local Temp folder.\n\n" +
    "The grant applies to every sandboxed session on this machine, by any project, until /sandbox uninstall. It takes minutes once (one line of progress per folder).\n\n" +
    "No keeps the current behaviour: commands read the project and the known tool roots only. Answer No on a shared machine."
  );
}

export const WINDOWS_TOOL_ROOTS = [
  "%LOCALAPPDATA%\\Programs",
  "%APPDATA%\\npm",
  "%LOCALAPPDATA%\\pnpm",
  "%LOCALAPPDATA%\\Volta",
  "%LOCALAPPDATA%\\fnm_multishells",
  "%LOCALAPPDATA%\\fnm",
  "%APPDATA%\\fnm",
  "%APPDATA%\\nvm",
  "%USERPROFILE%\\scoop",
  "%LOCALAPPDATA%\\Microsoft\\WinGet",
  "%APPDATA%\\Python",
  "%USERPROFILE%\\.pyenv",
  "%LOCALAPPDATA%\\uv",
  "%APPDATA%\\uv",
  "%USERPROFILE%\\.local\\bin",
  "%USERPROFILE%\\go\\bin",
  "%USERPROFILE%\\.dotnet\\tools",
  "%USERPROFILE%\\.bun\\bin",
  "%USERPROFILE%\\.deno\\bin",
  "%USERPROFILE%\\.cargo\\bin",
];

/** `%VAR%` references expanded from `env` (names compared case-insensitively, as Windows does); unknown ones stay. */
export function expandWinEnv(p: string, env: NodeJS.ProcessEnv): string {
  return p.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key !== undefined && env[key] !== undefined ? env[key] : whole;
  });
}

/** The tool roots that exist on this machine, expanded and deduplicated. */
export function windowsReadGrants(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string[] {
  const out: string[] = [];
  for (const t of WINDOWS_TOOL_ROOTS) {
    const p = expandWinEnv(t, env);
    if (p.includes("%") || out.some((o) => o.toLowerCase() === p.toLowerCase())) continue;
    if (exists(p)) out.push(p);
  }
  return out;
}

/**
 * The Windows default for reads: `grants` (see `windowsReadGrants`) become
 * the profile's `allowRead` when the mode sets none. A mode with its own
 * `allowRead` keeps it as written (the strict shape, or a longer list).
 */
export function withWindowsReads(profile: SandboxProfile, grants: readonly string[]): SandboxProfile {
  if (!profile.enabled || profile.allowRead?.length || grants.length === 0) return profile;
  return { ...profile, allowRead: [...grants] };
}

/**
 * Git and cargo settings for the sandbox. Inside the fence, schannel cannot
 * fetch revocation lists (the lookup goes out over WinHTTP, past the proxy
 * variables), so git over HTTPS and cargo would fail with
 * CRYPT_E_REVOCATION_OFFLINE; both read these variables, and the caller's
 * own `GIT_CONFIG_PARAMETERS` stay ahead. Git's libcurl negotiates proxy
 * authentication (a first CONNECT without credentials, a 407, a retry),
 * and the runtime's proxy closes the connection with the 407, which the
 * curl in Git for Windows does not survive ("Proxy CONNECT aborted"), so
 * git is told to send Basic up front, as curl itself does with the
 * credentials in the proxy URL. Git must also fail fast when a remote wants
 * credentials: there is no terminal, and Git Credential Manager runs as the
 * sandbox account, whose store is empty and which cannot show a window, so
 * interactive prompts are turned off (the model is told to recommend a
 * token, as on Linux). Its host-provider detection is off as well: after a
 * request through the authenticated proxy git hands the proxy credentials
 * to the helper to store, and detecting a provider for localhost costs two
 * seconds per git command.
 */
export function windowsGitEnv(callerEnv: NodeJS.ProcessEnv): Record<string, string> {
  const existing = callerEnv.GIT_CONFIG_PARAMETERS?.trim();
  const token = githubTokenGitParams(callerEnv); // a GitHub token in pi's environment: git uses it for github.com (git-auth.ts)
  const param = `'http.schannelCheckRevoke=false' 'http.proxyAuthMethod=basic'${token ? ` ${token}` : ""}`;
  return {
    GIT_CONFIG_PARAMETERS: existing ? `${existing} ${param}` : param,
    CARGO_HTTP_CHECK_REVOKE: "false",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GCM_PROVIDER: "generic",
  };
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

/** The local account the runtime's Windows backend runs commands as. */
export const WINDOWS_SANDBOX_USER = "srt-sandbox";

/** `icacls <dir>` output, or "" when icacls fails (the folder is then judged by the probe alone). */
export function readAcl(dir: string): string {
  try {
    return execFileSync("icacls", [dir], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 15000 });
  } catch {
    return "";
  }
}

/**
 * Whether `icacls` output lists a permission entry for the sandbox account
 * (by name or SID): "explicit" when granted on the folder itself, which is
 * how a running pi session marks its project, "inherited" when it comes from
 * a folder above, undefined when there is none.
 */
export function sandboxAceIn(icaclsOutput: string, sid?: string): "explicit" | "inherited" | undefined {
  const names = [`\\${WINDOWS_SANDBOX_USER}:`.toLowerCase(), ...(sid ? [`${sid.replace(/^\*/, "")}:`.toLowerCase()] : [])];
  let found: "explicit" | "inherited" | undefined;
  for (const line of icaclsOutput.split(/\r?\n/)) {
    const l = line.toLowerCase();
    if (!names.some((n) => l.includes(n))) continue;
    if (!/\(i\)/.test(l)) return "explicit";
    found = "inherited";
  }
  return found;
}

export interface ProbeResult {
  /** The probe ran to completion. */
  done: boolean;
  /** Targets the sandbox user could create files in. */
  writable: string[];
  /** The project's parent, when the sandbox user cannot stat it. */
  hiddenParent?: string;
  /** Writable targets on which the sandbox account already holds a permission entry: another session's sandboxed folder (filled in by the controller). */
  granted?: string[];
  /** The runtime's structured launch error, when the probe could not even start (a mapped-drive or UNC working directory). */
  launchError?: string;
}

/** The line the Windows ops append when srt-win refuses to launch (see createWindowsSandboxedBashOps). */
export const LAUNCH_ERROR_PREFIX = "[permission-mode] sandbox: ";

export function parseProbe(output: string): ProbeResult {
  const result: ProbeResult = { done: false, writable: [] };
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(PROBE_TAG + " ")) continue;
    const rest = line.slice(PROBE_TAG.length + 1);
    if (rest === "DONE") result.done = true;
    else if (rest.startsWith("WRITABLE ")) result.writable.push(rest.slice("WRITABLE ".length));
    else if (rest.startsWith("HIDDEN ")) result.hiddenParent = rest.slice("HIDDEN ".length);
  }
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith(LAUNCH_ERROR_PREFIX)) result.launchError = line.slice(LAUNCH_ERROR_PREFIX.length).trim();
  }
  return result;
}

/**
 * Footer-sized reason the probe rejects the sandbox, or undefined when it
 * passes. A parent the sandbox user cannot read is not a rejection: that
 * makes the sandbox tighter, not weaker (see `probeNotice`).
 */
export function probeProblem(r: ProbeResult): string | undefined {
  if (!r.done && r.launchError) return `Windows sandbox off: ${r.launchError}`;
  if (!r.done) return "Windows sandbox self-check did not complete";
  if (r.granted?.length) return `Windows sandbox off: inside another sandboxed folder (${r.granted.join(", ")})`;
  if (r.writable.length) return `Windows sandbox off: ${r.writable.join(", ")} writable by the sandbox user`;
  return undefined;
}

/** A one-time notice for a probe that passed with a finding worth knowing, or undefined. */
export function probeNotice(r: ProbeResult): string | undefined {
  if (!r.hiddenParent) return undefined;
  return (
    `The sandbox user cannot read ${r.hiddenParent}, the project's parent folder (the mode grants it nothing there). The sandbox is active; ` +
    `should git or another tool fail inside it with a permission error on that path, add the parent to the mode's allowRead or move the project; see ${docRef("windowsSelfCheck")}.`
  );
}

/** Longer explanation plus fix for a failed probe, for the one-time notification. */
export function probeAdvice(r: ProbeResult): string {
  const ref = `see ${docRef("windowsSelfCheck")}`;
  if (!r.done && r.launchError) {
    return (
      `The Windows sandbox could not start a command in this project: ${r.launchError.replace(/\.+$/, "")}. Drive mappings and UNC paths belong to your ` +
      `logon session and the sandbox account has none; work on a local drive (see ${docRef("windowsMappedDrive")}). Until then bash asks before every command.`
    );
  }
  if (!r.done) return `The Windows sandbox self-check did not complete; ${ref}. Bash asks before every command.`;
  if (r.granted?.length) {
    return (
      `The sandbox account already holds permission entries on ${r.granted.join(", ")}: another pi session runs in that folder or in one above it, ` +
      "or an earlier session did not release its grant. A project inside a folder the sandbox may write cannot be kept apart from it " +
      "(Plan mode here could not stop writes that grant allows), so this session does not sandbox. Run pi in one of the two folders, not both; " +
      `a grant no running session holds is released from an administrator prompt with: icacls "${r.granted[0]}" /remove:g ${WINDOWS_SANDBOX_USER} /T ` +
      `(then restart pi); ${ref}. Until then bash asks before every command.`
    );
  }
  if (r.writable.length) {
    return (
      `The sandbox user can write to ${r.writable.join(", ")}. The Windows sandbox only adds permissions for ` +
      "its own user, and a folder created at a drive root grants every local user Modify rights, so sibling " +
      `projects (or the sandbox helper itself) would be writable. Tighten the folder's ACL or move the project; ${ref}. ` +
      "Until then bash asks before every command."
    );
  }
  return `The Windows sandbox self-check passed; ${ref}.`;
}
