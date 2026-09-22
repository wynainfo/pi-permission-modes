/**
 * Windows-specific path utilities for containment checks.
 *
 * Provides path normalization and protected-path detection for native Windows
 * environments where the OS-level sandbox (bubblewrap/sandbox-exec) is not
 * available. This module is pure and SDK-free.
 */

import os from "node:os";
import path from "node:path";

/**
 * Normalize a path for Windows containment checks. Handles:
 * - Git Bash paths: /c/Users/... → C:\Users\...
 * - Drive-letter paths: C:\Users\... (passthrough)
 * - UNC paths: \\server\share (passthrough)
 * - Mixed slashes: C:/Users/... → C:\Users\...
 */
export function normalizeWindowsPath(p: string): string {
  if (!p) return p;

  // Git Bash / WSL-style: /c/Users/... → C:\Users\...
  const m = p.match(/^\/([a-zA-Z])\//);
  if (m) {
    const drive = m[1].toUpperCase();
    const rest = p.slice(m.index! + m[0].length);
    return drive + `:\\${rest.replace(/\//g, "\\")}`;
  }

  // Normalize mixed slashes to backslashes on Windows
  if (p.includes("/")) {
    return p.replace(/\//g, "\\");
  }

  return p;
}

/**
 * Check if a path is a Windows drive letter path (e.g., C:\, D:\).
 */
export function isDriveLetterPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p);
}

/**
 * Get the drive letter from a Windows path, or undefined.
 */
export function getDriveLetter(p: string): string | undefined {
  const m = /^[a-zA-Z]:/.exec(p);
  return m?.[0].slice(0, 1);
}

/**
 * Check if a path is under the Windows system area.
 */
export function isWindowsSystemPath(p: string): boolean {
  const normalized = p.replace(/\//g, "\\").toUpperCase();

  const systemPrefixes = [
    "C:\\WINDOWS\\SYSTEM32",
    "C:\\WINDOWS\\SYSWOW64",
    "C:\\WINDOWS\\SYSTEM",
    "C:\\WINDOWS",
  ];

  for (const prefix of systemPrefixes) {
    if (normalized.startsWith(prefix)) return true;
  }

  // Check if any segment matches system directories anywhere in the path
  const segments = normalized.split("\\");
  const protectedSegments = new Set([
    "WINDOWS",
    "SYSTEM32",
    "SYSWOW64",
    "SYSTEM",
    "PROGRAM FILES",
    "PROGRAMFILES",
    "PROGRAMDATA",
    "PROGRAMDATA",
    "WINDOWSSYSTEM32",
  ]);

  for (const seg of segments) {
    if (protectedSegments.has(seg)) return true;
  }

  return false;
}

/**
 * Protected directories for Windows containment.
 * These are directories that should trigger prompts or blocks when accessed.
 */
export const WINDOWS_PROTECTED_DIRS = [
  ".git",
  "node_modules",
  ".vscode",
  ".idea",
  "Windows",
  "System32",
  "SysWOW64",
  "Program Files",
  "ProgramData",
  "WindowsApps",
];

/**
 * Windows protected file basenames (shell configs, system files).
 */
export const WINDOWS_PROTECTED_FILES = new Set([
  // Windows shell configs
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".profile",
  ".gitconfig",
  ".gitmodules",
  ".npmrc",
  // System files that should not be written
  "bootmgr",
  "ntldr",
  "pagefile.sys",
  "swapfile.sys",
  "hiberfil.sys",
]);

/**
 * Windows environment variable prefixes to protect in heuristics.
 */
export const WINDOWS_ENV_PROTECTED = new Set([
  "PATH",
  "SYSTEMROOT",
  "WINDIR",
  "PROGRAMFILES",
  "PROGRAMDATA",
  "PROGRAMFILES(X86)",
  "ALLUSERSPROFILE",
]);

/**
 * Check if a path is a Windows home directory path.
 */
export function isWindowsHomePath(p: string): boolean {
  const home = os.homedir();
  const normalized = p.replace(/\//g, "\\").toUpperCase();
  const homeUpper = home.toUpperCase();
  return normalized.startsWith(homeUpper);
}

/**
 * Check if a path refers to a registry hive file (Windows SAM, SYSTEM, etc.).
 */
export function isRegistryHivePath(p: string): boolean {
  const upper = p.replace(/\//g, "\\").toUpperCase();
  const hivePatterns = [
    "\\SYSTEM32\\CONFIG\\SAM",
    "\\SYSTEM32\\CONFIG\\SYSTEM",
    "\\SYSTEM32\\CONFIG\\SOFTWARE",
    "\\SYSTEM32\\CONFIG\\SECURITY",
    "\\SYSTEM32\\CONFIG\\DEFAULT",
  ];
  for (const pat of hivePatterns) {
    if (upper.endsWith(pat)) return true;
  }
  return false;
}
