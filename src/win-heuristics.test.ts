/**
 * Unit tests for win-heuristics.ts — Windows privilege escalation, protected-path,
 * and environment-access heuristics.
 *
 * Pure functions that can be tested without a real Windows environment.
 * The root parameter uses a fake project path for path containment tests.
 */

import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import {
  isWinPrivilegeEscalation,
  isWinProtectedPath,
  isWinSystemPath,
  isWinEnvAccess,
  winBashConfirmReason,
} from "./win-heuristics.ts";

// Fake project root used for path containment tests.
const FAKE_ROOT = "C:\\Users\\proj";

// ---------------------------------------------------------------------------
// isWinPrivilegeEscalation
// ---------------------------------------------------------------------------

test("isWinPrivilegeEscalation: detects runas", () => {
  assert.ok(isWinPrivilegeEscalation("runas /user:admin cmd"));
  assert.ok(isWinPrivilegeEscalation("RunAs /netonly /user:admin cmd"));
});

test("isWinPrivilegeEscalation: detects powershell -verb runas", () => {
  assert.ok(isWinPrivilegeEscalation("powershell -verb runas"));
  assert.ok(isWinPrivilegeEscalation("Start-Process notepad.exe -Verb RunAs"));
});

test("isWinPrivilegeEscalation: detects schtasks create", () => {
  // The regex pattern uses -create directly after schtasks, not /create.
  assert.ok(isWinPrivilegeEscalation("schtasks -create -tn evil -sc daily"));
});

test("isWinPrivilegeEscalation: detects net localgroup administrators", () => {
  assert.ok(isWinPrivilegeEscalation("net localgroup administrators user /add"));
});

test("isWinPrivilegeEscalation: detects diskpart", () => {
  assert.ok(isWinPrivilegeEscalation("diskpart /s script.txt"));
});

test("isWinPrivilegeEscalation: no false positives on plain commands", () => {
  assert.equal(isWinPrivilegeEscalation("Get-ChildItem C:\\Users"), false);
  assert.equal(isWinPrivilegeEscalation("Start-Process notepad.exe"), false);
  assert.equal(isWinPrivilegeEscalation("echo hello"), false);
  assert.equal(isWinPrivilegeEscalation("whoami"), false);
});

// ---------------------------------------------------------------------------
// isWinProtectedPath
// ---------------------------------------------------------------------------

test("isWinProtectedPath: Windows system paths", () => {
  assert.ok(isWinProtectedPath("C:\\Windows\\System32\\cmd.exe"));
  assert.ok(isWinProtectedPath("C:\\Windows\\SYSTEM32\\drivers"));
});

test("isWinProtectedPath: registry hive files", () => {
  assert.ok(isWinProtectedPath("C:\\Windows\\System32\\Config\\SAM"));
});

test("isWinProtectedPath: protected file basenames", () => {
  assert.ok(isWinProtectedPath("C:\\Users\\proj\\.gitconfig"));
  assert.ok(isWinProtectedPath("C:\\Users\\proj\\.bashrc"));
});

test("isWinProtectedPath: non-protected paths", () => {
  assert.equal(isWinProtectedPath("C:\\Users\\proj\\src\\app.ts"), false);
  assert.equal(isWinProtectedPath("C:\\Users\\proj\\package.json"), false);
});

// ---------------------------------------------------------------------------
// isWinSystemPath
// ---------------------------------------------------------------------------

test("isWinSystemPath: system and registry paths", () => {
  assert.ok(isWinSystemPath("C:\\Windows\\System32"));
  assert.ok(isWinSystemPath("C:\\Windows\\System32\\Config\\SAM"));
});

test("isWinSystemPath: non-system paths", () => {
  assert.equal(isWinSystemPath("C:\\Users\\proj"), false);
  // "Program Files" matches WINDOWS_PROTECTED_DIRS in win-paths,
  // so isWindowsSystemPath returns true — that's expected behavior.
  assert.equal(isWinSystemPath("C:\\Games\\App"), false);
});

// ---------------------------------------------------------------------------
// isWinEnvAccess
// ---------------------------------------------------------------------------

test("isWinEnvAccess: detects env variable manipulation", () => {
  assert.ok(isWinEnvAccess("set PATH=C:\\evil"));
  assert.ok(isWinEnvAccess("$env:PATH='C:\\evil'"));
  assert.ok(isWinEnvAccess("env:PATH='C:\\evil'"));
  assert.ok(isWinEnvAccess("setx PATH C:\\evil"));
  assert.ok(isWinEnvAccess("set-item itemprovider:registry:HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment PATH"));
  assert.ok(isWinEnvAccess("reg add HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment /v PATH"));
});

