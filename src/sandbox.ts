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
import { gitFileDegradesSandbox, removeSandboxPlaceholders } from "./paths.ts";
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
// wrapWithSandbox embeds the command in a `bash -c` string that it quotes with
// the shell-quote package - up to three times over on Linux (eval line, inner
// script, outer bwrap line). Whenever the command contains a single quote,
// shell-quote picks its double-quoted form and escapes `!` as `\!`, which bash
// keeps LITERALLY inside double quotes (only $ ` " \ are unescaped there). So
// every heredoc, `python3 -c '...'`, or `printf` with an exclamation mark
// reached the sandboxed shell as `\!`: no error, just corrupted bytes.
//
// The fix never lets the command text near that quoting: the command goes into
// a private file on the host side (a directory the sandbox cannot write to,
// mode 0700/0600) and the runtime gets a LAUNCHER that contains neither a
// single quote nor an exclamation mark, so every quoting pass leaves it alone:
//
//   bash -c "$(<"/path/to/cmd")"
//
// The innermost bash reads the file with the `$(<file)` builtin and runs the
// content as an ordinary `bash -c` script: same $0, same "bash: line N" error
// prefixes, same exit status. No `exec`, on purpose - the runtime's network
// bridge runs the command from a shell whose EXIT trap stops its socat
// helpers, and that shell has to stay alive to fire it.

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
      // Clear any leftover 0-byte placeholders the sandbox plants for its
      // mandatory-deny paths (a stale .git would also break this run).
      removeSandboxPlaceholders(cwd);
      // Command transport (see above): the runtime quotes what we hand it, so
      // hand it a launcher and keep the real command in a file.
      const commandFile = writeCommandFile(command);
      const tmpdir = typeof env?.TMPDIR === "string" ? env.TMPDIR : undefined;
      const launcher = commandFile ? commandLauncher(commandFile, tmpdir) : undefined;
      try {
        // The signal rides into the runtime too (its project scan can take a
        // while on big trees); an abort during the wrap must not start the run.
        const wrapped = await SandboxManager.wrapWithSandbox(launcher ?? command, undefined, customConfig as never, signal as never);
        if (signal?.aborted) throw new Error("aborted");
        // `await` so the finally runs after the child exits, not after the
        // Promise is constructed — otherwise cleanup would race the run.
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
          child.stderr?.on("data", onData);
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
            emitBlockedHint();
            if (signal?.aborted) reject(new Error("aborted"));
            else if (timedOut) reject(new Error(`timeout:${timeout}`));
            else resolve({ exitCode: code });
          });
        });
      } finally {
        // Always delete the placeholders bwrap just planted, regardless of how
        // we leave: normal close, abort/timeout rejection, a throw from
        // wrapWithSandbox, or a synchronous spawn failure.
        removeSandboxPlaceholders(cwd);
        if (commandFile) rmSync(commandFile, { force: true });
      }
    },
  };
}

/**
 * The runtime starts its filtering proxy (and consults the ask callback)
 * ONLY when the allowlist is non-empty; an empty `allowedDomains` gets a bare
 * `--unshare-net` with no proxy, so the live prompts, `/net allow`, `/net
 * open`, and `request_network_access` would all be inert while the UI claims
 * otherwise. A reserved `.invalid` name (RFC 2606, never resolvable) stands in
 * so the proxy path always exists; it matches no real host.
 */
export const EMPTY_ALLOWLIST_SENTINEL = "allowlist-empty.invalid";

function runtimeNetwork(network: SandboxConfig["network"]): SandboxConfig["network"] {
  if (network?.allowedDomains && network.allowedDomains.length === 0) {
    return { ...network, allowedDomains: [EMPTY_ALLOWLIST_SENTINEL] };
  }
  return network;
}

/**
 * True when a profile filters network traffic at all: the runtime restricts
 * the network only when `allowedDomains` is DEFINED (an empty list blocks
 * everything but the prompt flow; an absent list means unrestricted).
 */
export function networkFiltered(profile: SandboxProfile): boolean {
  return profile.enabled && profile.network?.allowedDomains !== undefined;
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
  /** Platform/dependency/git issue — never (re)initialize the runtime. */
  private degraded = false;
  private hasUI = false;
  private notifyFn: Notify = () => {};
  private askHost: ((host: string, port: number | undefined) => Promise<boolean>) | undefined;
  private drainBlockedHosts: (() => string[]) | undefined;
  ready = false;
  disabled = false;
  warn: string | undefined;

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
    if (process.platform !== "darwin" && process.platform !== "linux") {
      this.warn = `sandbox unsupported on ${process.platform}`;
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
          `permission-mode: OS sandbox unavailable — protection is heuristic-only.\n${this.warn}\n` +
            SandboxController.installHint(),
        );
      }
      return;
    }

    // Clear any 0-byte placeholders left by a prior sandboxed run (incl. a stale
    // .git), so .git below isn't mistaken for a worktree.
    removeSandboxPlaceholders(cwd);

    // bubblewrap (Linux) unconditionally binds <cwd>/.git/hooks; if .git is a
    // REAL file (git worktree/submodule) that bind fails and every sandboxed
    // command errors — and we must not delete that legitimate file. Degrade to
    // prompting there. macOS's sandbox-exec profile denies the git paths
    // instead of mounting them, so worktrees sandbox normally on macOS.
    if (gitFileDegradesSandbox(cwd)) {
      this.degraded = true;
      this.profile = profile;
      this.warn = "sandbox off: project .git is a file (worktree/submodule); bwrap can't bind .git/hooks";
      if (hasUI) {
        notify(
          "permission-mode: OS sandbox disabled for this project — its `.git` is a file (git worktree/submodule), " +
            "which bubblewrap can't sandbox on Linux. In-project bash will prompt for confirmation instead. " +
            "Use a normal clone for full sandboxing.",
        );
      }
      return; // leave ready=false → the sandboxed modes degrade to prompting
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
      await this.manager.initialize(
        { network: runtimeNetwork(cfg.network), filesystem: cfg.filesystem } as never,
        ask ? (p: { host: string; port?: number }) => ask(p.host, p.port) : undefined,
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
