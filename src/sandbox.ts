/**
 * OS-level sandbox lifecycle for Build mode.
 *
 * Wraps `@anthropic-ai/sandbox-runtime` (loaded lazily so a missing dependency
 * degrades gracefully instead of crashing) behind a small `SandboxController`
 * that owns init / wrap / reset and the readiness state surfaced in the footer.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { type SandboxConfig, profileToConfig, readOnlyOverride } from "./config-load.ts";
import { removeSandboxPlaceholders } from "./paths.ts";
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
    if (!/\bbwrap: .*(Operation not permitted|Permission denied|No permissions to create)/i.test(this.text)) return undefined;
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

/**
 * BashOperations backed by `SandboxManager.wrapWithSandbox`. An optional
 * `customConfig` overrides the init-time config per command (used to drop write
 * access in Read mode without re-initializing the sandbox).
 */
export function createSandboxedBashOps(
  SandboxManager: SandboxManagerType,
  customConfig?: Partial<SandboxConfig>,
  drainBlockedHosts?: () => string[],
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      // Any network denial during this run (allowlist miss the user didn't
      // approve) is recorded by the ask callback; surface it to the model
      // after the run so a refused connection is diagnosable, not mystery.
      const emitBlockedHint = () => {
        const hosts = drainBlockedHosts?.() ?? [];
        if (hosts.length > 0) {
          onData(
            Buffer.from(
              `\n[permission-mode] network: connection(s) blocked by the sandbox allowlist: ${hosts.join(", ")}. ` +
                "Request access with the request_network_access tool, or ask the user (/net allow <domain>).\n",
            ),
          );
        }
      };
      if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
      if (signal?.aborted) throw new Error("aborted"); // never spawn for a call that is already cancelled
      drainBlockedHosts?.(); // discard denials that belong to earlier runs
      // The runtime removes the mount points it plants for absent mandatory
      // deny paths after each run (cleanupAfterCommand below); this sweep only
      // catches what a pi that died mid-command left behind (a stale 0-byte
      // .git would break this run).
      removeSandboxPlaceholders(cwd);
      // Command transport (see above): the runtime quotes what we hand it, so
      // hand it a launcher and keep the real command in a file.
      const commandFile = writeCommandFile(command);
      const tmpdir = typeof env?.TMPDIR === "string" ? env.TMPDIR : undefined;
      const launcher = commandFile ? commandLauncher(commandFile, tmpdir) : undefined;
      // Violations the runtime observes while the command runs (refused
      // writes, denied hosts) are filed under this id; the ORIGINAL command
      // is what they report, not the launcher.
      const commandId = `pi-${randomBytes(8).toString("hex")}`;
      const emitViolations = () => {
        let block = "";
        try {
          block = SandboxManager.annotateStderrWithSandboxFailures?.(commandId, "")?.trim() ?? "";
        } catch {
          return;
        }
        if (block) onData(Buffer.from(`\n${block}\n`));
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
      try {
        if (signal?.aborted) throw new Error("aborted");
        const head = new StderrHead();
        // `await` so the finally runs after the child exits, not after the
        // Promise is constructed - otherwise cleanup would race the run.
        return await new Promise((resolve, reject) => {
          const child = spawn("bash", ["-c", wrapped], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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
              emitBlockedHint();
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
          // best effort: the sweep below and the runtime's exit handler remain
        }
        removeSandboxPlaceholders(cwd);
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
  return { ...profile, denyRead: [...new Set([...(profile.denyRead ?? []), ...paths])] };
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
  /** Drained by the bash wrapper to report hosts blocked during a run. */
  drainBlockedHosts?: () => string[];
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
  private drainBlockedHosts: (() => string[]) | undefined;
  ready = false;
  disabled = false;
  warn: string | undefined;
  /** Non-fatal findings of the runtime's dependency check (shown once, listed by /sandbox). */
  dependencyWarnings: string[] = [];

  /** The active runtime, or null when unavailable. */
  get sandboxManager(): SandboxManagerType | null {
    return this.manager;
  }

  /**
   * Wrap a fresh BashOperations around the active runtime, or null when
   * unavailable. With `readOnly`, the command runs with project writes disabled
   * (Plan mode) — the library still allows its own default scratch paths.
   */
  bashOps(opts: { readOnly?: boolean; keepWritable?: string[] } = {}): BashOperations | null {
    if (!this.manager || !this.profile) return null;
    // Read-only keeps the session scratch dir writable: TMPDIR points there,
    // and a Plan-mode `mktemp` or Python `tempfile` must still work.
    const customConfig = opts.readOnly ? readOnlyOverride(profileToConfig(this.profile), opts.keepWritable ?? []) : undefined;
    return createSandboxedBashOps(this.manager, customConfig, this.drainBlockedHosts);
  }

  /** Install instructions shown when the runtime is missing or fails to init. */
  private static installHint(): string {
    const linux = process.platform === "linux" ? "  (Linux also needs: bubblewrap, socat, ripgrep)" : "";
    return `Fix: cd ${EXTENSION_DIR} && npm install${linux}`;
  }

  async init({ cwd, noSandbox, hasUI, notify, profile, askHost, drainBlockedHosts }: InitOptions): Promise<void> {
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
    this.hasUI = hasUI;
    this.notifyFn = notify;
    this.askHost = askHost;
    this.drainBlockedHosts = drainBlockedHosts;

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

    // Clear any 0-byte placeholders a pi that died mid-command left behind
    // (a stale .git would break every run).
    removeSandboxPlaceholders(cwd);

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

    const cfg = profileToConfig(profile);
    const key = JSON.stringify({ n: cfg.network, f: cfg.filesystem });
    if (this.ready && key === this.appliedKey) return;

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
