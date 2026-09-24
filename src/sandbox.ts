/**
 * OS-level sandbox lifecycle for Build mode.
 *
 * Wraps `@anthropic-ai/sandbox-runtime` (loaded lazily so a missing dependency
 * degrades gracefully instead of crashing) behind a small `SandboxController`
 * that owns init / wrap / reset and the readiness state surfaced in the footer.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { type SandboxConfig, profileToConfig, readOnlyOverride } from "./config-load.ts";
import { gitDirsOf } from "./paths.ts";
import { expandHome } from "./resolve.ts";
import type { SandboxProfile } from "./schema.ts";
import { isModuleNotFound } from "./util.ts";

// Real type of the runtime singleton, erased at compile time so a missing
// dependency never breaks loading. Replaces the former `any`.
type SandboxManagerType = typeof import("@anthropic-ai/sandbox-runtime").SandboxManager;

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
export function writeCommandFile(command: string, dir: string | undefined = commandFileDir()): string | undefined {
  if (!dir) return undefined;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `cmd-${randomBytes(8).toString("hex")}.sh`);
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
      "On Ubuntu 24.04+ (also under WSL2) this usually means kernel.apparmor_restrict_unprivileged_userns=1; " +
      "see README, Install. Nothing ran unsandboxed.\n"
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
      // After the run: the runtime's violation block for THIS command, and
      // a hint when it refused hosts the user could still allow, so a
      // blocked connection is diagnosable rather than a mystery.
      const emitViolations = () => {
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
                "Request access with the request_network_access tool, or ask the user (/net allow <domain>).\n",
            ),
          );
        }
      };
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
        // `await` so the finally runs after the child exits, not after the
        // Promise is constructed - otherwise cleanup would race the run.
        return await new Promise((resolve, reject) => {
          const child = spawn("bash", ["-c", wrapped], { cwd, env: env ?? process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
          let timedOut = false;
          let timer: NodeJS.Timeout | undefined;
          const kill = () => {
            if (child.pid) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                child.kill("SIGKILL");
              }
            }
          };
          if (timeout && timeout > 0) {
            timer = setTimeout(() => {
              timedOut = true;
              kill();
            }, timeout * 1000);
          }
          child.stdout?.on("data", onData);
          child.stderr?.on("data", (chunk: Buffer) => {
            head.add(chunk);
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
            // The violation monitors report over sockets of their own; give
            // events already sent one turn of the loop to land before reading.
            setImmediate(() => {
              emitViolations();
              if (code !== 0) {
                const hint = head.namespaceHint();
                if (hint) onData(Buffer.from(hint));
              }
              if (signal?.aborted) reject(new Error("aborted"));
              else if (timedOut) reject(new Error(`timeout:${timeout}`));
              else resolve({ exitCode: code });
            });
          });
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

/** The extras for a project at `cwd` (see RuntimeExtras). */
export function runtimeExtrasFor(cwd: string, runtimeDir: string | undefined = runtimeInstallDir()): RuntimeExtras {
  const extras: RuntimeExtras = { allowRead: runtimeDir ? [runtimeDir] : [], allowWrite: [], denyWrite: [] };
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
}

/**
 * Owns the sandbox runtime and its readiness state. A single instance lives for
 * the extension's lifetime; `init` is re-runnable across sessions, and
 * `applyProfile` re-initializes when the active mode's sandbox profile changes.
 */
export class SandboxController {
  private manager: SandboxManagerType | null = null;
  private profile: SandboxProfile | undefined;
  /** Key of the profile the runtime is currently initialized with. */
  private appliedKey: string | undefined;
  /** True once the runtime's initialize() succeeded and reset() hasn't run since (independent of `ready`). */
  private runtimeInitialized = false;
  /** applyProfile calls are serialized: the runtime ignores a second initialize while one is in flight. */
  private applying: Promise<void> = Promise.resolve();
  /** Platform or dependency issue - never (re)initialize the runtime. */
  private degraded = false;
  private hasUI = false;
  private notifyFn: Notify = () => {};
  private askHost: ((host: string, port: number | undefined) => Promise<boolean>) | undefined;
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

