/**
 * OS-level sandbox lifecycle for Build mode.
 *
 * Wraps `@anthropic-ai/sandbox-runtime` (loaded lazily so a missing dependency
 * degrades gracefully instead of crashing) behind a small `SandboxController`
 * that owns init / wrap / reset and the readiness state surfaced in the footer.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { docRef } from "./docs.ts";
import { withGitHubTokenHelper } from "./git-auth.ts";
import { type SandboxConfig, profileToConfig, readOnlyOverride } from "./config-load.ts";
import { gitDirsOf } from "./paths.ts";
import { expandHome } from "./resolve.ts";
import { expandWinEnv, findGitBash, gitConfigMasked, gitIdentityEnv, grantReadExecute, LAUNCH_ERROR_PREFIX, parseProbe, probeAdvice, probeNotice, probeProblem, probeScript, probeTargets, readAcl, readGitIdentity, sandboxAceIn, stageGitConfig, stageSrtWin, windowsEnvExports, windowsEnvFile, windowsErrorRef, windowsGitEnv, windowsScript } from "./sandbox-win.ts";
import type { SandboxProfile } from "./schema.ts";
import { isModuleNotFound } from "./util.ts";
import { isOutsideWin } from "./win-paths.ts";

// Real types of the runtime, erased at compile time so a missing dependency
// never breaks loading.
export type SandboxRuntime = typeof import("@anthropic-ai/sandbox-runtime");
type SandboxManagerType = SandboxRuntime["SandboxManager"];

/** This extension's own directory (works wherever it's installed). */
const EXTENSION_DIR = fileURLToPath(new URL("..", import.meta.url));

// ---------------------------------------------------------------------------
// Command transport: keep the command text out of the runtime's shell quoting
// ---------------------------------------------------------------------------
//
// wrapWithSandbox embeds the command in a `bash -c` string that it quotes,
// up to three times over on Linux (eval line, inner script, outer bwrap
// line). Up to sandbox-runtime 0.0.26 that quoter was the npm shell-quote
// package, which escaped `!` as `\!` inside double quotes, so every heredoc,
// `python3 -c '...'`, or `printf` with an exclamation mark reached the
// sandboxed shell corrupted. 0.0.77 ships its own single-quote quoter and
// that bug is gone upstream.
//
// The launcher stays anyway. It never lets the command text near any quoting
// pass, present or future: the command goes into a private file on the host
// side (a directory the sandbox cannot write to, mode 0700/0600) and the
// runtime gets a LAUNCHER that contains neither a single quote nor an
// exclamation mark, so every quoting pass leaves it alone:
//
//   bash -c "$(<"/path/to/cmd")"
//
// It also sets TMPDIR for the run (see commandLauncher) and keeps long
// heredocs clear of bwrap's argument cap, which counts the whole quoted
// command line. The innermost bash reads the file with the `$(<file)` builtin
// and runs the content as an ordinary `bash -c` script: same $0, same
// "bash: line N" error prefixes, same exit status. No `exec`, on purpose -
// the runtime's network bridge runs the command from a shell whose EXIT trap
// stops its socat helpers, and that shell has to stay alive to fire it.

/** Characters that must not appear in a launcher (they'd re-enter the quoting problem). */
const LAUNCHER_UNSAFE = /['!"$`\\]/;

/**
 * The launcher line for a command file, or undefined when the path itself
 * contains characters the launcher can't carry (then the caller falls back
 * to passing the raw command, i.e. the historic behavior). With `tmpdir`,
 * the launcher sets TMPDIR itself: the runtime only injects its own TMPDIR
 * inside the network-proxy env block, so a mode without a proxy would leave
 * bash with pi's TMPDIR instead of the session scratch dir.
 */
export function commandLauncher(file: string, tmpdir?: string): string | undefined {
  if (LAUNCHER_UNSAFE.test(file) || /[\r\n]/.test(file)) return undefined;
  const prefix = tmpdir && !LAUNCHER_UNSAFE.test(tmpdir) && !/[\r\n]/.test(tmpdir) ? `TMPDIR="${tmpdir}" ` : "";
  return `${prefix}bash -c "$(<"${file}")"`;
}

let commandDir: string | undefined;
/**
 * Host-side directory for command files, created once per process with
 * mkdtemp (unique, 0700). Deliberately under /tmp itself rather than
 * os.tmpdir(): a child pi inherits TMPDIR pointing at the parent's scratch
 * dir, which the shipped profiles make sandbox-writable, and a sandboxed
 * command must not be able to rewrite the next command's file.
 */
function commandFileDir(): string | undefined {
  if (commandDir) return commandDir;
  const base = process.platform === "win32" ? os.tmpdir() : "/tmp";
  for (const b of [base, os.tmpdir()]) {
    try {
      commandDir = mkdtempSync(path.join(b, "pi-permission-mode-"));
      return commandDir;
    } catch {
      // try the next base
    }
  }
  return undefined;
}

/**
 * Write `command` to a fresh private file and return its path, or undefined
 * when the file can't be written (read-only temp dir): the caller then passes
 * the raw command instead of failing the run.
 */
export function writeCommandFile(command: string, dir: string | undefined = commandFileDir(), prefix = "cmd"): string | undefined {
  if (!dir) return undefined;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${prefix}-${randomBytes(8).toString("hex")}.sh`);
    writeFileSync(file, command, { mode: 0o600 });
    return file;
  } catch {
    return undefined;
  }
}

/**
 * The first bytes of a run's stderr, kept to recognize a sandbox that could
 * not even start (bubblewrap refused its namespaces) once the child is gone.
 */
class StderrHead {
  private text = "";
  add(chunk: Buffer | string): void {
    if (this.text.length < 4096) this.text += String(chunk).slice(0, 4096 - this.text.length);
  }
  /** A hint for the model/user when bwrap itself failed, else undefined. */
  namespaceHint(): string | undefined {
    // Only when bwrap's own error is the FIRST line: a command that ran
    // (and printed something first) must not get "the command did not run".
    const first = this.text.split("\n", 1)[0];
    if (!/^bwrap: .*(Operation not permitted|Permission denied|No permissions to create)/i.test(first)) return undefined;
    return (
      "\n[permission-mode] sandbox: bubblewrap could not set up its namespaces, so the command did not run. " +
      "On Ubuntu 24.04+ this usually means kernel.apparmor_restrict_unprivileged_userns=1: " +
      `grant userns to /usr/bin/bwrap with an AppArmor profile, or set the sysctl to 0 (see ${docRef("namespaces")}). ` +
      "Nothing ran unsandboxed.\n"
    );
  }
}

/** Runtime errors carry a `.code` (LinuxSandboxProfileError); keep it in the message the caller sees. */
function runError(err: unknown): Error {
  const e = err as { name?: unknown; code?: unknown; message?: unknown } | null;
  if (e && typeof e === "object" && e.name === "LinuxSandboxProfileError" && typeof e.code === "string") {
    return new Error(`sandbox profile error (${e.code}): ${String(e.message)}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** Violation lines for paths the Linux write monitor misreports: writes into bwrap's own /dev and /proc succeed (e.g. /dev/shm). */
const MONITOR_NOISE = /^deny \S+ \/(dev|proc)\//;
/** Network denials the user can still lift (not a deny-list entry or a failed prompt). */
const GRANTABLE_NET_DENY = /^deny network-outbound (.+):\d+ \((user denied|host is not on the allow list)\)$/;

/**
 * The runtime's `<sandbox_violations>` block for one command, cleaned up:
 * the monitor's /dev and /proc noise removed (the block is dropped when
 * nothing else remains), plus the hosts in it the user could grant. Every
 * line in it belongs to this command (attributed by commandId), so the
 * network hint is per command even when pi runs commands in parallel.
 */
export function processViolations(block: string): { block: string; grantableHosts: string[] } {
  const m = /^<sandbox_violations>\r?\n([\s\S]*?)\r?\n?<\/sandbox_violations>$/.exec(block.trim());
  if (!m) return { block: block.trim(), grantableHosts: [] };
  const lines = m[1].split(/\r?\n/).filter((l) => l.trim() && !MONITOR_NOISE.test(l));
  const hosts = new Set<string>();
  for (const l of lines) {
    const h = GRANTABLE_NET_DENY.exec(l);
    if (h) hosts.add(h[1].replace(/^\[|\]$/g, ""));
  }
  return { block: lines.length ? `<sandbox_violations>\n${lines.join("\n")}\n</sandbox_violations>` : "", grantableHosts: [...hosts] };
}

/**
 * After a run: the runtime's violation block for THIS command (filed under
 * `commandId`), and a hint when it refused hosts the user could still allow,
 * so a blocked connection is diagnosable rather than a mystery.
 */
function violationsReporter(SandboxManager: SandboxManagerType, commandId: string, onData: (data: Buffer) => void): () => void {
  return () => {
    let raw = "";
    try {
      raw = SandboxManager.annotateStderrWithSandboxFailures?.(commandId, "")?.trim() ?? "";
    } catch {
      return;
    }
    const { block, grantableHosts } = processViolations(raw);
    if (block) onData(Buffer.from(`\n${block}\n`));
    if (grantableHosts.length > 0) {
      onData(
        Buffer.from(
          `\n[permission-mode] network: connection(s) blocked by the sandbox allowlist: ${grantableHosts.join(", ")}. ` +
            `Request access with the request_network_access tool, or ask the user (/net allow <domain>); see ${docRef("networkAccess")}.\n`,
        ),
      );
    }
  };
}

/**
 * Run a spawned child to completion: stream its output, enforce `timeout`
 * (seconds) and the abort signal through `kill`, then resolve with the exit
 * code once `onClose` has appended what belongs after the output. The
 * violation monitors report over sockets of their own, so `onClose` runs one
 * turn of the loop after the child closed, when events already sent have
 * landed.
 */
function superviseChild(
  child: ChildProcess,
  kill: () => void,
  { onData, signal, timeout }: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number },
  onStderr: (chunk: Buffer) => void,
  onClose: (code: number | null) => void,
): Promise<{ exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (timeout && timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeout * 1000);
    }
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (chunk: Buffer) => {
      onStderr(chunk);
      onData(chunk);
    });
    const onAbort = () => kill();
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) kill(); // aborted between the wrap and the listener
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      setImmediate(() => {
        onClose(code);
        if (signal?.aborted) reject(new Error("aborted"));
        else if (timedOut) reject(new Error(`timeout:${timeout}`));
        else resolve({ exitCode: code });
      });
    });
  });
}

