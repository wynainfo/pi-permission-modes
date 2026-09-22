/**
 * Unit tests for win-paths.ts — pure path normalization and detection
 * utilities for Windows path confinement.
 *
 * These functions are pure and SDK-free, so they test easily without mocking.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeWindowsPath,
  isDriveLetterPath,
  getDriveLetter,
  isWindowsSystemPath,
  isWindowsHomePath,
  isRegistryHivePath,
  WINDOWS_PROTECTED_DIRS,
  WINDOWS_PROTECTED_FILES,
  WINDOWS_ENV_PROTECTED,
} from "./win-paths.ts";

// ---------------------------------------------------------------------------
// normalizeWindowsPath
// ---------------------------------------------------------------------------

test("normalizeWindowsPath: Git Bash paths", () => {
  assert.equal(normalizeWindowsPath("/c/Users/proj/src"), "C:\\Users\\proj\\src");
  assert.equal(normalizeWindowsPath("/d/workspace/main.ts"), "D:\\workspace\\main.ts");
});

test("normalizeWindowsPath: mixed slashes", () => {
  assert.equal(normalizeWindowsPath("C:/Users/proj/src"), "C:\\Users\\proj\\src");
  assert.equal(normalizeWindowsPath("a/b/c/d"), "a\\b\\c\\d");
});

test("normalizeWindowsPath: passthrough (already backslashes, drive-letter)", () => {
  assert.equal(normalizeWindowsPath("C:\\Users\\proj"), "C:\\Users\\proj");
});

test("normalizeWindowsPath: empty/null", () => {
  assert.equal(normalizeWindowsPath(""), ""); // returns empty string for empty input
  assert.equal(normalizeWindowsPath(null as unknown as string), null); // null input returns null
});

test("normalizeWindowsPath: UNC paths passthrough", () => {
  assert.equal(normalizeWindowsPath("\\\\server\\share"), "\\\\server\\share");
});

// ---------------------------------------------------------------------------
// isDriveLetterPath / getDriveLetter
// ---------------------------------------------------------------------------

test("isDriveLetterPath: recognizes drive-letter paths", () => {
  assert.ok(isDriveLetterPath("C:\\Users\\proj"));
  assert.ok(isDriveLetterPath("D:/workspace"));
  assert.ok(isDriveLetterPath("Z:\\"));
  assert.ok(isDriveLetterPath("Z:/"));
});

test("isDriveLetterPath: rejects non-drive paths", () => {
  assert.equal(isDriveLetterPath("/c/Users"), false);
  // C:\Windows\System32 IS a drive-letter path — the function matches any X:\ pattern.
  assert.equal(isDriveLetterPath("C:\\Windows\\System32"), true);
  assert.equal(isDriveLetterPath("no/drive"), false);
  assert.equal(isDriveLetterPath(""), false);
  // Just "C:" without a trailing slash is NOT a drive-letter path.
  assert.equal(isDriveLetterPath("C:"), false);
});

test("getDriveLetter: extracts drive letter", () => {
  assert.equal(getDriveLetter("C:\\Users"), "C");
  assert.equal(getDriveLetter("Z:\\temp"), "Z");
});

test("getDriveLetter: returns undefined for non-drive paths", () => {
  assert.equal(getDriveLetter("/c/Users"), undefined);
  assert.equal(getDriveLetter("no/drive"), undefined);
  assert.equal(getDriveLetter(""), undefined);
});

// ---------------------------------------------------------------------------
// isWindowsSystemPath
// ---------------------------------------------------------------------------

test("isWindowsSystemPath: system prefixes", () => {
  assert.ok(isWindowsSystemPath("C:\\Windows\\System32\\cmd.exe"));
  assert.ok(isWindowsSystemPath("C:\\WINDOWS\\SYSTEM"));
  assert.ok(isWindowsSystemPath("C:\\Windows\\SysWOW64\\wow64.dll"));
  assert.ok(isWindowsSystemPath("C:\\Windows"));
});

test("isWindowsSystemPath: segment detection", () => {
  assert.ok(isWindowsSystemPath("C:\\Program Files\\App"));
  assert.ok(isWindowsSystemPath("C:\\ProgramData\\foo"));
});

test("isWindowsSystemPath: non-system paths", () => {
  assert.ok(!isWindowsSystemPath("C:\\Users\\proj\\src"));
  assert.ok(!isWindowsSystemPath("D:\\Games\\App"));
});

// ---------------------------------------------------------------------------
// isWindowsHomePath
// ---------------------------------------------------------------------------

test("isWindowsHomePath: matches home directory", async () => {
  const { homedir } = await import("node:os");
  const home = homedir();
  if (!home) return;
  const result = isWindowsHomePath(home);
  assert.equal(result, true);
  const result2 = isWindowsHomePath(home + "\\some\\file");
  assert.equal(result2, true);
});

test("isWindowsHomePath: non-home paths", () => {
  const result = isWindowsHomePath("Z:\\other\\path");
  assert.equal(result, false);
});

// ---------------------------------------------------------------------------
// isRegistryHivePath
// ---------------------------------------------------------------------------

test("isRegistryHivePath: recognized hive patterns", () => {
  assert.ok(isRegistryHivePath("C:\\Windows\\System32\\Config\\SAM"));
  assert.ok(isRegistryHivePath("C:\\Windows\\System32\\Config\\SYSTEM"));
  assert.ok(isRegistryHivePath("C:\\Windows\\System32\\Config\\SOFTWARE"));
  assert.ok(isRegistryHivePath("C:\\Windows\\System32\\Config\\SECURITY"));
  assert.ok(isRegistryHivePath("C:\\Windows\\System32\\Config\\DEFAULT"));
});

test("isRegistryHivePath: non-hive paths", () => {
  assert.ok(!isRegistryHivePath("C:\\Users\\proj\\config.json"));
  assert.ok(!isRegistryHivePath("C:\\Windows\\System32\\drivers"));
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test("WINDOWS_PROTECTED_DIRS: includes expected entries", () => {
  assert.ok(WINDOWS_PROTECTED_DIRS.includes(".git"));
  assert.ok(WINDOWS_PROTECTED_DIRS.includes("node_modules"));
  assert.ok(WINDOWS_PROTECTED_DIRS.includes("Windows"));
  assert.ok(WINDOWS_PROTECTED_DIRS.includes("System32"));
  assert.ok(WINDOWS_PROTECTED_DIRS.includes("Program Files"));
});

test("WINDOWS_PROTECTED_FILES: includes expected entries", () => {
  assert.ok(WINDOWS_PROTECTED_FILES.has(".gitconfig"));
  assert.ok(WINDOWS_PROTECTED_FILES.has("bootmgr"));
  assert.ok(WINDOWS_PROTECTED_FILES.has("pagefile.sys"));
});

test("WINDOWS_ENV_PROTECTED: includes expected entries", () => {
  assert.ok(WINDOWS_ENV_PROTECTED.has("PATH"));
  assert.ok(WINDOWS_ENV_PROTECTED.has("SYSTEMROOT"));
  assert.ok(WINDOWS_ENV_PROTECTED.has("WINDIR"));
  assert.ok(WINDOWS_ENV_PROTECTED.has("PROGRAMFILES"));
});
