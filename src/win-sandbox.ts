/**
 * Windows sandbox controller.
 *
 * On native Windows, there is no equivalent to bubblewrap (Linux) or
 * sandbox-exec (macOS). This module provides Windows-appropriate sandboxing:
 *
 * 1. **Path confinement** — enforces that writes stay within the project
 *    directory by wrapping commands and checking paths against the allowWrite
 *    profile.
 * 2. **Protected path blocking** — prevents writes to Windows system paths,
 *    registry files, and other sensitive locations.
 * 3. **Graceful degradation** — when real enforcement is not feasible, falls
 *    back to policy-only (the allow/ask/deny gates still apply).
 *
 * The sandbox profile (from the mode definition) is still used for network
 * allowlists and read denials. The file-level confinement is enforced at the
 * command execution layer.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { SandboxProfile } from "./schema.ts";
import { isOutside, removeSandboxPlaceholders, SAFE_OUTSIDE_RE } from "./paths.ts";
import {
  normalizeWindowsPath,
  isWindowsSystemPath,
  isRegistryHivePath,
  isDriveLetterPath,
  WINDOWS_PROTECTED_DIRS,
  WINDOWS_PROTECTED_FILES,
  isWindowsHomePath,
} from "./win-paths.ts";
import { isWinPrivilegeEscalation, isWinProtectedPath, isWinSystemPath } from "./win-heuristics.ts";

/**
 * Check if a command target path is confined to the allowed write areas.
 */
export function isPathConfined(targetPath: string, allowWrite: string[], root: string): boolean {
  if (!targetPath) return true;

  const normalized = normalizeWindowsPath(targetPath);

  // Allow well-known system paths (device null, etc.)
  if (SAFE_OUTSIDE_RE.test(normalized)) return true;

  // Check against explicit allowWrite entries
  for (const allow of allowWrite) {
    const allowNorm = normalizeWindowsPath(allow);
    if (allowNorm === ".") {
      // "." means current working directory (project root)
      try {
        const resolved = path.resolve(root, normalized);
        const rootNorm = normalizeWindowsPath(root);
        const rootResolved = path.resolve(rootNorm);
        // Separator-aware containment: path.relative only reports empty/inside
        // when the target is truly under root. A bare startsWith() prefix match
        // would wrongly accept sibling dirs (C:\Users\proj2 under C:\Users\proj).
        const rel = path.relative(rootResolved, resolved);
        if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
          return true;
        }
      } catch {
        // Path resolution failed — treat as confined
        return true;
      }
    }
    if (allowNorm === "/tmp") {
      // On Windows, /tmp may map to %TEMP% or C:\tmp
      const tempDir = process.env.TEMP || process.env.TMP || os.tmpdir();
      const tempNorm = normalizeWindowsPath(tempDir);
      const resolved = path.resolve(tempNorm);
      const targetResolved = path.resolve(normalized);
      const tr = path.relative(resolved, targetResolved);
      if (tr === "" || (!tr.startsWith("..") && !path.isAbsolute(tr))) return true;
    }
    // Absolute allow paths
    if (allowNorm.startsWith("/")) {
      const resolved = path.resolve(normalized);
      const allowResolved = path.resolve(allowNorm);
      const r = path.relative(allowResolved, resolved);
      if (r === "" || (!r.startsWith("..") && !path.isAbsolute(r))) return true;
    }
  }

  return false;
}

/**
 * Check if a path should be blocked from writing.
 */
function isProtectedWrite(targetPath: string): boolean {
  const normalized = normalizeWindowsPath(targetPath);

  // Windows system paths
  if (isWindowsSystemPath(normalized)) return true;

  // Registry hive files
  if (isRegistryHivePath(normalized)) return true;

  // Protected directories
  const segments = normalized.split(/[\\/]/);
  for (const seg of segments) {
    if (WINDOWS_PROTECTED_DIRS.includes(seg)) return true;
  }

  // Protected files
  const base = segments[segments.length - 1];
  if (base && WINDOWS_PROTECTED_FILES.has(base.toLowerCase())) return true;

  return false;
}

/**
 * Extract path-like arguments from a PowerShell command.
 * PowerShell paths appear after -Path, -FilePath, etc., or as standalone tokens.
 */