/**
 * BashOperations backed by `SandboxManager.wrapWithSandbox`. An optional
 * `customConfig` overrides the init-time config per command (used to drop write
 * access in Read mode without re-initializing the sandbox).
 */
export function createSandboxedBashOps(
  SandboxManager: SandboxManagerType,
  customConfig?: Partial<SandboxConfig>,
  runOpts: {
    /** TMPDIR for the command (the session scratch dir). NOT taken from pi's env: that is pi's own TMPDIR. */
    tmpdir?: string;
    /** Called once a wrap succeeded; the returned function once the run's cleanup is done (in-flight tracking). */
    onRun?: () => () => void;
  } = {},
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
      if (signal?.aborted) throw new Error("aborted"); // never spawn for a call that is already cancelled
      // No placeholder sweep here: the runtime removes the mount points it
      // plants for absent protected dotfiles once NO sandbox is running any
      // more (cleanupAfterCommand below), and re-covers leftovers of a crashed
      // pi itself. Deleting them from the host while a parallel command runs
      // would detach that command's deny mounts.
      // Command transport (see above): the runtime quotes what we hand it, so
      // hand it a launcher and keep the real command in a file.
      const commandFile = writeCommandFile(command);
      const launcher = commandFile ? commandLauncher(commandFile, runOpts.tmpdir) : undefined;
      // Violations the runtime observes while the command runs (refused
      // writes, denied hosts) are filed under this id; the ORIGINAL command
      // is what they report, not the launcher.
      const commandId = `pi-${randomBytes(8).toString("hex")}`;
      const emitViolations = violationsReporter(SandboxManager, commandId, onData);
      let wrapped: string;
      try {
        // The signal rides into the runtime too (its project scan can take a
        // while on big trees); an abort during the wrap must not start the run.
        wrapped = await SandboxManager.wrapWithSandbox(launcher ?? command, undefined, customConfig as never, signal as never, {
          commandId,
          commandText: command,
        });
      } catch (err) {
        // A wrap that threw released what it held; the runtime must NOT be
        // asked to clean up after it (that would detach a concurrent run's
        // mount points).
        if (commandFile) rmSync(commandFile, { force: true });
        throw runError(err);
      }
      // From here on the runtime holds this run's mount points and profile:
      // cleanupAfterCommand() runs exactly once, after the child is gone,
      // whatever way we leave (normal close, abort/timeout, spawn failure).
      const runDone = runOpts.onRun?.();
      try {
        if (signal?.aborted) throw new Error("aborted");
        const head = new StderrHead();
        const child = spawn("bash", ["-c", wrapped], { cwd, env: withGitHubTokenHelper(env ?? process.env), detached: true, stdio: ["ignore", "pipe", "pipe"] });
        const kill = () => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        };
        // `await` so the finally runs after the child exits, not after the
        // Promise is constructed - otherwise cleanup would race the run.
        return await superviseChild(child, kill, { onData, signal, timeout }, (chunk) => head.add(chunk), (code) => {
          emitViolations();
          if (code !== 0) {
            const hint = head.namespaceHint();
            if (hint) onData(Buffer.from(hint));
          }
        });
      } finally {
        try {
          SandboxManager.cleanupAfterCommand?.();
        } catch {
          // best effort: the runtime's exit handler and its re-covering remain
        }
        runDone?.();
        if (commandFile) rmSync(commandFile, { force: true });
      }
    },
  };
}

export interface WindowsOpsOptions {
  /** Git Bash `bash.exe` the sandbox user can run. */
  bash: string;
  /** Variables set on top of the caller's environment: the host's git identity (the sandbox user has no gitconfig of the host's) and the revocation knobs. */
  extraEnv: Record<string, string>;
  /** TMPDIR, TEMP and TMP inside the command (the session scratch dir). */
  tmpdir?: string;
  /** Paths masked for this command on top of the session's permission entries (per-exec denies are the one per-command filesystem change the Windows backend supports). */
  extraDenyRead?: readonly string[];
  /** Directory for the env and command files, readable by the sandbox user; undefined inlines them into the shell argument. */
  commandDir?: string;
  /** The runtime's parser for srt-win's structured launch errors (a mapped-drive cwd, exit 16). */
  parseError?: (stderr: string) => { message: string; code?: string } | undefined;
}

/** Kill the broker and whatever of its tree this user may end (the sandboxed child itself dies with the runner's job object). */
function killWindowsTree(child: ChildProcess): void {
  if (child.pid && process.platform === "win32") {
    try {
      const tk = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(child.pid)], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
      tk.once("error", () => {});
    } catch {
      // best effort
    }
  }
  child.kill("SIGKILL");
}

/**
 * BashOperations for the native Windows backend: `srt-win exec` starts Git
 * Bash as the `srt-sandbox` user, and the argv is spawned directly, never
 * through a host shell. The runner starts the child from the sandbox user's
 * own profile with only PATH and the proxy variables, so the caller's
 * environment travels in an env file the script sources first (minus the
 * profile, temp, proxy and CA variables the sandbox provides itself) and the
 * command rides in a file, as on Linux.
 */