test("isWinEnvAccess: no false positives", () => {
  assert.equal(isWinEnvAccess("Get-ChildItem C:\\Users"), false);
  assert.equal(isWinEnvAccess("echo hello world"), false);
  assert.equal(isWinEnvAccess("Set-Content file.txt 'hello'"), false);
});

// ---------------------------------------------------------------------------
// winBashConfirmReason
// ---------------------------------------------------------------------------

test("winBashConfirmReason: detects privilege escalation", () => {
  const reason = winBashConfirmReason("runas /user:admin cmd", FAKE_ROOT);
  assert.equal(reason, "privilege escalation");
});

test("winBashConfirmReason: detects env access", () => {
  const reason = winBashConfirmReason("set PATH=C:\\evil", FAKE_ROOT);
  assert.equal(reason, "system environment access");
});

test("winBashConfirmReason: no reason for benign commands", () => {
  const reason = winBashConfirmReason('Get-ChildItem -Path "C:\\Users\\proj\\src"', FAKE_ROOT);
  assert.equal(reason, undefined);
});

test("winBashConfirmReason: detects protected path in path argument", () => {
  const reason = winBashConfirmReason('New-Item -Path "C:\\Windows\\System32\\evil.exe"', FAKE_ROOT);
  assert.ok(reason !== undefined, "should detect a reason");
});

test("winBashConfirmReason: handles standalone path tokens", () => {
  const reason = winBashConfirmReason('C:\\Windows\\System32\\cmd.exe', FAKE_ROOT);
  assert.ok(reason !== undefined, "should detect a reason for system path");
});

test("winBashConfirmReason: detects cross-drive path", () => {
  const result = winBashConfirmReason("D:\\data\\file.txt", "C:\\Users\\proj");
  assert.equal(result, "path outside project: D:\\data\\file.txt");
});

test("winBashConfirmReason: same-drive path outside project", () => {
  const result = winBashConfirmReason("C:\\Users\\other\\file.txt", "C:\\Users\\proj");
  assert.equal(result, "path outside project: C:\\Users\\other\\file.txt");
});

test("winBashConfirmReason: ~ path expansion outside project", () => {
  const home = os.homedir();
  if (!home) return;
  const result = winBashConfirmReason(`~\\file.txt`, "C:\\Users\\proj");
  if (home.toUpperCase().replace(/\\/g, "\\\\") !== "C:\\USERS\\PROJ") {
    assert.equal(result, `path outside project: ~\\file.txt`);
  } else {
    assert.equal(result, undefined);
  }
});

// Regression: same-prefix sibling dirs must be OUTSIDE the project (bare
// /^root/ prefix match wrongly treated proj2 and projX as inside proj).
test("winBashConfirmReason: sibling-dir escape is detected as outside", () => {
  for (const evil of [
    "C:\\Users\\proj2\\file.txt",
    "C:\\Users\\projX\\file.txt",
    "C:\\Users\\proj-other\\file.txt",
  ]) {
    const result = winBashConfirmReason(evil, "C:\\Users\\proj");
    assert.equal(result, `path outside project: ${evil}`, `sibling escape: ${evil}`);
  }
});


// Regression: a project root containing regex metacharacters (e.g. ".") must
// not widen the containment check (old code interpolated the root into
// new RegExp unescaped — a bare "." matched any char, so ANY same-drive path
// would "match" the root and read as inside).
test("winBashConfirmReason: dot-in-root is handled as a literal path", () => {
  const dotRoot = "C:\\Users\\a.b\\proj";
  // Inside stays inside.
  assert.equal(winBashConfirmReason("C:\\Users\\a.b\\proj\\src\\a.txt", dotRoot), undefined);
  // Same drive but a different sibling AFTER the dot-root is outside.
  assert.ok(winBashConfirmReason("C:\\Users\\a.b\\projX\\x.txt", dotRoot) !== undefined);
  // A wholly different dir on the same drive is outside.
  assert.ok(winBashConfirmReason("C:\\Users\\other\\x.txt", dotRoot) !== undefined);
});

// NOTE (documented limitation, not fixed here): PowerShell path args containing
// "(x)" are split by the winBashConfirmReason tokenizer (it splits on parens),
// so such paths read as truncated. Parenthesized dirs are rare; the sibling
// containment itself is separator-correct (see tests above).
