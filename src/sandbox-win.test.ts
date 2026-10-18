import assert from "node:assert/strict";
import test from "node:test";
import {
  findGitBash,
  gitIdentityEnv,
  parseProbe,
  probeAdvice,
  probeProblem,
  probeScript,
  probeTargets,
  readGitIdentity,
  stagedSrtWinPath,
} from "./sandbox-win.ts";

const existsIn = (files: string[]) => (p: string) => files.map((f) => f.toLowerCase()).includes(p.toLowerCase());

test("findGitBash: derives bash.exe from git.exe on PATH (cmd, bin, mingw64\\bin)", () => {
  const bash = "D:\\Tools\\Git\\bin\\bash.exe";
  for (const gitDir of ["D:\\Tools\\Git\\cmd", "D:\\Tools\\Git\\bin", "D:\\Tools\\Git\\mingw64\\bin"]) {
    const env = { PATH: `C:\\Windows;${gitDir}` };
    assert.equal(findGitBash(env, existsIn([`${gitDir}\\git.exe`, bash])), bash, gitDir);
  }
});

test("findGitBash: falls back to Program Files", () => {
  const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
  assert.equal(findGitBash({ PATH: "", ProgramFiles: "C:\\Program Files" }, existsIn([bash])), bash);
});

test("findGitBash: per-user installs count only when the profile is readable", () => {
  const userGit = "C:\\Users\\me\\AppData\\Local\\Programs\\Git";
  const env = { PATH: `${userGit}\\cmd`, USERPROFILE: "C:\\Users\\me" };
  const exists = existsIn([`${userGit}\\cmd\\git.exe`, `${userGit}\\bin\\bash.exe`]);
  assert.equal(findGitBash(env, exists), undefined);
  assert.equal(findGitBash(env, exists, true), `${userGit}\\bin\\bash.exe`);
});

test("findGitBash: never picks System32's WSL bash.exe", () => {
  const env = { PATH: "C:\\Windows\\System32" };
  assert.equal(findGitBash(env, existsIn(["C:\\Windows\\System32\\bash.exe"])), undefined);
});

test("readGitIdentity + gitIdentityEnv: host identity as sandbox environment, nothing when unset", () => {
  const id = readGitIdentity("C:\\ws\\proj", (args) => {
    if (args[2] === "user.name") return "Ann O'Neil\n";
    throw new Error("exit 1");
  });
  assert.deepEqual(id, { name: "Ann O'Neil", email: undefined });
  assert.deepEqual(gitIdentityEnv(id.name, id.email), { GIT_AUTHOR_NAME: "Ann O'Neil", GIT_COMMITTER_NAME: "Ann O'Neil" });
  assert.deepEqual(gitIdentityEnv(undefined, "a@b"), { GIT_AUTHOR_EMAIL: "a@b", GIT_COMMITTER_EMAIL: "a@b" });
  assert.deepEqual(gitIdentityEnv(), {});
});

test("probeTargets: parent, drive root and the srt-win folder, de-duplicated", () => {
  assert.deepEqual(probeTargets("C:\\ws\\proj", "C:\\ws\\proj\\node_modules\\srt\\srt-win.exe"), [
    "C:\\ws",
    "C:\\",
    "C:\\ws\\proj\\node_modules\\srt",
  ]);
  assert.deepEqual(probeTargets("C:\\proj", "C:\\ext\\srt-win.exe"), ["C:\\", "C:\\ext"]);
});

test("probeScript: stats the parent and tries one file per target", () => {
  const s = probeScript("C:\\ws\\proj", ["C:\\ws", "C:\\"], "abc");
  assert.match(s, /ls -ld 'C:\/ws'/);
  assert.match(s, /: > 'C:\/ws\/\.pi-srt-probe-abc'/);
  assert.match(s, /: > 'C:\/\.pi-srt-probe-abc'/);
  assert.match(s, /PI-SRT-PROBE DONE$/);
  // A project at a drive root has no parent to stat.
  assert.doesNotMatch(probeScript("C:\\", ["C:\\"], "abc"), /ls -ld/);
});

test("parseProbe + probeProblem + probeAdvice: pass, writable, hidden parent, incomplete", () => {
  const ok = parseProbe("noise\r\nPI-SRT-PROBE DONE\r\n");
  assert.deepEqual(ok, { done: true, writable: [] });
  assert.equal(probeProblem(ok), undefined);
  const w = parseProbe("PI-SRT-PROBE WRITABLE C:\\ws\nPI-SRT-PROBE WRITABLE C:\\\nPI-SRT-PROBE DONE\n");
  assert.deepEqual(w.writable, ["C:\\ws", "C:\\"]);
  assert.match(probeProblem(w)!, /C:\\ws, C:\\ writable/);
  assert.match(probeAdvice(w), /Tighten the folder's ACL/);
  assert.match(probeAdvice(w), /docs\/troubleshooting\.md#windows-sandbox-self-check/);
  const h = parseProbe("PI-SRT-PROBE HIDDEN C:\\Users\\me\\code\nPI-SRT-PROBE DONE\n");
  assert.match(probeProblem(h)!, /can't see C:\\Users\\me\\code/);
  assert.match(probeAdvice(h), /sandbox\.allowRead/);
  const partial = parseProbe("PI-SRT-PROBE WRITABLE C:\\ws\n");
  assert.match(probeProblem(partial)!, /did not complete/);
  assert.match(probeAdvice(partial), /did not complete/);
});

test("stagedSrtWinPath: per-hash folder under LOCALAPPDATA", () => {
  const local = "C:\\Users\\me\\AppData\\Local";
  const p = stagedSrtWinPath(local, "C:\\x\\vendor\\srt-win.exe", Buffer.from("abc"));
  assert.match(p, /^C:\\Users\\me\\AppData\\Local\\pi-permission-modes\\srt-win-[0-9a-f]{12}\\srt-win\.exe$/);
  // A different helper build lands in a different folder.
  assert.notEqual(p, stagedSrtWinPath(local, "C:\\x\\vendor\\srt-win.exe", Buffer.from("abd")));
});