export function createWindowsSandboxedBashOps(
  SandboxManager: SandboxManagerType,
  opts: WindowsOpsOptions,
  runOpts: { onRun?: () => () => void } = {},
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
      if (signal?.aborted) throw new Error("aborted");
      // TMPDIR in the form msys tools read, TEMP and TMP as Windows programs do.
      const tmp: Record<string, string> = opts.tmpdir ? { TMPDIR: opts.tmpdir.replace(/\\/g, "/"), TEMP: opts.tmpdir, TMP: opts.tmpdir } : {};
      const exports = windowsEnvExports(env ?? process.env, { ...opts.extraEnv, ...tmp });
      const envFile = opts.commandDir ? writeCommandFile(windowsEnvFile(exports), opts.commandDir, "env") : undefined;
      const cmdFile = envFile ? writeCommandFile(command, opts.commandDir) : undefined;
      const files = envFile && cmdFile ? { env: envFile, cmd: cmdFile } : undefined;
      const removeFiles = () => {
        for (const f of [envFile, cmdFile]) if (f) rmSync(f, { force: true });
      };
      const script = windowsScript(command, files, exports);
      const commandId = `pi-${randomBytes(8).toString("hex")}`;
      const emitViolations = violationsReporter(SandboxManager, commandId, onData);
      const extra = opts.extraDenyRead ?? [];
      // Per-exec config carries denies only: a per-exec allow list makes the runtime throw on Windows.
      const customConfig = extra.length > 0 ? { filesystem: { denyRead: [...extra], allowWrite: [], denyWrite: [] } } : undefined;
      let argv: string[];
      let spawnEnv: NodeJS.ProcessEnv;
      try {
        ({ argv, env: spawnEnv } = await SandboxManager.wrapWithSandboxArgv(
          script,
          { exe: opts.bash, args: ["-c"] },
          customConfig as never,
          signal as never,
          cwd,
          { commandId, commandText: command },
        ));
      } catch (err) {
        removeFiles();
        throw runError(err);
      }
      const runDone = runOpts.onRun?.();
      try {
        if (signal?.aborted) throw new Error("aborted");
        let stderr = "";
        const child = spawn(argv[0], argv.slice(1), { cwd, env: spawnEnv, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        return await superviseChild(
          child,
          () => killWindowsTree(child),
          { onData, signal, timeout },
          (chunk) => {
            if (stderr.length < 4096) stderr += String(chunk).slice(0, 4096 - stderr.length);
          },
          (code) => {
            emitViolations();
            if (code !== 0 && opts.parseError) {
              const e = opts.parseError(stderr);
              const ref = e && windowsErrorRef(e.code);
              if (e) onData(Buffer.from(`\n${LAUNCH_ERROR_PREFIX}${e.message}${ref ? ` (see ${ref})` : ""}\n`));
            }
          },
        );
      } finally {
        try {
          SandboxManager.cleanupAfterCommand?.();
        } catch {
          // best effort
        }
        runDone?.();
        removeFiles();
      }
    },
  };
}

/**
 * True when a profile filters network traffic at all: the runtime restricts
 * the network only when `allowedDomains` is DEFINED (an empty list starts the
 * proxy too, so every host goes through the prompt flow; an absent list means
 * unrestricted).
 */
export function networkFiltered(profile: SandboxProfile): boolean {
  return profile.enabled && profile.network?.allowedDomains !== undefined;
}

/**
 * The profile with extra `denyRead` entries (the session's blocked paths, see
 * BlockedPaths): the OS sandbox then masks them for bash. Unchanged when the
 * mode doesn't sandbox or there is nothing to add.
 */
export function withDeniedReads(profile: SandboxProfile, paths: readonly string[]): SandboxProfile {
  if (!profile.enabled || paths.length === 0) return profile;
  const out: SandboxProfile = { ...profile, denyRead: [...new Set([...(profile.denyRead ?? []), ...paths])] };
  // The runtime lets an allowRead entry at or under a denied path win (a
  // carve-out is bound back over the mask), so a block must also close the
  // carve-outs it covers, or blocking ~/.gitconfig under a strict home
  // would change nothing for bash.
  if (profile.allowRead?.length) {
    const blocked = paths.map((b) => path.resolve(expandHome(b)));
    out.allowRead = profile.allowRead.filter((a) => {
      const abs = path.resolve(expandHome(a));
      return !blocked.some((b) => abs === b || abs.startsWith(b + path.sep));
    });
  }
  return out;
}

export interface BashOpsOptions {
  /** Plan mode: no project writes for this command. */
  readOnly?: boolean;
  /** Directories that stay writable in a read-only run (the session scratch dir). */
  keepWritable?: string[];
  /** Paths masked for this command on top of the profile's `denyRead` (the session's "Deny and block" list). */
  extraDenyRead?: readonly string[];
  /** TMPDIR inside the command (the session scratch dir). */
  tmpdir?: string;
}

/**
 * Paths the runtime layer adds to every config on top of the mode profile.
 * They are NOT part of the profile (the bounds, the awareness prompt, and
 * the audit never see them): they exist so the sandbox can run at all.
 */
export interface RuntimeExtras {
  /** Re-opened inside any denyRead: the runtime's own package (its seccomp helper must be executable under a strict-home deny). */
  allowRead: string[];
  /** A worktree's/submodule's git dir and common dir: git must write there (index, refs, objects). */
  allowWrite: string[];
  /** `hooks` and `config` of those git dirs, denied like the runtime denies them for an in-project `.git`. */
  denyWrite: string[];
}

