import assert from "node:assert/strict";
import test from "node:test";
import { isOutsideWin, type WinPathCtx, winPathCandidate } from "./win-paths.ts";

const ctx: WinPathCtx = {
  root: "C:\\ws\\proj",
  home: "C:\\Users\\u",
  env: { USERPROFILE: "C:\\Users\\u", APPDATA: "C:\\Users\\u\\AppData\\Roaming", SystemRoot: "C:\\Windows" },
};

test("winPathCandidate: resolves Windows-shaped tokens", () => {
  const cases: Array<[string, string]> = [
    ["$env:USERPROFILE\\Documents\\tax_2025.pdf", "C:\\Users\\u\\Documents\\tax_2025.pdf"],
    ["${env:USERPROFILE}\\x", "C:\\Users\\u\\x"],
    ["$env:userprofile/x", "C:\\Users\\u\\x"],
    ["%USERPROFILE%\\x", "C:\\Users\\u\\x"],
    ["%appdata%\\x", "C:\\Users\\u\\AppData\\Roaming\\x"],
    ["$HOME/x", "C:\\Users\\u\\x"],
    ["$HOME", "C:\\Users\\u"],
    ["$USERPROFILE/x", "C:\\Users\\u\\x"],
    ["~", "C:\\Users\\u"],
    ["~\\x", "C:\\Users\\u\\x"],
    ["~/x", "C:\\Users\\u\\x"],
    ["C:\\Users\\u\\x", "C:\\Users\\u\\x"],
    ["c:/users/u/x", "c:\\users\\u\\x"],
    ["D:foo", "D:\\foo"],
    ["C:src\\a", "C:\\ws\\proj\\src\\a"],
    ["\\\\srv\\share\\x", "\\\\srv\\share\\x"],
    ["/c/Users/u/x", "C:\\Users\\u\\x"],
    ["..\\x", "C:\\ws\\x"],
    ["..", "C:\\ws"],
    [".\\src\\a", "C:\\ws\\proj\\src\\a"],
    ["src/a", "C:\\ws\\proj\\src\\a"],
    ["$PWD\\src", "C:\\ws\\proj\\src"],
    ['"$env:USERPROFILE"\\Documents', "C:\\Users\\u\\Documents"],
    ["FileSystem::C:\\x", "C:\\x"],
    ["Microsoft.PowerShell.Core\\FileSystem::C:\\x", "C:\\x"],
  ];
  for (const [tok, want] of cases) assert.equal(winPathCandidate(tok, ctx), want, tok);
});

test("winPathCandidate: non-path or unexpandable tokens are undefined", () => {
  for (const tok of ["git", "-Recurse", "$env:UNKNOWN\\x", "$null", "$_.FullName", "/tmp/x", "/dev/null", ""]) {
    assert.equal(winPathCandidate(tok, ctx), undefined, tok);
  }
});

test("isOutsideWin: containment is case-insensitive and boundary-aware", () => {
  assert.equal(isOutsideWin("C:\\ws\\proj", "C:\\ws\\proj"), false);
  assert.equal(isOutsideWin("C:\\ws\\proj", "c:\\WS\\Proj\\src\\a.ts"), false);
  assert.equal(isOutsideWin("C:\\ws\\proj", "C:\\ws\\proj2\\x"), true); // prefix trap
  assert.equal(isOutsideWin("C:\\ws\\proj", "C:\\ws"), true);
  assert.equal(isOutsideWin("C:\\ws\\proj", "C:\\Users\\u\\Documents\\x.pdf"), true);
  assert.equal(isOutsideWin("C:\\ws\\proj", "D:\\ws\\proj"), true);
  assert.equal(isOutsideWin("C:\\ws\\proj", "\\\\srv\\share"), true);
});