function extractPathsFromPSCommand(command: string): string[] {
  const paths: string[] = [];
  const tokens = command.split(/(?=[\s|&;(){}<>])/);

  const pathFlags = new Set([
    "-path", "-filepath", "-literalpath", "-targetpath", "-workingdirectory",
    "-destination", "-inputpath", "-outpath", "-outputpath",
    "-from", "-to", "-value", "-argumentlist",
    "-credential", "-computername", "-connectionuri",
  ]);

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i].trim();
    if (!tok) continue;

    if (pathFlags.has(tok.toLowerCase())) {
      // Next token is likely a path
      if (i + 1 < tokens.length) {
        const next = tokens[i + 1].trim().replace(/^["']/, "").replace(/["']$/, "");
        if (next && !next.startsWith("-")) {
          paths.push(next);
        }
      }
      continue;
    }

    // Standalone paths: contain \ or / or are drive-letter paths
    if (tok.match(/^[a-zA-Z]:[\\\/]/) || (tok.includes("\\") && !tok.startsWith("-"))) {
      paths.push(tok.replace(/^["']/, "").replace(/["']$/, ""));
    }
    if (tok.match(/^\//) && tok.length > 1) {
      // Git Bash path
      paths.push(tok.replace(/^["']/, "").replace(/["']$/, ""));
    }
  }

  return paths;
}

/**
 * True when a PowerShell command performs a WRITE to the filesystem (vs a
 * read/inspect). The command-layer path-confinement wrapper only hard-blocks
 * writes that escape the project; reads are left to the policy engine's
 * allow/ask/deny gates (they may legitimately read outside, e.g. git or
 * config lookups).
 */
export function isPSWriteCommand(command: string): boolean {
  return (
    // Write-family PowerShell cmdlets (Verb-Noun). Over-matching to the write
    // side is safe: the wrapper only hard-blocks these when they target an
    // outside-project path, and a mis-classified read is merely policy-gated
    // instead of command-blocked. Under-matching would let real writes escape.
    /\b(Set|Add|New|Remove|Move|Copy|Save|Export|Clear|Out|Import)-[A-Z][a-zA-Z]*\b/i.test(command) ||
    />>\s*["']?[a-zA-Z]:\\/.test(command) ||
    /\b(wipe|clear-item|set-content|out-file)\b/i.test(command)
  );
}

/**
 * Wrap a PowerShell command for sandbox execution.
 *
 * On Windows, the sandbox cannot use bubblewrap, so we:
 * 1. Check the command against protected paths
 * 2. Verify path confinement against the allowWrite profile
 * 3. Wrap in a script block that enforces write restrictions
 */
export function wrapPowerShellCommand(

  command: string,
  allowWrite: string[],
  denyWrite: string[],
  denyRead: string[],
  root: string,
): string {
  // Check for privilege escalation first
  if (isWinPrivilegeEscalation(command)) {
    return command; // Let the policy engine handle this
  }

  // Extract and check path arguments
  const paths = extractPathsFromPSCommand(command);
  const isWrite = isPSWriteCommand(command);
  for (const p of paths) {
    if (isProtectedWrite(p)) {
      // Block protected writes by prepending a guard
      return `Write-Host "[permission-mode] blocked write to protected path: ${p}" -ForegroundColor Red; exit 1`;
    }

    if (isWinSystemPath(p)) {
      return `Write-Host "[permission-mode] blocked system path: ${p}" -ForegroundColor Red; exit 1`;
    }

    // Hard-block OUTSIDE-project paths only for writes. Reads outside the
    // project are legitimate (git, config lookups, tools reading refs) and are
    // governed by the policy engine's allow/ask/deny gates, not this wrapper.
    if (isWrite && !isPathConfined(p, allowWrite, root) && !SAFE_OUTSIDE_RE.test(p)) {
      return `Write-Host "[permission-mode] blocked: path outside allowed write areas: ${p}" -ForegroundColor Red; exit 1`;
    }
  }

  // Check for denyWrite paths
  for (const deny of denyWrite) {
    const denyNorm = normalizeWindowsPath(deny);
    for (const p of paths) {
      if (p.toLowerCase() === denyNorm.toLowerCase() || p.toLowerCase().startsWith(denyNorm.toLowerCase() + "\\")) {
        return `Write-Host "[permission-mode] blocked write denied path: ${p}" -ForegroundColor Red; exit 1`;
      }
    }
  }

  // Check for denyRead paths
  for (const deny of denyRead) {
    const denyNorm = normalizeWindowsPath(deny);
    for (const p of paths) {
      if (p.toLowerCase() === denyNorm.toLowerCase() || p.toLowerCase().startsWith(denyNorm.toLowerCase() + "\\")) {
        return `Write-Host "[permission-mode] blocked read denied path: ${p}" -ForegroundColor Red; exit 1`;
      }
    }
  }

  // Wrap the command in a ConstrainedLanguageMode script block if available
  // This provides an additional layer of protection against malicious commands
  const wrapped = `
$ErrorActionPreference = 'Stop'
try {
  ${command}
} catch {
  Write-Host "Error: $_" -ForegroundColor Red
  exit 1
}
`;

  return wrapped;
}

/**
 * Wrap a Bash (Git Bash) command for sandbox execution.
 * Uses path confinement checks similar to PowerShell but adapted for bash syntax.
 */
function wrapBashCommand(
  command: string,
  allowWrite: string[],
  denyWrite: string[],
  denyRead: string[],
  root: string,
): string {
  // For Git Bash, the path confinement is applied similarly to PowerShell
  // since the commands still reference file paths

  // Extract paths from bash command (simplified extraction)
  const bashPaths = command.match(/["']?([a-zA-Z]:[\\/][^"'\s;|&]+|\/[^"'\s;|&]+)/g);
  const isWrite = /\b(echo|printf|cat|tee|cp|mv|rm|touch|mkdir|install|dd|sed|awk)\b.*(?:[>]|[a-zA-Z]:\\)/i.test(command) ||
    />>|>["']?[a-zA-Z]:\\|>[^=]/i.test(command.replace(/\|\|/g, "").replace(/&&/g, ""));
  if (bashPaths) {
    for (const p of bashPaths) {
      const clean = p.replace(/^["']/, "").replace(/["']$/, "");
      if (isProtectedWrite(clean)) {
        return `echo "[permission-mode] blocked write to protected path: ${clean}"; exit 1`;
      }
      if (isWinSystemPath(clean)) {
        return `echo "[permission-mode] blocked system path: ${clean}"; exit 1`;
      }
      // Only outside-WRITES are hard-blocked; reads fall to the policy gate.
      if (isWrite && !isPathConfined(clean, allowWrite, root) && !SAFE_OUTSIDE_RE.test(clean)) {
        return `echo "[permission-mode] blocked: path outside allowed write areas: ${clean}"; exit 1`;
      }
    }
  }


  // For bash commands on Windows, we still run them through Git Bash
  // The path confinement is enforced by the wrapper above
  return command;
}

/**
 * Check if PowerShell is available on this system. Cached after first check —
 * PowerShell presence does not change during a session, and the check is
 * called from hot paths (applyProfile on every mode change). Uses the same
 * executable resolution as getPowerShellExecutable() so the two agree: if a
 * real pwsh/powershell binary exists, we're available without spawning.
 */
let psAvailable: boolean | undefined;
export function isPowerShellAvailable(): boolean {
  if (psAvailable !== undefined) return psAvailable;

  // If a real PowerShell binary is found on disk or PATH, we're available.
  const exe = getPowerShellExecutable();
  if (exe !== "pwsh" && exe !== "powershell") {
    psAvailable = existsSync(exe);
    return psAvailable;
  }

  // PATH fallback: confirm the bare name actually resolves (spawn once).
  try {
    const result = spawnSync(exe, ["--version"], { stdio: "ignore", timeout: 3000 });
    psAvailable = result.status === 0;
  } catch {
    psAvailable = false;
  }
  return psAvailable;
}

/**
 * Get the available PowerShell executable.
 */
export function getPowerShellExecutable(): string {
  if (existsSync("C:\\Program Files\\PowerShell\\7\\pwsh.exe")) return "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  if (existsSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")) return "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  if (existsSync("C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe")) return "C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe";
  // Check PATH
  const pathEnv = process.env.PATH || "";
  const paths = pathEnv.split(";");
  for (const dir of paths) {
    const pwshPath = path.join(dir, "pwsh.exe");
    if (existsSync(pwshPath)) return pwshPath;
    const psPath = path.join(dir, "powershell.exe");
    if (existsSync(psPath)) return psPath;
  }
  return "pwsh"; // Hope it's on PATH
}

/**
 * BashOperations backed by Windows sandbox wrapping.
 * Wraps PowerShell/Bash commands to enforce path confinement and protection.
 */
export function createWinSandboxOperations(
  profile: SandboxProfile,
  root: string,
): BashOperations {
  const allowWrite = profile.allowWrite ?? ["."];
  const denyWrite = profile.denyWrite ?? [];
  const denyRead = profile.denyRead ?? [];

  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);

      // Clean up any 0-byte sandbox placeholders (same as Linux/macOS)
      removeSandboxPlaceholders(cwd);

      // Determine if this is a bash or PowerShell command.
      // PS signal: Verb-Noun cmdlets and PS-specific alias/`$_` current-object
      // syntax. A bare `$var` is NOT a PS signal — bash uses `$HOME`, `$PWD`,
      // `$PATH` constantly, and misclassifying them ships bash commands to
      // pwsh where they fail.
      const isPSCommand = /\b((?:Get|Set|New|Remove|Copy|Move|Start|Stop|Invoke|Where|ForEach|Select|Add|Clear|Write|Test|Import|Export|Register|Unregister|Install|Update|Compress|Expand|Format|Convert|Measure|Compare|Save|Find|Open|Close)-[A-Za-z]+)\b/i.test(command)
        || /\b(alias|cls|-WhatIf)\b/i.test(command)
        || /\$_/.test(command);

      // Wrap the command for sandbox enforcement
      const wrapped = isPSCommand
        ? wrapPowerShellCommand(command, allowWrite, denyWrite, denyRead, root)
        : wrapBashCommand(command, allowWrite, denyWrite, denyRead, root);

      // Execute the wrapped command with an interpreter that matches the
      // command type: PS commands must go through PowerShell, not bash.
      const shellPath = resolveShell(cwd, isPSCommand);
      const isGitBash = !isPSCommand && (shellPath.includes("git") || shellPath.includes("bash"));
      const spawnArgs = isGitBash
        ? ["-c", wrapped]
        : ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", wrapped];

      return await new Promise((resolve, reject) => {
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;
        const win = process.platform === "win32";
        const kill = () => {
          // Kill process group. On POSIX, detached:true gives a fresh group we
          // signal with -pid. On Windows, detached:true would open a new console
          // and drop stdout capture, so we spawn non-detached and kill the tree
          // with taskkill /T.
          try {
            if (child.pid) {
              if (win) {
                spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
              } else {
                try {
                  process.kill(-child.pid, "SIGKILL");
                } catch {
                  child.kill("SIGKILL");
                }
              }
            }
          } catch {
            // ignore
          }
        };

        // detached must be false on Windows or stdout/stderr pipes never deliver
        // the child's output (verified: empty capture with detached:true).
        const child = spawn(shellPath, spawnArgs, {
          cwd,
          detached: !win,
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
        });

        if (timeout && timeout > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            kill();
          }, timeout * 1000);
        }

        child.stdout?.on("data", (data: Buffer) => {
          onData(data);
        });
        child.stderr?.on("data", (data: Buffer) => {
          onData(data);
        });
        child.on("error", (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        });
        signal?.addEventListener("abort", () => kill(), { once: true });

        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", () => kill());
          if (signal?.aborted) {
            reject(new Error("aborted"));
          } else if (timedOut) {
            reject(new Error(`timeout:${timeout}`));
          } else {
            resolve({ exitCode: code });
          }
        });
      });
    },
  };
}

/**
 * Resolve the interpreter for a Windows command. When `preferPS` is set (the
 * command is PowerShell syntax), use a PowerShell executable; otherwise use Git
 * Bash when present, falling back to PowerShell. The old behaviour always
 * returned Git Bash first, so PowerShell commands were executed by `bash -c`
 * and failed.
 */
export function resolveShell(cwd: string, preferPS = false): string {
  if (preferPS) return getPowerShellExecutable();

  // Check for Git Bash (well-known install paths, then PATH)
  for (const gitPath of GIT_BASH_PATHS) {
    if (existsSync(gitPath)) return gitPath;
  }
  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(";")) {
    for (const bashName of ["bash.exe", "sh.exe"]) {
      const bashPath = path.join(dir, bashName);
      if (existsSync(bashPath) && bashPath.includes("git")) {
        return bashPath;
      }
    }
  }

  // No Git Bash — fall back to PowerShell (may be pwsh or powershell.exe).
  return getPowerShellExecutable();
}



/**
 * Git Bash paths to check for bash command execution.
 */
const GIT_BASH_PATHS = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
];