/** The directory the sandbox runtime is installed in, or undefined when it cannot be resolved. */
export function runtimeInstallDir(): string | undefined {
  try {
    return path.dirname(fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime/package.json")));
  } catch {
    return undefined;
  }
}

/** The directory command files are written to (created on first use), for callers that must never mask it. */
export function commandFilesDir(): string | undefined {
  return commandFileDir();
}

/**
 * The extras for a project at `cwd` (see RuntimeExtras). The runtime's own
 * package is re-opened for the Linux seccomp helper only: on Windows it
 * would be a read grant on a folder under the extension install, which
 * `pi update` replaces, and srt-win then refuses to grant the path again
 * ("file_id changed since prior grant").
 */
export function runtimeExtrasFor(cwd: string, runtimeDir: string | undefined = runtimeInstallDir(), platform: string = process.platform): RuntimeExtras {
  const extras: RuntimeExtras = { allowRead: runtimeDir && platform !== "win32" ? [runtimeDir] : [], allowWrite: [], denyWrite: [] };
  // A gitfile at the project root is always write-denied: rewritten to point
  // at a git dir with planted hooks, it would run code at the user's next
  // host-side git command (a normal repo's .git/hooks and .git/config are
  // denied by the runtime; a gitfile is not).
  const gitfile = path.join(cwd, ".git");
  try {
    if (lstatSync(gitfile).isFile()) extras.denyWrite.push(gitfile);
  } catch {
    // absent: nothing to protect (and nothing git would follow)
  }
  const git = gitDirsOf(cwd);
  if (git) {
    for (const d of new Set([git.gitdir, git.commondir])) {
      extras.allowWrite.push(d);
      // hooks and config as for an in-project .git; the pointer files and
      // the per-worktree config so the layout cannot be redirected. Only
      // existing paths: the runtime would plant mount points for absent ones.
      for (const f of ["hooks", "config", "config.worktree", "gitdir", "commondir"]) {
        if (existsSync(path.join(d, f))) extras.denyWrite.push(path.join(d, f));
      }
    }
  }
  return extras;
}

/** `cfg` with the runtime extras folded into its filesystem lists (deduplicated, profile entries first). */
export function withRuntimeExtras(cfg: SandboxConfig, extras: RuntimeExtras | undefined): SandboxConfig {
  if (!extras) return cfg;
  const merge = (a: readonly string[] | undefined, b: readonly string[]): string[] => [...new Set([...(a ?? []), ...b])];
  const fs = { ...cfg.filesystem, allowWrite: merge(cfg.filesystem.allowWrite, extras.allowWrite), denyWrite: merge(cfg.filesystem.denyWrite, extras.denyWrite) };
  const allowRead = merge(cfg.filesystem.allowRead, extras.allowRead);
  return { ...cfg, filesystem: allowRead.length > 0 ? { ...fs, allowRead } : fs };
}

/**
 * The per-command runtime config for `opts`, or undefined when the init-time
 * config applies unchanged. The runtime takes each `filesystem` list
 * WHOLESALE from the per-wrap config when present, so the profile's own
 * lists and the runtime extras are carried along, never replaced by the
 * per-command additions alone.
 */
export function bashCustomConfig(profile: SandboxProfile, opts: BashOpsOptions, extras?: RuntimeExtras): SandboxConfig | undefined {
  const extra = opts.extraDenyRead ?? [];
  if (!opts.readOnly && extra.length === 0) return undefined;
  // Read-only keeps the session scratch dir writable: TMPDIR points there,
  // and a Plan-mode `mktemp` or Python `tempfile` must still work. A
  // worktree's git dirs are NOT kept: read-only means no ref or object
  // writes in the main repository either (git tolerates a failed index
  // refresh, exactly as in a normal repo under Plan).
  const base = withRuntimeExtras(profileToConfig(withDeniedReads(profile, extra)), extras);
  return opts.readOnly ? readOnlyOverride(base, opts.keepWritable ?? []) : base;
}

/** How the caller surfaces warnings (e.g. a TUI notify), only used when there's a UI. */
type Notify = (message: string) => void;

export interface InitOptions {
  cwd: string;
  noSandbox: boolean;
  hasUI: boolean;
  notify: Notify;
  /** The active mode's sandbox profile to initialize the runtime with. */
  profile: SandboxProfile;
  /**
   * Live network ask: called by the runtime's proxy for a host no allow/deny
   * rule matches, WHILE the connection waits. Return true to allow. Undefined
   * keeps the historic silent-deny behavior.
   */
  askHost?: (host: string, port: number | undefined) => Promise<boolean>;
  /**
   * Directories that stay writable when a read-only mode is applied (the
   * session scratch dir). Linux and macOS drop writes per command; Windows
   * applies read-only when the runtime initializes, so it needs the list here.
   */
  keepWritable?: string[];
  /** Host platform (injected in tests); defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Loads the runtime module (injected in tests). */
  loadRuntime?: () => Promise<SandboxRuntime>;
  /** Windows backend hooks (injected in tests). */
  windows?: WindowsHooks;
  /**
   * Quiet time after the last profile change before a mode switch re-inits
   * the runtime. Default 1000 ms on Windows, where a re-init blocks pi for
   * seconds (permission entries are copied over whole trees) and a user
   * cycling through the modes should pay for the last one only; 0 elsewhere.
   */
  switchDelayMs?: number;
}

export interface WindowsHooks {
  /** Environment to read `USERPROFILE`, `LOCALAPPDATA` and PATH from. */
  env?: NodeJS.ProcessEnv;
  /** Locates Git Bash; `readableRoots` are the profile's read and write grants (absolute), the only profile paths the sandbox user can open. */
  findBash?: (readableRoots: string[]) => string | undefined;
  /** Copies `srt-win.exe` where `grantee` can run it; returns the path. */
  stageHelper?: (bundledExe: string, grantee: string) => string;
  /** The host git identity as seen from `cwd`. */
  readIdentity?: (cwd: string) => { name?: string; email?: string };
  /** Directory for command and env files, readable by `grantee`; undefined inlines them. */
  commandDir?: (grantee: string) => string | undefined;
  /** `icacls` output for a folder the probe found writable ("" when unknown). */
  readAcl?: (dir: string) => string;
  /** Copies the user's global git config into the command dir; returns the copy's path. */
  gitConfig?: (commandDir: string | undefined) => string | undefined;
}

/** Footer reason while the Windows backend is not provisioned on this machine. */
export const WINDOWS_NOT_INSTALLED_WARN = "Windows sandbox not installed (/sandbox install)";

/** Windows backend state, present while the runtime drives `srt-win`. */
interface WindowsBackend {
  bash: string;
  srtWinPath: string;
  /** `GIT_AUTHOR_*` and `GIT_COMMITTER_*` from the host's git config, plus the revocation knobs. */
  extraEnv: Record<string, string>;
  commandDir: string | undefined;
  /** The copy of the user's global git config the sandbox reads as `GIT_CONFIG_GLOBAL` (unless the mode masks `~/.gitconfig`). */
  gitConfig: string | undefined;
  /** The applied profile's read and write grants, absolute: the only trees a deny can matter in. */
  grants: string[];
  /** The in-sandbox self-check passed for this init. */
  probed: boolean;
  /** The sandbox account's SID as the runtime reports it (`*S-1-5-21-...`). */
  sid: string;
  /** The runtime is initialized without project writes (read-only is per session on Windows). */
  readOnly: boolean;
  /**
   * The loopback mode the sandbox was installed with (runtime 0.0.81: an
   * install-time fact; a session asking for the other mode is refused).
   * The runtime always gets this value; the mode's own `allowLocalBinding`
   * only decides whether the user is told about the difference.
   */
  loopbackInstalled: boolean;
  /** Whether the installing user's profile is readable to sandboxed commands (the install's profile read grant). */
  profileRead: "granted" | "absent" | undefined;
  /** The grant's record while it is current: what it excludes, what it leaves ungranted, the variables it offers. */
  profileStatus?: WindowsProfileGrant;
  /** What the runtime said about the grant at the last initialize (excluded paths that are readable after all, and the like). */
  profileWarnings: string[];
}

type WindowsProfileGrant = Awaited<ReturnType<SandboxRuntime["getWindowsProfileReadStatusAsync"]>>;

/** Footer reason while the install predates this runtime release (setup version changed). */
export const WINDOWS_REINSTALL_WARN = "Windows sandbox set up by another release (/sandbox install)";
/** Footer reason while the install's profile read grant is one the runtime refuses to rely on. */
export const WINDOWS_PROFILE_GRANT_WARN = "Windows sandbox: profile read grant needs /sandbox install";
/** Footer reason when the mode's write roots collide with the grant's exclusions (the runtime would refuse the session). */
export const WINDOWS_PROFILE_CONFLICT_WARN = "Windows sandbox off: a write root holds a protected store";

/** What `windowsSetup("install")` passes on; the UI asks the questions. */
export interface WindowsInstallChoices {
  /** Open loopback for the sandbox account (`sandbox.allowLocalBinding`); an install-time mode. */
  allowLoopback: boolean;
  /** Make the user's profile readable to sandboxed commands, minus the runtime's credential-store exclusions. */
  profileGrant: boolean;
  /** Replace an install made with other options (after the user agreed). */
  force?: boolean;
  /** The runtime's profile grant start notice and its progress lines (one per folder), for the user to read. */
  onProgress?: (line: string) => void;
  /** The step in flight, for the footer: the UAC prompt, the profile grant, the session initialize. */
  onStage?: (stage: string) => void;
}

/** The command-file directory with read access for the sandbox user, or undefined when that cannot be arranged (files are then inlined). */
function windowsCommandDir(grantee: string): string | undefined {
  const dir = commandFileDir();
  if (!dir) return undefined;
  try {
    grantReadExecute(dir, grantee);
    return dir;
  } catch {
    return undefined;
  }
}

/** A profile path as an absolute Windows path (`~` is the user profile, `%VAR%` comes from `env`). */
function winAbs(p: string, cwd: string, env: NodeJS.ProcessEnv): string {
  const home = env.USERPROFILE;
  let e = expandWinEnv(p, env);
  if (home && (e === "~" || e.startsWith("~/") || e.startsWith("~\\"))) e = home + e.slice(1);
  return path.win32.resolve(cwd, e);
}

/**
 * The denies that can matter: those at or under a grant. The sandbox user
 * has no rights elsewhere, so a deny there changes nothing, and the runtime
 * stamps every deny with an inheriting entry on the denied path's PARENT,
 * which NTFS copies over the parent's whole tree: a deny of `~/.ssh` would
 * walk the entire user profile, past the runtime's 60 s limit.
 */
function deniesInsideGrants(denies: readonly string[], grants: readonly string[], cwd: string, env: NodeJS.ProcessEnv): string[] {
  return denies.filter((d) => {
    const abs = winAbs(d, cwd, env);
    return grants.some((g) => !isOutsideWin(g, abs));
  });
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Owns the sandbox runtime and its readiness state. A single instance lives for
 * the extension's lifetime; `init` is re-runnable across sessions, and
 * `applyProfile` re-initializes when the active mode's sandbox profile changes.
 *
 * Native Windows uses the runtime's `srt-win` backend (a dedicated
 * `srt-sandbox` user) once it is installed and a self-check inside the
 * sandbox passes (see sandbox-win.ts). Otherwise the controller degrades
 * (ready=false), so the sandboxed modes prompt before every bash command
 * instead of claiming a protection that does not exist.
 */
export class SandboxController {
  private manager: SandboxManagerType | null = null;
  /** The runtime module, kept on Windows for its helper exports (install, error parsing). */
  private rt: SandboxRuntime | undefined;
  private profile: SandboxProfile | undefined;
  /** Key of the profile the runtime is currently initialized with. */
  private appliedKey: string | undefined;
  /** True once the runtime's initialize() succeeded and reset() hasn't run since (independent of `ready`). */
  private runtimeInitialized = false;
  /** applyProfile calls are serialized: the runtime ignores a second initialize while one is in flight. */
  private applying: Promise<void> = Promise.resolve();
  /** applyProfile requests not yet settled (queued or running). */
  private pendingApplies = 0;
  private switchDelayMs = 0;
  /** When the most recent applyProfile() arrived; the quiet time counts from here. */
  private lastApplyAt = 0;
  /** Platform or dependency issue - never (re)initialize the runtime. */
  private degraded = false;
  private hasUI = false;
  private notifyFn: Notify = () => {};
  private askHost: ((host: string, port: number | undefined) => Promise<boolean>) | undefined;
  private cwd = "";
  private keepWritable: string[] = [];
  private win: WindowsBackend | undefined;
  /** Options of the last `init`, so `/sandbox install` can re-run it. */
  private lastInit: InitOptions | undefined;
  ready = false;
  disabled = false;
  warn: string | undefined;
  /** Non-fatal findings of the runtime's dependency check (shown once, listed by /sandbox). */
  dependencyWarnings: string[] = [];
  /** Runtime-level additions for the current project (see RuntimeExtras), set by init. */
  extras: RuntimeExtras | undefined;

  /** The active runtime, or null when unavailable. */
  get sandboxManager(): SandboxManagerType | null {
    return this.manager;
  }

  /** True while the native Windows backend drives the sandbox. */
  get windowsBackend(): boolean {
    return this.win !== undefined;
  }

  /** What the Windows backend runs with, for `/sandbox`; undefined off Windows or while degraded. */
  windowsStatus():
    | {
        bash: string;
        srtWinPath: string;
        readOnly: boolean;
        grants: string[];
        loopbackInstalled: boolean;
        profileRead: "granted" | "absent" | undefined;
        /** The configuration-file variables the grant adds to sandboxed commands (names). */
        profileEnv: string[];
        profileWarnings: string[];
      }
    | undefined {
    const w = this.win;
    if (!w) return undefined;
    return {
      bash: w.bash,
      srtWinPath: w.srtWinPath,
      readOnly: w.readOnly,
      grants: w.grants,
      loopbackInstalled: w.loopbackInstalled,
      profileRead: w.profileRead,
      profileEnv: Object.entries(w.profileStatus?.env ?? {})
        .filter(([k, v]) => w.extraEnv[k] === v)
        .map(([k]) => k),
      profileWarnings: w.profileWarnings,
    };
  }

  /**
   * Windows: the sentence for a mode whose `allowLocalBinding` differs from
   * the loopback mode the sandbox was installed with, or undefined when they
   * agree (or off Windows). The caller shows it once per mode and session.
   */
  loopbackConflict(profile: SandboxProfile, label: string): string | undefined {
    const w = this.win;
    if (!w || !profile.enabled) return undefined;
    const wanted = profile.allowLocalBinding !== false;
    if (wanted === w.loopbackInstalled) return undefined;
    return (
      `permission-mode: ${label} sets sandbox.allowLocalBinding ${wanted ? "on" : "off"}, but the Windows sandbox is installed with loopback ${w.loopbackInstalled ? "open" : "closed"}: ` +
      `the install decides until /sandbox install runs again. Use the same value in every mode (see ${docRef("windowsLoopback")}).`
    );
  }

  /** Wall time of the last successful runtime initialize, in milliseconds (the permission-entry walks on Windows show here). */
  lastInitMs: number | undefined;
  /** Wall time of the most recent runtime `reset()` (a mode switch pays this on top of the initialize). */
  lastResetMs: number | undefined;
  private identity: { name?: string; email?: string } | undefined;

  /** True while a profile switch is queued or running (the footer marks it). */
  get switching(): boolean {
    return this.pendingApplies > 0;
  }

  /** Resolves once every requested profile switch has settled. */
  settled(): Promise<void> {
    return this.applying;
  }

  /**
   * Wrap a fresh BashOperations around the active runtime, or null when
   * unavailable. With `readOnly`, the command runs with project writes
   * disabled (Plan mode); `extraDenyRead` masks the session's blocked paths
   * for this command. Both ride along as the per-wrap config (the runtime
   * compiles filesystem rules at wrap time), so neither restarts the runtime.
   *
   * On Windows only the denies ride along: grants are permission entries
   * stamped at initialize time, so read-only was applied when the mode was
   * switched to (see applyProfile). Until that re-initialization has landed,
   * the operations refuse to run rather than run with the wrong grants.
   */
  bashOps(opts: BashOpsOptions = {}): BashOperations | null {
    if (!this.manager || !this.profile) return null;
    if (this.win) {
      if (Boolean(opts.readOnly) !== this.win.readOnly) {
        return {
          async exec() {
            throw new Error("permission-mode: the sandbox is still being re-initialized for this mode (on Windows read-only applies per session); run the command again");
          },
        };
      }
      const env = this.lastInit?.windows?.env ?? process.env;
      return createWindowsSandboxedBashOps(
        this.manager,
        {
          bash: this.win.bash,
          extraEnv: this.win.extraEnv,
          tmpdir: opts.tmpdir,
          // A block outside every grant is moot and would walk its parent's tree per command.
          extraDenyRead: deniesInsideGrants(opts.extraDenyRead ?? [], this.win.grants, this.cwd, env),
          commandDir: this.win.commandDir,
          parseError: this.rt?.parseWindowsSandboxError,
        },
        { onRun: () => this.runStarted() },
      );
    }
    return createSandboxedBashOps(this.manager, bashCustomConfig(this.profile, opts, this.extras), {
      tmpdir: opts.tmpdir,
      onRun: () => this.runStarted(),
    });
  }

  /** Sandboxed commands currently running (wrapped, not yet cleaned up). */
  private inflight = 0;
  private idleWaiters: Array<() => void> = [];

  private runStarted(): () => void {
    this.inflight++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.inflight--;
      if (this.inflight === 0) for (const w of this.idleWaiters.splice(0)) w();
    };
  }

  /** Resolves once no sandboxed command is running (reset() would strip a running command's mounts and network). */
  private whenIdle(): Promise<void> {
    if (this.inflight === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  /**
   * Resolves once no sandboxed command is running. A network prompt raised by
   * a command's connection is dismissed on it: once the command has ended or
   * timed out, nothing waits for the answer and the prompt would only linger.
   */
  idle(): Promise<void> {
    return this.whenIdle();
  }

  /** Install instructions shown when the runtime is missing or fails to init. */
  private static installHint(): string {
    const linux = process.platform === "linux" ? "  (Linux also needs: bubblewrap, socat, ripgrep)" : "";
    return `Fix: cd ${EXTENSION_DIR} && npm install${linux}; see ${docRef("sandboxUnavailable")}`;
  }

  /** Stop trying to sandbox for this init: record why, and tell the user once. */
  private degrade(profile: SandboxProfile, warn: string, message?: string): void {
    this.degraded = true;
    this.profile = profile;
    this.warn = warn;
    if (message && this.hasUI) this.notifyFn(message);
  }

  async init(opts: InitOptions): Promise<void> {
    const { cwd, noSandbox, hasUI, notify, profile, askHost, platform = process.platform, loadRuntime = () => import("@anthropic-ai/sandbox-runtime") } = opts;
    await this.applying.catch(() => {}); // let an in-flight profile switch settle first
    // A re-run (resume, /reload) must start from a clean runtime: initialize()
    // is a no-op while the runtime still holds its previous initialization.
    if (this.runtimeInitialized && this.manager) {
      try {
        await this.manager.reset();
      } catch {
        // ignore cleanup errors
      }
      this.runtimeInitialized = false;
    }
    this.ready = false;
    this.disabled = false;
    this.degraded = false;
    this.warn = undefined;
    this.manager = null;
    this.rt = undefined;
    this.win = undefined;
    this.appliedKey = undefined;
    this.dependencyWarnings = [];
    this.extras = runtimeExtrasFor(cwd, undefined, opts.platform ?? process.platform);
    this.hasUI = hasUI;
    this.notifyFn = notify;
    this.askHost = askHost;
    this.cwd = cwd;
    this.keepWritable = opts.keepWritable ?? [];
    this.switchDelayMs = opts.switchDelayMs ?? ((opts.platform ?? process.platform) === "win32" ? 1000 : 0);
    this.lastInit = opts;

    if (noSandbox) {
      this.disabled = true;
      this.degraded = true;
      this.profile = profile;
      return;
    }

    let rt: SandboxRuntime;
    try {
      rt = await loadRuntime();
    } catch (err) {
      this.degraded = true;
      this.profile = profile;
      this.warn = isModuleNotFound(err)
        ? "sandbox-runtime missing (run npm install in the extension dir)"
        : `sandbox load failed: ${err instanceof Error ? err.message : String(err)}`;
      if (hasUI) {
        notify(
          `permission-mode: OS sandbox unavailable - protection is heuristic-only.\n${this.warn}\n` +
            SandboxController.installHint(),
        );
      }
      return;
    }
    if (platform === "win32") return this.initWindows(opts, rt);
    this.manager = rt.SandboxManager;

    if (!this.manager.isSupportedPlatform()) {
      // WSL1 has no bubblewrap support; the runtime knows the platforms it runs on.
      this.warn = `sandbox unsupported on this platform${platform === "linux" ? " (WSL1?)" : ""}`;
      this.degraded = true;
      this.profile = profile;
      if (hasUI) notify(`permission-mode: OS sandbox unavailable - protection is heuristic-only.\n${this.warn}\nSee ${docRef("sandboxUnavailable")}`);
      return;
    }

    // Dependencies, checked here rather than left to initialize(): its errors
    // (missing bwrap/socat/ripgrep, a root caller without CAP_SETFCAP) become
    // the footer reason plus the fix-it hint, and its warnings (no seccomp
    // helper for this architecture, so unix sockets stay unrestricted) are
    // shown once instead of vanishing.
    let deps: { errors: string[]; warnings: string[] };
    try {
      deps = await this.manager.checkDependenciesAsync();
    } catch (err) {
      deps = { errors: [err instanceof Error ? err.message : String(err)], warnings: [] };
    }
    if (deps.errors.length > 0) {
      this.degraded = true;
      this.profile = profile;
      this.warn = `sandbox dependencies: ${deps.errors.join("; ")}`;
      if (hasUI) {
        notify(
          `permission-mode: OS sandbox unavailable - protection is heuristic-only.\n${this.warn}\n` +
            SandboxController.installHint(),
        );
      }
      return;
    }
    this.dependencyWarnings = deps.warnings;
    if (deps.warnings.length > 0 && hasUI) {
      notify(`permission-mode: sandbox dependency warning(s): ${deps.warnings.join("; ")}`);
    }

    if (this.extras?.allowWrite.length && hasUI) {
      notify(
        `permission-mode: git worktree/submodule detected; sandboxed bash may write its git dirs (${this.extras.allowWrite.join(", ")}), hooks and config excluded`,
      );
    }

    await this.applyProfile(profile);
  }

  /**
   * Native Windows: the runtime's `srt-win` backend. It needs the one-time
   * elevated install (the `srt-sandbox` account and its firewall filter), a
   * Git Bash the sandbox user can run, and the helper staged where that user
   * can read it. The in-sandbox self-check runs on the first initialize
   * (see applyProfileNow).
   */
  private async initWindows(opts: InitOptions, rt: SandboxRuntime): Promise<void> {
    const { profile, cwd, hasUI, notify } = opts;
    const hooks = opts.windows ?? {};
    const env = hooks.env ?? process.env;
    this.rt = rt;
    const unavailable = (why: string, fix: string): void =>
      this.degrade(profile, why, `permission-mode: OS sandbox unavailable - protection is heuristic-only.\n${why}\n${fix}`);
    let srtWin: ReturnType<SandboxRuntime["resolveSrtWin"]>;
    try {
      srtWin = rt.resolveSrtWin({ path: rt.VENDORED_SRT_WIN_EXE });
    } catch (err) {
      return unavailable(`Windows sandbox helper missing: ${errMsg(err)}`, SandboxController.installHint());
    }
    let status: Awaited<ReturnType<SandboxRuntime["getWindowsSandboxUserStatusAsync"]>>;
    try {
      status = await rt.getWindowsSandboxUserStatusAsync({ srtWin });
    } catch (err) {
      return unavailable(`Windows sandbox check failed: ${errMsg(err)}`, `See ${docRef("windowsInstall")}`);
    }
    if (!status.provisioned || !status.credPresent || !status.sid) {
      return this.degrade(
        profile,
        WINDOWS_NOT_INSTALLED_WARN,
        "permission-mode: the Windows sandbox is not installed, so the sandboxed modes ask before every bash command. " +
          "Run /sandbox install (one UAC prompt: it creates the local user srt-sandbox and a firewall filter keyed on it); " +
          `see ${docRef("windowsInstall")}`,
      );
    }
    const grantee = `*${status.sid}`;
    // The loopback mode is the install's (0.0.81): read it, and check the
    // dependencies against it so the check never reports a mismatch with
    // the mode's wish (loopbackConflict tells the user about that instead).
    const loopbackInstalled = await this.installedLoopback(rt, srtWin, profile.allowLocalBinding !== false);
    let deps: { errors: string[]; warnings: string[]; reinstallRequired?: string };
    try {
      deps = await rt.checkWindowsDependenciesAsync({ srtWin, allowLoopback: loopbackInstalled });
    } catch (err) {
      deps = { errors: [errMsg(err)], warnings: [] };
    }
    if (deps.reinstallRequired) {
      return this.degrade(
        profile,
        WINDOWS_REINSTALL_WARN,
        // The runtime's text goes on with its own re-run advice; the first sentence is the fact.
        `permission-mode: ${deps.reinstallRequired.split(/(?<=\.)\s/)[0]} Run /sandbox install (one UAC prompt; it upgrades the install in place). ` +
          `Until then the sandboxed modes ask before every bash command; see ${docRef("windowsInstall")}`,
      );
    }
    if (deps.errors.length > 0) return unavailable(`sandbox dependencies: ${deps.errors.join("; ")}`, `See ${docRef("windowsInstall")}`);
    this.dependencyWarnings = deps.warnings;
    if (deps.warnings.length > 0 && hasUI) notify(`permission-mode: sandbox dependency warning(s): ${deps.warnings.join("; ")}`);

    // The install's profile read grant (0.0.81): current, absent, or one the
    // runtime would refuse at initialize (an unfinished run, an older
    // exclusion list, another profile). Its record carries the exclusions
    // (for the mode's paths) and the configuration-file variables.
    let grant: WindowsProfileGrant;
    try {
      grant = await rt.getWindowsProfileReadStatusAsync({ srtWin });
    } catch (err) {
      return unavailable(`profile read grant: ${errMsg(err)}`, `See ${docRef("windowsProfile")}`);
    }
    if (grant.state !== "none" && grant.state !== "current") {
      return this.degrade(
        profile,
        WINDOWS_PROFILE_GRANT_WARN,
        `permission-mode: the profile read grant on this machine cannot be relied on (${grant.state}${grant.reason ? `: ${grant.reason}` : ""}), so the runtime refuses every session. ` +
          `Run /sandbox install again (one UAC prompt; it refreshes the grant, or answer No to go without). Until then the sandboxed modes ask before every bash command; see ${docRef("windowsProfile")}`,
      );
    }
    const profileRead = grant.state === "current" ? "granted" : "absent";
    const readable = [...(profile.allowRead ?? []), ...(profile.allowWrite ?? [])].map((p) => winAbs(p, cwd, env));
    // With the grant, a Git for Windows installed for the user alone is readable too.
    const bashRoots = profileRead === "granted" && env.USERPROFILE ? [...readable, env.USERPROFILE] : readable;
    const bash = hooks.findBash ? hooks.findBash(bashRoots) : findGitBash(env, existsSync, bashRoots);
    if (!bash) {
      return this.degrade(
        profile,
        "Windows sandbox off: Git Bash not found",
        "permission-mode: the Windows sandbox runs commands in Git Bash (Git for Windows). None the sandbox user can run was found, " +
          `so the sandboxed modes ask before every bash command. Install Git for Windows for all users (Program Files); see ${docRef("windowsInstall")}`,
      );
    }
    let staged: string;
    try {
      staged = hooks.stageHelper ? hooks.stageHelper(rt.VENDORED_SRT_WIN_EXE, grantee) : stageSrtWin(rt.VENDORED_SRT_WIN_EXE, grantee, env);
    } catch (err) {
      return unavailable(`Windows sandbox off: could not stage srt-win (${errMsg(err)})`, `See ${docRef("windowsInstall")}`);
    }
    const commandDir = hooks.commandDir ? hooks.commandDir(grantee) : windowsCommandDir(grantee);
    // Two git spawns per init otherwise, and a mode switch re-inits: the identity does not change within a session.
    const id = (this.identity ??= (hooks.readIdentity ?? readGitIdentity)(cwd));
    if (this.extras?.allowWrite.length && hasUI) {
      notify(
        `permission-mode: git worktree/submodule detected; sandboxed bash may write its git dirs (${this.extras.allowWrite.join(", ")}), hooks and config excluded`,
      );
    }
    this.manager = rt.SandboxManager;
    // The grant's variables point tools at the user's own configuration
    // files (npm, pip, Maven, rustup/cargo); ours come after them, so the
    // staged git config and the identity still win.
    const profileEnv = profileRead === "granted" ? rt.windowsProfileReadEnv(grant, env) : {};
    const extraEnv = { ...profileEnv, ...gitIdentityEnv(id.name, id.email), ...windowsGitEnv(env) };
    let gitConfig: string | undefined;
    try {
      gitConfig = hooks.gitConfig ? hooks.gitConfig(commandDir) : commandDir ? stageGitConfig(commandDir, env) : undefined;
    } catch {
      gitConfig = undefined; // the identity still travels as environment
    }
    this.win = {
      bash,
      srtWinPath: staged,
      extraEnv,
      commandDir,
      gitConfig,
      grants: readable,
      probed: false,
      sid: grantee,
      readOnly: !profile.writable,
      loopbackInstalled,
      profileRead,
      profileStatus: profileRead === "granted" ? grant : undefined,
      profileWarnings: [],
    };
    await this.applyProfile(profile);
  }

  /**
   * How a path of the mode stands to the profile read grant's exclusions:
   * `protected` when it is, or lies inside, an excluded store (the runtime
   * refuses to grant it, or needs the explicit dangerous option for a read),
   * `ungranted` for the user's temporary directory (grantable), `above` when
   * an exclusion lies beneath it (never grantable; as a read, redundant with
   * the grant itself), `none` otherwise.
   */
  private profileRelation(abs: string, grant: WindowsProfileGrant, write: boolean): "protected" | "ungranted" | "above" | "none" {
    const rt = this.rt;
    if (!rt) return "none";
    const conflicts = rt.windowsProfileExclusionConflicts([abs], grant, { write });
    if (conflicts.some((c) => c.kind === "protected" && c.relation !== "above")) return "protected";
    if (conflicts.some((c) => c.relation === "above")) return "above";
    if (conflicts.length > 0) return "ungranted";
    return "none";
  }

  /**
   * The loopback mode of the installed firewall set. Read from the WFP
   * status where it can be read (elevation is not needed for the install's
   * record); where it cannot, the dependency check compares `wanted` with
   * the install and names a mismatch, which means the other mode.
   */
  private async installedLoopback(rt: SandboxRuntime, srtWin: ReturnType<SandboxRuntime["resolveSrtWin"]>, wanted: boolean): Promise<boolean> {
    try {
      const wfp = await rt.getWindowsWfpStatusAsync({ srtWin });
      if (wfp.state === "installed" || wfp.state === "loopback-mismatch") return wfp.allowLoopback;
    } catch {
      // fall through to the comparison
    }
    try {
      const deps = (await rt.checkWindowsDependenciesAsync({ srtWin, allowLoopback: wanted })) as { loopbackMismatch?: string };
      return deps.loopbackMismatch ? !wanted : wanted;
    } catch {
      return wanted;
    }
  }

  /**
   * Run the self-check inside the freshly initialized Windows sandbox (see
   * sandbox-win.ts). Folders the profile grants write access to are not
   * probed: writable by design. Returns true when it passed; otherwise tears
   * the runtime down and degrades.
   */
  private async probeWindows(win: WindowsBackend, manager: SandboxManagerType, cfg: SandboxConfig, profile: SandboxProfile): Promise<boolean> {
    const env = this.lastInit?.windows?.env ?? process.env;
    const writable = (cfg.filesystem.allowWrite ?? []).map((p) => winAbs(p, this.cwd, env));
    const targets = probeTargets(this.cwd, win.srtWinPath).filter((t) => !writable.some((w) => !isOutsideWin(w, t)));
    let out = "";
    try {
      // The runtime's launch-error parser rides along: a working directory
      // srt-win refuses (a mapped drive) must be named, not "did not complete".
      const ops = createWindowsSandboxedBashOps(manager, { bash: win.bash, extraEnv: {}, commandDir: win.commandDir, parseError: this.rt?.parseWindowsSandboxError });
      const script = probeScript(this.cwd, targets, randomBytes(6).toString("hex"));
      await ops.exec(script, this.cwd, { onData: (d) => (out += String(d)), timeout: 120 });
    } catch (err) {
      out += `\n${errMsg(err)}`;
    }
    const result = parseProbe(out);
    if (result.writable.length) {
      // A writable parent that already carries an entry for the sandbox
      // account is another session's project, not a loose ACL: say so.
      const acl = this.lastInit?.windows?.readAcl ?? readAcl;
      const granted = result.writable.filter((d) => sandboxAceIn(acl(d), win.sid) !== undefined);
      if (granted.length) result.granted = granted;
    }
    const problem = probeProblem(result);
    if (!problem) {
      win.probed = true;
      const notice = probeNotice(result);
      if (notice && this.hasUI) this.notifyFn(`permission-mode: ${notice}`);
      return true;
    }
    this.ready = false;
    try {
      await manager.reset();
    } catch {
      // ignore cleanup errors
    }
    this.runtimeInitialized = false;
    // Drop the runtime so nothing can hand out operations for a sandbox we rejected.
    this.manager = null;
    this.win = undefined;
    this.degrade(profile, problem, `permission-mode: ${probeAdvice(result)}`);
    return false;
  }

  /**
   * Install or remove the Windows backend (one UAC prompt each), then re-run
   * the last init so the result takes effect at once. Returns a status line.
   */
  async windowsSetup(action: "install" | "uninstall", choices?: WindowsInstallChoices): Promise<string> {
    const rt = this.rt ?? (await (this.lastInit?.loadRuntime ?? (() => import("@anthropic-ai/sandbox-runtime")))());
    const srtWin = rt.resolveSrtWin({ path: rt.VENDORED_SRT_WIN_EXE });
    let outcome = "";
    if (action === "install") {
      const c = choices ?? { allowLoopback: true, profileGrant: true };
      // An install replaces this session's runtime state: release it first
      // (kept write grants stay, by the runtime's design).
      await this.reset();
      c.onStage?.("install, waiting for the UAC prompt");
      const r = await rt.installWindowsSandboxAsync({
        srtWin,
        allowLoopback: c.allowLoopback,
        skipProfileGrant: !c.profileGrant,
        force: c.force,
        onProfileGrantStart: (notice) => {
          c.onProgress?.(notice);
          c.onStage?.("profile read grant, minutes the first time");
        },
        onProfileGrantProgress: (line) => c.onStage?.(`profile read grant: ${line.length > 60 ? `${line.slice(0, 57)}...` : line}`),
      });
      if (r.cancelled) return "Windows sandbox install cancelled (the UAC prompt was dismissed).";
      const grant = r.profileGrant;
      outcome =
        ` Loopback ${c.allowLoopback ? "open" : "closed"}; your profile ${
          grant?.applied ? "readable to sandboxed commands (minus credential stores)" : `not readable (${grant?.reason ?? (c.profileGrant ? "no grant reported" : "skipped")})`
        }.`;
    } else {
      await this.reset(); // drop this session's permission entries before the account goes away
      const r = rt.uninstallWindowsSandbox({ srtWin });
      if (r.cancelled) return "Windows sandbox uninstall cancelled (the UAC prompt was dismissed).";
    }
    if (this.lastInit) {
      choices?.onStage?.("initializing this session, permission entries over the project");
      await this.init(this.lastInit);
    }
    if (this.ready) return `Windows sandbox installed and active.${outcome}`;
    return action === "install"
      ? `Windows sandbox installed, but not active: ${this.warn ?? "unknown"}.${outcome}`
      : "Windows sandbox removed; the sandboxed modes ask before every bash command.";
  }

  /**
   * Ensure the runtime is initialized with `profile`. A no-op when degraded, when
   * the profile doesn't sandbox (`enabled:false`), or when the profile's
   * filesystem/network is unchanged. Re-initializes (reset + initialize) when the
   * profile differs, so switching to a mode with different folders/network takes
   * effect immediately.
   */
  async applyProfile(profile: SandboxProfile): Promise<void> {
    this.profile = profile;
    this.lastApplyAt = Date.now();
    this.pendingApplies++;
    const run = this.applying.then(() => this.applyProfileNow(profile)).finally(() => this.pendingApplies--);
    this.applying = run.catch(() => {});
    return run;
  }

  private async applyProfileNow(profile: SandboxProfile, retried = false): Promise<void> {
    if (this.degraded || !this.manager) return;
    // Superseded: a later applyProfile call holds the profile that counts
    // (cycling past a mode must not pay for the modes in between; on
    // Windows each switch re-stamps permission entries over whole trees).
    if (profile !== this.profile) return;
    if (!profile.enabled) return; // non-sandboxing mode (e.g. YOLO): keep prior init
    if (this.runtimeInitialized && this.switchDelayMs > 0) {
      // A switch, not the first init: let the user finish cycling. The
      // timer restarts with every later applyProfile(); whichever profile
      // is current once it is quiet is the one applied.
      for (let quiet = Date.now() - this.lastApplyAt; quiet < this.switchDelayMs; quiet = Date.now() - this.lastApplyAt) {
        await new Promise((r) => setTimeout(r, this.switchDelayMs - quiet));
      }
      if (profile !== this.profile) return;
    }

    const win = this.win;
    let cfg = withRuntimeExtras(profileToConfig(profile), this.extras);
    // Windows cannot change grants per command (only per-exec denies), so a
    // read-only mode (Plan) is applied here: the session runs without project
    // writes until the next mode switch re-initializes.
    if (win && !profile.writable) cfg = readOnlyOverride(cfg, this.keepWritable);
    /** Reads of protected stores the mode names explicitly; passed to initialize as the runtime's dangerous option. */
    let exclusionReads: string[] = [];
    if (win) {
      const env = this.lastInit?.windows?.env ?? process.env;
      const fs = cfg.filesystem;
      const abs = (p: string) => winAbs(p, this.cwd, env);
      let allowRead = fs.allowRead ?? [];
      const grant = win.profileStatus;
      const home = grant && env.USERPROFILE ? abs(env.USERPROFILE) : undefined;
      if (grant && home) {
        // With the profile readable through the grant, a read inside it is
        // redundant (the tool roots, `~` itself, a folder above a store: the
        // runtime refuses the last kind outright), except a protected store
        // the mode names on purpose, which goes through the dangerous option,
        // and the ungranted temporary directory, which is granted as usual.
        const kept: string[] = [];
        for (const p of allowRead) {
          const a = abs(p);
          if (isOutsideWin(home, a)) {
            kept.push(p);
            continue;
          }
          const rel = this.profileRelation(a, grant, false);
          if (rel === "protected") exclusionReads.push(a);
          if (rel === "protected" || rel === "ungranted") kept.push(p);
        }
        allowRead = kept;
        // A write root that is, holds or lies inside a protected store cannot
        // be granted at all: say which, instead of the runtime's refusal.
        const writeConflicts = fs.allowWrite.map(abs).filter((a) => !isOutsideWin(home, a) && this.profileRelation(a, grant, true) !== "none");
        if (writeConflicts.length > 0) {
          this.ready = false;
          this.warn = WINDOWS_PROFILE_CONFLICT_WARN;
          if (this.hasUI) {
            this.notifyFn(
              `permission-mode: the sandbox cannot grant write access to ${writeConflicts.join(", ")}: the profile read grant protects a credential store there (or beneath it), so the runtime refuses the session. ` +
                `Choose a narrower project directory, or take the path out of allowWrite; see ${docRef("windowsProfile")}`,
            );
          }
          return;
        }
      }
      win.grants = [...allowRead, ...fs.allowWrite].map(abs);
      // The user's global git config applies inside the sandbox as it does on
      // Linux: unless the mode masks ~/.gitconfig (a strict home).
      if (win.gitConfig && !gitConfigMasked(profile, env)) win.extraEnv.GIT_CONFIG_GLOBAL = win.gitConfig.replace(/\\/g, "/");
      else delete win.extraEnv.GIT_CONFIG_GLOBAL;
      // Denies outside every grant would walk the profile for nothing; with
      // the grant the profile counts as granted, and a deny on an excluded
      // store is already in force (the runtime keeps it unreadable).
      const denyScope = home ? [...win.grants, home] : win.grants;
      const effective = (denies: readonly string[]) =>
        deniesInsideGrants(denies, denyScope, this.cwd, env).filter((d) => !(grant && home && !isOutsideWin(home, abs(d)) && this.profileRelation(abs(d), grant, false) === "protected"));
      // Loopback is the install's mode on Windows: the runtime refuses a
      // session that asks for the other one, so the mode's wish never
      // reaches it (loopbackConflict tells the user).
      const { allowLocalBinding: _wish, ...network } = cfg.network;
      cfg = {
        ...cfg,
        network: win.loopbackInstalled ? { ...network, allowLocalBinding: true } : network,
        filesystem: {
          ...fs,
          allowRead,
          denyRead: effective(fs.denyRead),
          denyWrite: effective(fs.denyWrite),
        },
      };
    }
    const key = JSON.stringify({ n: cfg.network, f: cfg.filesystem, x: exclusionReads });
    if (this.ready && key === this.appliedKey) return;

    if (this.inflight > 0) {
      // reset() force-removes every mount point and stops the proxy: a
      // command still running would lose its denies and its network. Wait
      // for the running ones (the switch completes when they finish).
      if (this.hasUI) this.notifyFn(`permission-mode: waiting for ${this.inflight} running sandboxed command(s) before applying the new sandbox profile`);
      await this.whenIdle();
      if (profile !== this.profile) return; // superseded while waiting
    }
    try {
      if (this.runtimeInitialized) {
        const resetStart = Date.now();
        await this.manager.reset();
        this.lastResetMs = Date.now() - resetStart;
        this.runtimeInitialized = false;
      }
      // The ask callback rides along so unmatched hosts prompt instead of
      // silently failing; it reads live session state, so grants/`/net open`
      // apply instantly without re-initializing.
      const ask = this.askHost;
      // Third argument: the violation monitors (macOS log stream, Linux
      // seccomp write observer) that feed the <sandbox_violations> block a
      // run's output ends with. Always on: a headless pi's model reads that
      // output too. The Linux observer judges writes by the init-time lists,
      // so a Plan-mode (per-wrap read-only) refusal is not reported; the
      // block is best effort, the refusal itself is not.
      const runtimeCfg = win ? { ...cfg, windows: { srtWin: { path: win.srtWinPath } } } : cfg;
      const started = Date.now();
      await this.manager.initialize(
        runtimeCfg as never,
        ask ? (p: { host: string; port?: number }) => ask(p.host, p.port) : undefined,
        true,
        exclusionReads.length > 0 ? { dangerouslyAllowReadOfProfileExclusions: exclusionReads } : undefined,
      );
      this.lastInitMs = Date.now() - started;
      this.runtimeInitialized = true;
      if (win) {
        win.readOnly = !profile.writable;
        // What the runtime made of the grant for this session: its view wins
        // over the record read at init, and its warnings are the user's to see.
        win.profileRead = this.manager.getWindowsProfileRead?.() ?? win.profileRead;
        const warnings = (this.manager.getWindowsProfileReadWarnings?.() ?? []).map((w) => w.message);
        if (warnings.length > 0 && warnings.join("\n") !== win.profileWarnings.join("\n") && this.hasUI) {
          this.notifyFn(`permission-mode: profile read grant warning(s): ${warnings.join(" ")} See ${docRef("windowsProfile")}`);
        }
        win.profileWarnings = warnings;
        if (!win.probed && !(await this.probeWindows(win, this.manager, cfg, profile))) return;
      }
      this.ready = true;
      this.appliedKey = key;
      this.warn = undefined;
    } catch (err) {
      this.ready = false;
      try {
        await this.manager.reset(); // a half-initialized runtime would ignore the next initialize()
      } catch {
        // ignore
      }
      this.runtimeInitialized = false;
      if (win && !retried && /acl grant/.test(errMsg(err))) {
        // Permission entries held by an earlier run of this process (a
        // /reload) can refuse a path replaced meanwhile; the resets above
        // released them, so one more attempt is cheap.
        return this.applyProfileNow(profile, true);
      }
      const code = (err as { code?: string }).code;
      if (win && code === "profile_grant_outdated") {
        this.warn = WINDOWS_PROFILE_GRANT_WARN;
        if (this.hasUI) {
          this.notifyFn(
            `permission-mode: the runtime refuses to rely on the profile read grant on this machine (${errMsg(err)}). Run /sandbox install again (one UAC prompt; it refreshes the grant, or answer No to go without). ` +
              `Until then the sandboxed modes ask before every bash command; see ${docRef("windowsProfile")}`,
          );
        }
        return;
      }
      this.warn = `sandbox init failed: ${err instanceof Error ? err.message : String(err)}`;
      if (this.hasUI) {
        this.notifyFn(
          `permission-mode: sandbox failed to initialize - protection is heuristic-only.\n${this.warn}` +
            `${process.platform === "linux" ? "\nLinux requires: bubblewrap, socat, ripgrep" : ""}\nSee ${docRef(win ? "windowsInstall" : "sandboxUnavailable")}`,
        );
      }
    }
  }

  async reset(): Promise<void> {
    await this.applying.catch(() => {});
    if (this.runtimeInitialized && this.manager) {
      try {
        await this.manager.reset();
      } catch {
        // ignore cleanup errors
      }
    }
    this.runtimeInitialized = false;
    this.ready = false;
  }
}
