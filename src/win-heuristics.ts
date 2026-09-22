/**
 * Windows (PowerShell) privilege escalation and escape heuristics.
 *
 * Detects privilege escalation and out-of-project access in PowerShell
 * commands. This is a regex-based heuristic — the real enforcement comes from
 * the sandbox controller's path confinement and the policy engine.
 *
 * Pure and SDK-free so it can be unit-tested.
 */

import os from "node:os";
import path from "node:path";
import { isOutside, SAFE_OUTSIDE_RE } from "./paths.ts";
import {
  isWindowsSystemPath,
  isRegistryHivePath,
  WINDOWS_ENV_PROTECTED,
  WINDOWS_PROTECTED_FILES,
  getDriveLetter,
  isWindowsHomePath,
  isDriveLetterPath,
} from "./win-paths.ts";

/**
 * Windows privilege escalation patterns.
 * Matches PowerShell elevation commands, runas, and other elevation vectors.
 */
const WINDOWS_PRIVILEGE_RE =
  /\b(runas|powershell\s+-verb\s+runas|start-process.*-verb\s+runas|schtasks.*-create|net\s+localgroup\s+administrators|add-localgroupmember|set-credential|invoke-command\s+-credential|start-transcript.*-path\s+c:\\|fsutil.*set|diskpart)\b/i;

/**
 * PowerShell cmdlets that can modify system state or escape the project.
 */
const POWERSHELL_SYSTEM_CMDLETS = [
  "Set-Location",
  "cd",
  "Copy-Item",
  "Move-Item",
  "Remove-Item",
  "New-Item",
  "Set-Content",
  "Add-Content",
  "Out-File",
  "ForEach-Object",
  "Get-ChildItem",
  "Invoke-Expression",
  "Iex",
  "Invoke-Command",
  "Start-Process",
  "Start-Transcript",
  "Register-ScheduledTask",
  "New-Service",
  "Set-Service",
  "Stop-Service",
  "Restart-Service",
];

/**
 * PowerShell aliases for system-modifying cmdlets.
 */
const PS_ALIASES: Record<string, string[]> = {
  del: ["Remove-Item", "del", "erase", "rm", "rmdir", "rd"],
  copy: ["Copy-Item", "copy", "cp", "xcopy"],
  move: ["Move-Item", "move", "mv", "move-item"],
  mkdir: ["New-Item", "mkdir", "md", "mkdir-item"],
  cls: ["Clear-Host", "cls", "clear"],
  pwd: ["Get-Location", "pwd"],
  ls: ["Get-ChildItem", "ls", "dir", "gci"],
  cat: ["Get-Content", "cat", "type", "gc"],
  more: ["Get-Content", "more"],
  echo: ["Write-Output", "echo", "write-output", "printf"],
  rm: ["Remove-Item", "rm", "del", "erase", "rmdir", "rd"],
  ren: ["Rename-Item", "ren", "rename"],
  tree: ["Get-ChildItem", "tree"],
  grep: ["Select-String", "grep", "findstr", "sls"],
  find: ["Findstr", "find", "where", "gci"],
  sort: ["Sort-Object", "sort", "sort-object"],
  uniq: ["Sort-Object", "Get-Unique", "sort", "select-unique"],
  head: ["Select-Object", "head", "select-object"],
  tail: ["Select-Object", "tail"],
  xargs: ["ForEach-Object", "xargs"],
  tr: ["Translate", "tr"],
  wc: ["Measure-Object", "wc"],
  which: ["Get-Command", "where", "which", "gcm"],
  whoami: ["whoami", "whoami.exe"],
  id: ["id", "id.exe"],
  env: ["Get-ChildItem", "env", "dir", "ls", "environment"],
};

/**
 * Return the canonical name for a PowerShell command/alias, or undefined.
 */
function psCanonicalName(cmd: string): string | undefined {
  const lower = cmd.toLowerCase().replace(/\.exe$/, "");

  // Direct match against known cmdlets
  if (POWERSHELL_SYSTEM_CMDLETS.includes(lower)) return lower;

  // Check aliases
  for (const [alias, cmds] of Object.entries(PS_ALIASES)) {
    if (alias === lower) {
      return cmds[0];
    }
    if (cmds.includes(lower)) {
      return cmds[0];
    }
  }

  return undefined;
}

/**
 * Check if a PowerShell command string attempts privilege escalation.
 */
export function isWinPrivilegeEscalation(command: string): boolean {
  if (WINDOWS_PRIVILEGE_RE.test(command)) return true;

  // Check for Start-Process with -Verb RunAs
  if (/start-process\b.*-verb\s+runas\b/i.test(command)) return true;

  // Check for runas command
  if (/^runas\b/i.test(command.trim())) return true;

  return false;
}

/**
 * Check if a PowerShell path argument escapes the project.
 * Handles Windows paths, Git Bash paths, and mixed formats.
 */
