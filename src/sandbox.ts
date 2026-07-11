/**
 * OS-level sandbox lifecycle for Build mode.
 *
 * Wraps `@anthropic-ai/sandbox-runtime` (loaded lazily so a missing dependency
 * degrades gracefully instead of crashing) behind a small `SandboxController`
 * that owns init / wrap / reset and the readiness state surfaced in the footer.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { type SandboxConfig, profileToConfig, readOnlyOverride } from "./config-load.ts";
import { gitFileBlocksSandbox, removeSandboxPlaceholders } from "./paths.ts";
import type { SandboxProfile } from "./schema.ts";
import { isModuleNotFound } from "./util.ts";

// Real type of the runtime singleton, erased at compile time so a missing
// dependency never breaks loading. Replaces the former `any`.
type SandboxManagerType = typeof import("@anthropic-ai/sandbox-runtime").SandboxManager;

/** This extension's own directory (works wherever it's installed). */
const EXTENSION_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * BashOperations backed by `SandboxManager.wrapWithSandbox`. An optional
 * `customConfig` overrides the init-time config per command (used to drop write
 * access in Read mode without re-initializing the sandbox).
 */
export function createSandboxedBashOps(
  SandboxManager: SandboxManagerType,
  customConfig?: Partial<SandboxConfig>,
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
      // Clear any leftover 0-byte placeholders the sandbox plants for its
      // mandatory-deny paths (a stale .git would also break this run).
      removeSandboxPlaceholders(cwd);
      try {
        const wrapped = await SandboxManager.wrapWithSandbox(command, undefined, customConfig as never);
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
          child.on("error", (err) => {
            if (timer) clearTimeout(timer);
            reject(err);
          });
          const onAbort = () => kill();
          signal?.addEventListener("abort", onAbort, { once: true });
          child.on("close", (code) => {
            if (timer) clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
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
      }
    },
  };
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
  /** Platform/dependency/git issue — never (re)initialize the runtime. */
  private degraded = false;
  private hasUI = false;
  private notifyFn: Notify = () => {};
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
  bashOps(opts: { readOnly?: boolean } = {}): BashOperations | null {
    if (!this.manager || !this.profile) return null;
    const customConfig = opts.readOnly ? readOnlyOverride(profileToConfig(this.profile)) : undefined;
    return createSandboxedBashOps(this.manager, customConfig);
  }

  /** Install instructions shown when the runtime is missing or fails to init. */
  private static installHint(): string {
    const linux = process.platform === "linux" ? "  (Linux also needs: bubblewrap, socat, ripgrep)" : "";
    return `Fix: cd ${EXTENSION_DIR} && npm install${linux}`;
  }

  async init({ cwd, noSandbox, hasUI, notify, profile }: InitOptions): Promise<void> {
    this.ready = false;
    this.disabled = false;
    this.degraded = false;
    this.warn = undefined;
    this.manager = null;
    this.appliedKey = undefined;
    this.hasUI = hasUI;
    this.notifyFn = notify;

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

    // bubblewrap unconditionally binds <cwd>/.git/hooks; if .git is a REAL file
    // (git worktree/submodule) that bind fails and every sandboxed command
    // errors — and we must not delete that legitimate file. Degrade to prompting.
    if (gitFileBlocksSandbox(cwd)) {
      this.degraded = true;
      this.profile = profile;
      this.warn = "sandbox off: project .git is a file (worktree/submodule); bwrap can't bind .git/hooks";
      if (hasUI) {
        notify(
          "permission-mode: OS sandbox disabled for this project — its `.git` is a file (git worktree/submodule), " +
            "which bubblewrap can't sandbox. In-project bash will prompt for confirmation instead. " +
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
    if (this.degraded || !this.manager) return;
    if (!profile.enabled) return; // non-sandboxing mode (e.g. YOLO): keep prior init

    const cfg = profileToConfig(profile);
    const key = JSON.stringify({ n: cfg.network, f: cfg.filesystem });
    if (this.ready && key === this.appliedKey) return;

    try {
      if (this.ready) await this.manager.reset();
      await this.manager.initialize({ network: cfg.network, filesystem: cfg.filesystem } as never);
      this.ready = true;
      this.appliedKey = key;
      this.warn = undefined;
    } catch (err) {
      this.ready = false;
      this.warn = `sandbox init failed: ${err instanceof Error ? err.message : String(err)}`;
      if (this.hasUI) {
        this.notifyFn(
          `permission-mode: sandbox failed to initialize — protection is heuristic-only.\n${this.warn}` +
            `${process.platform === "linux" ? "\nLinux requires: bubblewrap, socat, ripgrep" : ""}`,
        );
      }
    }
  }

  async reset(): Promise<void> {
    if (this.ready && this.manager) {
      try {
        await this.manager.reset();
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