  /**
   * Wrap a fresh BashOperations around the active runtime, or null when
   * unavailable. With `readOnly`, the command runs with project writes
   * disabled (Plan mode); `extraDenyRead` masks the session's blocked paths
   * for this command. Both ride along as the per-wrap config (the runtime
   * compiles filesystem rules at wrap time), so neither restarts the runtime.
   */
  bashOps(opts: BashOpsOptions = {}): BashOperations | null {
    if (!this.manager || !this.profile) return null;
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

  /** Install instructions shown when the runtime is missing or fails to init. */
  private static installHint(): string {
    const linux = process.platform === "linux" ? "  (Linux also needs: bubblewrap, socat, ripgrep)" : "";
    return `Fix: cd ${EXTENSION_DIR} && npm install${linux}`;
  }

  async init({ cwd, noSandbox, hasUI, notify, profile, askHost }: InitOptions): Promise<void> {
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
    this.appliedKey = undefined;
    this.dependencyWarnings = [];
    this.extras = runtimeExtrasFor(cwd);
    this.hasUI = hasUI;
    this.notifyFn = notify;
    this.askHost = askHost;

    if (noSandbox) {
      this.disabled = true;
      this.degraded = true;
      this.profile = profile;
      return;
    }
    if (process.platform === "win32") {
      // The runtime's Windows sandbox (alpha) needs a one-time elevated
      // install and an argv-based wrap; not integrated yet, see README.
      this.warn = "sandbox unsupported on Windows (run pi under WSL2)";
      this.degraded = true;
      this.profile = profile;
      return;
    }

    try {
      const mod = (await import("@anthropic-ai/sandbox-runtime")) as { SandboxManager: SandboxManagerType };
      this.manager = mod.SandboxManager;
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

    if (!this.manager.isSupportedPlatform()) {
      // WSL1 has no bubblewrap support; the runtime knows the platforms it runs on.
      this.warn = `sandbox unsupported on this platform${process.platform === "linux" ? " (WSL1?)" : ""}`;
      this.degraded = true;
      this.profile = profile;
      if (hasUI) notify(`permission-mode: OS sandbox unavailable - protection is heuristic-only.\n${this.warn}`);
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
   * Ensure the runtime is initialized with `profile`. A no-op when degraded, when
   * the profile doesn't sandbox (`enabled:false`), or when the profile's
   * filesystem/network is unchanged. Re-initializes (reset + initialize) when the
   * profile differs, so switching to a mode with different folders/network takes
   * effect immediately.
   */
  async applyProfile(profile: SandboxProfile): Promise<void> {
    this.profile = profile;
    const run = this.applying.then(() => this.applyProfileNow(profile));
    this.applying = run.catch(() => {});
    return run;
  }

  private async applyProfileNow(profile: SandboxProfile): Promise<void> {
    if (this.degraded || !this.manager) return;
    if (!profile.enabled) return; // non-sandboxing mode (e.g. YOLO): keep prior init

    const cfg = withRuntimeExtras(profileToConfig(profile), this.extras);
    const key = JSON.stringify({ n: cfg.network, f: cfg.filesystem });
    if (this.ready && key === this.appliedKey) return;

    if (this.inflight > 0) {
      // reset() force-removes every mount point and stops the proxy: a
      // command still running would lose its denies and its network. Wait
      // for the running ones (the switch completes when they finish).
      if (this.hasUI) this.notifyFn(`permission-mode: waiting for ${this.inflight} running sandboxed command(s) before applying the new sandbox profile`);
      await this.whenIdle();
    }
    try {
      if (this.runtimeInitialized) {
        await this.manager.reset();
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
      await this.manager.initialize(
        cfg as never,
        ask ? (p: { host: string; port?: number }) => ask(p.host, p.port) : undefined,
        true,
      );
      this.runtimeInitialized = true;
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
      this.warn = `sandbox init failed: ${err instanceof Error ? err.message : String(err)}`;
      if (this.hasUI) {
        this.notifyFn(
          `permission-mode: sandbox failed to initialize - protection is heuristic-only.\n${this.warn}` +
            `${process.platform === "linux" ? "\nLinux requires: bubblewrap, socat, ripgrep" : ""}`,
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