function isWinOutsideProject(pathArg: string, root: string): string | undefined {
  if (!pathArg) return undefined;

  // Skip environment variables, pipes, operators
  if (/^[|$&;<>(){}[\]]/.test(pathArg)) return undefined;
  if (/^[-\/]/.test(pathArg)) return undefined;

  // Normalize the path argument
  let normalized = pathArg.replace(/\//g, "\\");

  // Expand ~ and $HOME
  const home = os.homedir();
  if (normalized.startsWith("~\\") || normalized.startsWith("~/") || normalized.startsWith("~")) {
    normalized = path.join(home, normalized.slice(1));
  }
  if (normalized.startsWith("$HOME\\") || normalized.startsWith("$HOME/")) {
    normalized = path.join(home, normalized.slice(6));
  }
  if (/^\$env:HOME[\\\/]/i.test(normalized) || /^\$env:USERPROFILE[\\\/]/i.test(normalized)) {
    normalized = home + normalized.match(/[\\\/].*$/)?.[0];
  }
  // C:\Users\... paths (absolute Windows paths)
  if (isDriveLetterPath(normalized)) {
    const homeUpper = home.toUpperCase().replace(/\\/g, "\\\\");
    const normUpper = normalized.toUpperCase();

    // If it's on a different drive than the project, it's outside
    const projectDrive = getDriveLetter(root);
    const argDrive = getDriveLetter(normalized);
    if (projectDrive && argDrive && argDrive.toUpperCase() !== projectDrive.toUpperCase()) {
      return pathArg;
    }
    // Same drive but not under project root. Separator-aware via path.relative
    // — a bare /^prefix/ regex (a) interpolates the root unescaped (regex
    // metachars in the root break or widen it) and (b) is a prefix match that
    // wrongly treats sibling dirs (proj2 under proj) as inside.
    const rel = path.relative(root.replace(/\\$/, ""), normalized);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return pathArg;
    }
    return undefined;
  }

  // Try the standard isOutside check
  try {
    const target = path.resolve(root, normalized);
    if (SAFE_OUTSIDE_RE.test(target)) return undefined;
    if (isOutside(root, normalized)) return pathArg;
  } catch {
    // resolve can fail on invalid paths
  }

  return undefined;
}

/**
 * Check if a PowerShell path is protected.
 */
export function isWinProtectedPath(p: string): boolean {
  const normalized = p.replace(/\//g, "\\");

  // Windows system paths
  if (isWindowsSystemPath(normalized)) return true;

  // Registry hive files
  if (isRegistryHivePath(normalized)) return true;

  // Protected directories
  const segments = normalized.split("\\");
  for (const seg of segments) {
    if (seg === "Windows" || seg === "System32" || seg === "SysWOW64") return true;
  }

  // Protected files
  const base = segments[segments.length - 1];
  if (base && WINDOWS_PROTECTED_FILES.has(base.toLowerCase())) return true;

  // Standard protected paths
  if (base === ".env" || base.startsWith(".env.")) return true;
  if ([".gitconfig", ".gitmodules", ".npmrc"].includes(base)) return true;

  return false;
}

/**
 * Check if a PowerShell path is under a protected system area.
 */
export function isWinSystemPath(p: string): boolean {
  const normalized = p.replace(/\//g, "\\");
  return isWindowsSystemPath(normalized) || isRegistryHivePath(normalized);
}

/**
 * Check if a PowerShell command attempts to access system environment or variables.
 */
export function isWinEnvAccess(command: string): boolean {
  // Check for env variable manipulation
  const envPatterns = [
    /\b(set|export|env:|\$env:|setx)\b.*\b(PATH|SYSTEMROOT|WINDIR|PROGRAMFILES|PROGRAMDATA)\b/i,
    /\b(set-item\s+itemprovider:\s+registry:|reg\s+add\b)/i,
  ];
  for (const pat of envPatterns) {
    if (pat.test(command)) return true;
  }
  return false;
}

/**
 * Returns a human-readable reason to prompt before running a PowerShell
 * command, or undefined when the heuristic finds nothing concerning.
 */
export function winBashConfirmReason(command: string, root: string): string | undefined {
  // Check privilege escalation first
  if (isWinPrivilegeEscalation(command)) return "privilege escalation";

  // Check for environment manipulation
  if (isWinEnvAccess(command)) return "system environment access";

  // Extract path arguments and check each
  // PowerShell path-like tokens: after -, or standalone, or in -Path, -FilePath, etc.
  const pathFlags = new Set(["-path", "-filepath", "-literpath", "-targetpath", "-workingdirectory", "-destination", "-inputpath", "-outpath", "-outputpath", "-from", "-to", "-value", "-argumentlist", "-credential"]);
  const tokens = command.split(/[\s|&;()<>{}]+/).filter(Boolean);

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    // Skip PowerShell operators and keywords
    if (/^[-$&|;<>{}()[\]]/.test(tok)) {
      if (pathFlags.has(tok.toLowerCase())) {
        // Next token is likely a path
        const next = tokens[i + 1];
        if (next && !next.startsWith("-") && !pathFlags.has(next.toLowerCase())) {
          const escaped = isWinOutsideProject(next, root);
          if (escaped) return `path outside project: ${escaped}`;
          if (isWinProtectedPath(next)) return `protected path: ${next}`;
          if (isWinSystemPath(next)) return `system path: ${next}`;
        }
      }
      continue;
    }

    // Check if token looks like a path (contains \ or /, or is a drive letter path)
    if (tok.includes("\\") || tok.includes("/") || tok.match(/^[a-zA-Z]:[\\\/]$/)) {
      const escaped = isWinOutsideProject(tok, root);
      if (escaped) return `path outside project: ${escaped}`;
      if (isWinProtectedPath(tok)) return `protected path: ${tok}`;
      if (isWinSystemPath(tok)) return `system path: ${tok}`;
    }
  }

  return undefined;
}
