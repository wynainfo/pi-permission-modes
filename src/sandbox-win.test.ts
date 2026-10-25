import assert from "node:assert/strict";
import test from "node:test";
import {
  expandWinEnv,
  findGitBash,
  gitConfigMasked,
  gitIdentityEnv,
  globalGitConfigSources,
  grantReadExecute,
  parseProbe,
  probeAdvice,
  probeNotice,
  probeProblem,
  probeScript,
  probeTargets,
  profileExclusionRelation,
  readGitIdentity,
  sandboxAceIn,
  stagedSrtWinPath,
  stageGitConfig,
  windowsEnvExports,
  windowsEnvFile,
  windowsGitEnv,
  windowsReadGrants,
  windowsScript,
  withWindowsReads,
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

test("findGitBash: per-user installs count only inside a readable root", () => {
  const userGit = "C:\\Users\\me\\AppData\\Local\\Programs\\Git";
  const env = { PATH: `${userGit}\\cmd`, USERPROFILE: "C:\\Users\\me" };
  const exists = existsIn([`${userGit}\\cmd\\git.exe`, `${userGit}\\bin\\bash.exe`]);
  assert.equal(findGitBash(env, exists), undefined);
  assert.equal(findGitBash(env, exists, ["C:\\Users\\me\\scoop"]), undefined);
  assert.equal(findGitBash(env, exists, ["C:\\Users\\me\\AppData\\Local\\Programs"]), `${userGit}\\bin\\bash.exe`);
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
  assert.equal(probeProblem(h), undefined, "an unreadable parent keeps the sandbox active");
  assert.match(probeNotice(h)!, /cannot read C:\\Users\\me\\code, the project's parent folder.*add the parent to the mode's allowRead/);
  assert.equal(probeNotice(ok), undefined);
  const partial = parseProbe("PI-SRT-PROBE WRITABLE C:\\ws\n");
  assert.match(probeProblem(partial)!, /did not complete/);
  assert.match(probeAdvice(partial), /did not complete/);
  // srt-win refused to launch (a mapped-drive working directory): the runtime's message is the reason.
  const refused = parseProbe("\n[permission-mode] sandbox: working directory X:\\proj is on a mapped drive.\n");
  assert.doesNotMatch(probeAdvice(refused), /\.\. /, "the runtime's own full stop is not doubled");
  assert.equal(refused.launchError, "working directory X:\\proj is on a mapped drive.");
  assert.equal(probeProblem(refused), "Windows sandbox off: working directory X:\\proj is on a mapped drive.");
  assert.match(probeAdvice(refused), /could not start a command in this project: working directory X:\\proj is on a mapped drive\. Drive mappings and UNC paths/);
  assert.match(probeAdvice(refused), /docs\/troubleshooting\.md#mapped-drive-or-unc-project-on-windows/);
  // A writable parent that is another session's project gets its own message.
  const nested = { ...w, granted: ["C:\\ws"] };
  assert.equal(probeProblem(nested), "Windows sandbox off: inside another sandboxed folder (C:\\ws)");
  assert.match(probeAdvice(nested), /another pi session runs in that folder or in one above it/);
  assert.match(probeAdvice(nested), /icacls "C:\\ws" \/remove:g srt-sandbox \/T/);
  assert.doesNotMatch(probeAdvice(nested), /drive root/);
});

test("stageGitConfig: the global config files in git's order, as one copy; none means undefined", () => {
  const env = { USERPROFILE: "C:\\Users\\me" };
  assert.deepEqual(globalGitConfigSources(env), ["C:\\Users\\me\\.config\\git\\config", "C:\\Users\\me\\.gitconfig"]);
  assert.deepEqual(globalGitConfigSources({ ...env, HOME: "D:\\h", XDG_CONFIG_HOME: "D:\\xdg" }), ["D:\\xdg\\git\\config", "D:\\h\\.gitconfig"]);
  assert.deepEqual(globalGitConfigSources({}), []);
  const files: Record<string, string> = {
    "C:\\Users\\me\\.gitconfig": "[user]\n\tname = Ann\n[credential \"https://github.com\"]\n\thelper = !f() { :; }; f\r\n",
    "C:\\Users\\me\\.config\\git\\config": "[core]\n\tautocrlf = true\n",
  };
  const written: Record<string, string> = {};
  const fs = { exists: (p: string) => p in files, read: (p: string) => files[p], write: (p: string, s: string) => void (written[p] = s) };
  const out = stageGitConfig("/cmd", env, fs);
  assert.equal(out, "/cmd/gitconfig");
  const body = written["/cmd/gitconfig"];
  assert.ok(body.indexOf("autocrlf") < body.indexOf("name = Ann"), "XDG first, ~/.gitconfig last so it wins");
  assert.match(body, /^# Your global git config, copied by pi-permission-modes/);
  assert.match(body, /# from C:\\Users\\me\\\.gitconfig\n\[user\]/);
  assert.doesNotMatch(body, /\r/);
  assert.equal(stageGitConfig("/cmd", { USERPROFILE: "C:\\Users\\nobody" }, fs), undefined);
});

test("gitConfigMasked: the most specific entry covering ~/.gitconfig decides, in ~, $HOME and expanded form", () => {
  const env = { USERPROFILE: "C:\\Users\\me" };
  assert.equal(gitConfigMasked({ denyRead: ["~/.ssh", "~/.aws"] }, env), false, "the stock denies leave it readable");
  assert.equal(gitConfigMasked({ denyRead: ["~"] }, env), true, "a strict home masks it");
  assert.equal(gitConfigMasked({ denyRead: ["$HOME"] }, env), true);
  assert.equal(gitConfigMasked({ denyRead: ["C:\\Users\\me\\"] }, env), true);
  assert.equal(gitConfigMasked({ denyRead: ["~"], allowRead: ["~/.gitconfig"] }, env), false, "re-allowed below the deny");
  assert.equal(gitConfigMasked({ denyRead: ["~/.gitconfig"], allowRead: ["~"] }, env), true, "the deny is the more specific");
  assert.equal(gitConfigMasked({}, env), false);
});

test("sandboxAceIn: finds the sandbox account by name or SID, explicit before inherited", () => {
  const explicit = [
    "C:\\Users\\me\\test NT AUTHORITY\\SYSTEM:(I)(OI)(CI)(F)",
    "                    BUILTIN\\Administrators:(I)(OI)(CI)(F)",
    "                    PC\\me:(I)(OI)(CI)(F)",
    "                    PC\\srt-sandbox:(OI)(CI)(M)",
    "",
    "Successfully processed 1 files; Failed processing 0 files",
  ].join("\r\n");
  assert.equal(sandboxAceIn(explicit), "explicit");
  const inherited = explicit.replace("srt-sandbox:(OI)(CI)(M)", "srt-sandbox:(I)(OI)(CI)(M)");
  assert.equal(sandboxAceIn(inherited), "inherited");
  const bySid = explicit.replace("PC\\srt-sandbox", "*S-1-5-21-1-2-3-1001");
  assert.equal(sandboxAceIn(bySid), undefined, "an unresolved SID is only matched when given");
  assert.equal(sandboxAceIn(bySid, "*S-1-5-21-1-2-3-1001"), "explicit");
  assert.equal(sandboxAceIn(bySid, "S-1-5-21-1-2-3-1001"), "explicit");
  assert.equal(sandboxAceIn(explicit.replace("srt-sandbox", "srt-sandbox-old")), undefined);
  assert.equal(sandboxAceIn(""), undefined);
});

test("stagedSrtWinPath: per-hash folder under LOCALAPPDATA", () => {
  const local = "C:\\Users\\me\\AppData\\Local";
  const p = stagedSrtWinPath(local, "C:\\x\\vendor\\srt-win.exe", Buffer.from("abc"));
  assert.match(p, /^C:\\Users\\me\\AppData\\Local\\pi-permission-modes\\srt-win-[0-9a-f]{12}\\srt-win\.exe$/);
  // A different helper build lands in a different folder.
  assert.notEqual(p, stagedSrtWinPath(local, "C:\\x\\vendor\\srt-win.exe", Buffer.from("abd")));
});

test("stagedSrtWinPath: the grantee is part of the folder name", () => {
  const local = "C:\\Users\\me\\AppData\\Local";
  const users = stagedSrtWinPath(local, "C:\\x\\srt-win.exe", Buffer.from("abc"));
  const sid = stagedSrtWinPath(local, "C:\\x\\srt-win.exe", Buffer.from("abc"), "*S-1-5-21-1-2-3-1001");
  assert.notEqual(users, sid);
});

test("grantReadExecute: one icacls per directory and grantee, inheriting read and execute", () => {
  const runs: string[][] = [];
  const run = (args: string[]) => {
    runs.push(args);
  };
  grantReadExecute("C:\\Users\\me\\AppData\\Local\\Temp\\pi-permission-mode-x", "*S-1-5-21-9", run);
  grantReadExecute("c:\\users\\me\\appdata\\local\\temp\\pi-permission-mode-x", "*S-1-5-21-9", run);
  grantReadExecute("C:\\Users\\me\\AppData\\Local\\Temp\\pi-permission-mode-x", "*S-1-5-21-10", run);
  assert.deepEqual(runs, [
    ["C:\\Users\\me\\AppData\\Local\\Temp\\pi-permission-mode-x", "/grant", "*S-1-5-21-9:(OI)(CI)RX"],
    ["C:\\Users\\me\\AppData\\Local\\Temp\\pi-permission-mode-x", "/grant", "*S-1-5-21-10:(OI)(CI)RX"],
  ]);
});

test("windowsEnvExports: forwards the caller's env minus identity, profile, temp, PATH, proxy and CA variables; extra wins", () => {
  const env = {
    FOO: "bar baz",
    PI_SESSION: "it's",
    USERPROFILE: "C:\\Users\\me",
    Path: "C:\\Windows",
    temp: "C:\\Users\\me\\AppData\\Local\\Temp",
    HTTPS_PROXY: "http://corp:3128",
    no_proxy: "localhost",
    SSL_CERT_FILE: "C:\\ca.pem",
    GIT_CONFIG_COUNT: "1",
    SRT_TOKEN: "x",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    EMPTY: "",
    GONE: undefined,
  };
  assert.deepEqual(windowsEnvExports(env, { GIT_AUTHOR_NAME: "Ann", FOO: "override", TMPDIR: "C:/tmp/pi/s" }), [
    "FOO='override'",
    "PI_SESSION='it'\\''s'",
    "EMPTY=''",
    "GIT_AUTHOR_NAME='Ann'",
    "TMPDIR='C:/tmp/pi/s'",
  ]);
});

test("windowsScript: sources the env file and runs the command file in a bash -c of its own; inlines when a path cannot be quoted", () => {
  const files = { env: "C:\\Users\\me\\AppData\\Local\\Temp\\pi-permission-mode-ab\\env-1.sh", cmd: "C:\\Users\\me\\AppData\\Local\\Temp\\pi-permission-mode-ab\\cmd-1.sh" };
  assert.equal(
    windowsScript("echo hi", files, ["A='1'"]),
    `. 'C:/Users/me/AppData/Local/Temp/pi-permission-mode-ab/env-1.sh'; bash -c "$(<"C:/Users/me/AppData/Local/Temp/pi-permission-mode-ab/cmd-1.sh")"`,
  );
  const odd = { env: "C:\\Users\\O'Neil\\env-1.sh", cmd: "C:\\Users\\O'Neil\\cmd-1.sh" };
  assert.equal(windowsScript("echo hi", odd, ["A='1'", "B='2'"]), "export A='1' B='2'; echo hi");
  assert.equal(windowsScript("echo hi", undefined, []), "echo hi");
  assert.equal(windowsEnvFile(["A='1'", "B='2'"]), "export A='1'\nexport B='2'\n");
});

test("profileExclusionRelation: equal, inside, above; one-name and prefix wildcards; the \\\\?\\ prefix and case are ignored", () => {
  const ssh = "\\\\?\\C:\\Users\\me\\.ssh";
  assert.equal(profileExclusionRelation("C:\\Users\\me\\.SSH", ssh), "equal");
  assert.equal(profileExclusionRelation("C:\\Users\\me\\.ssh\\id_ed25519", ssh), "inside");
  assert.equal(profileExclusionRelation("C:\\Users\\me", ssh), "above");
  assert.equal(profileExclusionRelation("C:\\Users\\me\\.sshx", ssh), undefined);
  assert.equal(profileExclusionRelation("D:\\tools", ssh), undefined);
  const web = "C:\\Users\\me\\AppData\\Local\\*\\EBWebView";
  assert.equal(profileExclusionRelation("C:\\Users\\me\\AppData\\Local\\Teams\\EBWebView\\Default", web), "inside");
  assert.equal(profileExclusionRelation("C:\\Users\\me\\AppData\\Local\\Teams", web), "above");
  assert.equal(profileExclusionRelation("C:\\Users\\me\\AppData\\Local\\Teams\\Cache", web), undefined);
  const vault = "C:\\Users\\me\\AppData\\Local\\Microsoft\\Vault*";
  assert.equal(profileExclusionRelation("C:\\Users\\me\\AppData\\Local\\Microsoft\\Vault2", vault), "equal");
  assert.equal(profileExclusionRelation("C:\\Users\\me\\AppData\\Local\\Microsoft\\Vault2\\x.vcrd", vault), "inside");
  assert.equal(profileExclusionRelation("C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge", vault), undefined);
});

test("windowsReadGrants: the tool roots that exist, expanded from the environment, deduplicated", () => {
  const env = { USERPROFILE: "C:\\Users\\me", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", AppData: "C:\\Users\\me\\AppData\\Roaming" };
  const present = ["C:\\Users\\me\\AppData\\Local\\Programs", "C:\\Users\\me\\AppData\\Roaming\\npm", "C:\\Users\\me\\scoop"];
  assert.deepEqual(windowsReadGrants(env, existsIn(present)), present);
  assert.deepEqual(windowsReadGrants({}, () => true), [], "an unexpanded %VAR% is never granted");
  assert.equal(expandWinEnv("%localappdata%\\x", env), "C:\\Users\\me\\AppData\\Local\\x");
});

test("withWindowsReads: the grants become allowRead unless the mode sets its own", () => {
  const p = { enabled: true, writable: true, allowWrite: ["."], denyRead: ["~/.ssh"] };
  const grants = ["C:\\Users\\me\\AppData\\Local\\Programs"];
  assert.deepEqual(withWindowsReads(p, grants).allowRead, grants);
  const own = { ...p, allowRead: ["~/.gitconfig"] };
  assert.equal(withWindowsReads(own, grants), own);
  assert.equal(withWindowsReads(p, []), p);
  const yolo = { enabled: false, writable: true };
  assert.equal(withWindowsReads(yolo, grants), yolo);
});

test("windowsGitEnv: git and cargo skip the revocation check, git never prompts; the caller's git parameters stay ahead", () => {
  assert.deepEqual(windowsGitEnv({}), {
    GIT_CONFIG_PARAMETERS: "'http.schannelCheckRevoke=false' 'http.proxyAuthMethod=basic'",
    CARGO_HTTP_CHECK_REVOKE: "false",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GCM_PROVIDER: "generic",
  });
  assert.match(windowsGitEnv({ GITHUB_TOKEN: "t" }).GIT_CONFIG_PARAMETERS, /'http.proxyAuthMethod=basic' 'credential\.https:\/\/github\.com\.helper=' 'credential\.https:\/\/github\.com\.helper=!f\(\) .*"\$GITHUB_TOKEN"; \}; f'$/);
  assert.equal(
    windowsGitEnv({ GIT_CONFIG_PARAMETERS: "'core.autocrlf=true'" }).GIT_CONFIG_PARAMETERS,
    "'core.autocrlf=true' 'http.schannelCheckRevoke=false' 'http.proxyAuthMethod=basic'",
  );
});
