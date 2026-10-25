/**
 * The native Windows backend, exercised on any host: a fake runtime hands
 * back an argv that runs the script in a local bash, so the transport (env
 * file, command file, per-exec denies, cleanup) and the controller's Windows
 * flow (install check, staging, read-only at initialize, self-check) are
 * tested for real, without srt-win.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SandboxController, type SandboxRuntime, WINDOWS_NOT_INSTALLED_WARN, WINDOWS_REINSTALL_WARN, createWindowsSandboxedBashOps } from "./sandbox.ts";

interface Wrap {
  script: string;
  shell: unknown;
  cfg: unknown;
  cwd: string | undefined;
  options: unknown;
}

function fakeWindowsRuntime(
  opts: {
    provisioned?: boolean;
    argv?: (script: string) => string[];
    failInits?: string[];
    parseError?: (stderr: string) => { message: string } | undefined;
    /** The firewall set's record; "cannot-read" makes the dependency check the only source. Default: installed, loopback open. */
    wfp?: { state: "installed" | "cannot-read" | "absent"; allowLoopback: boolean };
    /** The dependency check's reinstall notice (setup version changed). */
    reinstallRequired?: string;
  } = {},
) {
  const calls: string[] = [];
  const wraps: Wrap[] = [];
  const inits: unknown[] = [];
  const installs: unknown[] = [];
  const wfp = opts.wfp ?? { state: "installed", allowLoopback: true };
  const manager = {
    async wrapWithSandboxArgv(script: string, shell: unknown, cfg: unknown, _signal: unknown, cwd: string | undefined, options: unknown) {
      calls.push("wrap");
      wraps.push({ script, shell, cfg, cwd, options });
      return { argv: opts.argv ? opts.argv(script) : ["bash", "-c", script], env: process.env };
    },
    annotateStderrWithSandboxFailures(id: string, stderr: string) {
      calls.push(`annotate:${id}`);
      return stderr;
    },
    cleanupAfterCommand: () => calls.push("cleanup"),
    async reset() {
      calls.push("reset");
    },
    async initialize(cfg: unknown) {
      calls.push("initialize");
      inits.push(cfg);
      const fail = opts.failInits?.shift();
      if (fail) throw new Error(fail);
    },
    isSupportedPlatform: () => true,
  };
  const provisioned = opts.provisioned ?? true;
  const rt = {
    SandboxManager: manager,
    VENDORED_SRT_WIN_EXE: "C:\\ext\\node_modules\\srt\\vendor\\srt-win\\x64\\srt-win.exe",
    resolveSrtWin: (cfg: { path: string }) => ({ exe: cfg.path, prependArgs: [] }),
    getWindowsSandboxUserStatusAsync: async () => ({ provisioned, credPresent: provisioned, sid: provisioned ? "S-1-5-21-1-2-3-1001" : undefined }),
    checkWindowsDependenciesAsync: async (o: { allowLoopback?: boolean }) => {
      calls.push(`deps:${o.allowLoopback}`);
      const mismatch = o.allowLoopback !== undefined && o.allowLoopback !== wfp.allowLoopback;
      return {
        errors: mismatch ? ["loopback mismatch"] : [],
        warnings: [],
        loopbackMismatch: mismatch ? "The firewall set was installed with the other loopback mode." : undefined,
        reinstallRequired: opts.reinstallRequired,
      };
    },
    getWindowsWfpStatusAsync: async () => ({ state: wfp.state, filters: wfp.state === "installed" ? 6 : 0, allowLoopback: wfp.allowLoopback }),
    installWindowsSandboxAsync: async (o: unknown) => {
      installs.push(o);
      const skip = (o as { skipProfileGrant?: boolean }).skipProfileGrant;
      return { wfp: { state: "installed", filters: 6, allowLoopback: (o as { allowLoopback?: boolean }).allowLoopback }, user: {}, profileGrant: skip ? { applied: false, reason: "skipped" } : { applied: true, userSid: "S-1-5-21-1-2-3-1001", result: {} } };
    },
    parseWindowsSandboxError: opts.parseError ?? (() => undefined),
  };
  return { calls, wraps, inits, installs, manager: manager as unknown as Parameters<typeof createWindowsSandboxedBashOps>[0], rt: rt as unknown as SandboxRuntime };
}

const exec = (ops: ReturnType<typeof createWindowsSandboxedBashOps>, command: string, env?: NodeJS.ProcessEnv, timeout = 10) => {
  let out = "";
  return ops
    .exec(command, process.cwd(), { onData: (b) => (out += String(b)), signal: undefined as never, timeout, env })
    .then((r) => ({ ...r, out }));
};

test("windows ops: env file and command file, sourced then run in a bash -c of its own; files removed; cleanup once", async () => {
  const fake = fakeWindowsRuntime();
  const dir = mkdtempSync(path.join(tmpdir(), "pi-win-ops-"));
  try {
    const ops = createWindowsSandboxedBashOps(fake.manager, { bash: "C:\\Program Files\\Git\\bin\\bash.exe", extraEnv: { GIT_AUTHOR_NAME: "Ann O'Neil" }, tmpdir: "C:\\t\\pi\\s", commandDir: dir });
    const command = "printf '%s|%s|%s|%s|%s\\n' \"$FOO\" \"${USERPROFILE:-unset}\" \"$GIT_AUTHOR_NAME\" \"$TMPDIR\" \"$TEMP\"; exit 3";
    const r = await exec(ops, command, { FOO: "it's a! test", USERPROFILE: "C:\\Users\\me", PATH: process.env.PATH });
    assert.equal(r.exitCode, 3);
    assert.equal(r.out, "it's a! test|unset|Ann O'Neil|C:/t/pi/s|C:\\t\\pi\\s\n");
    assert.equal(fake.wraps.length, 1);
    const w = fake.wraps[0];
    assert.match(w.script, /^\. '\/.*\/env-[0-9a-f]{16}\.sh'; bash -c "\$\(<"\/.*\/cmd-[0-9a-f]{16}\.sh"\)"$/);
    assert.deepEqual(w.shell, { exe: "C:\\Program Files\\Git\\bin\\bash.exe", args: ["-c"] });
    assert.equal(w.cfg, undefined, "no per-exec config without extra denies");
    assert.equal(w.cwd, process.cwd());
    const o = w.options as { commandId: string; commandText: string };
    assert.match(o.commandId, /^pi-[0-9a-f]{16}$/);
    assert.equal(o.commandText, command);
    assert.deepEqual(fake.calls, ["wrap", `annotate:${o.commandId}`, "cleanup"]);
    assert.deepEqual(readdirSync(dir), [], "env and command files are removed after the run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("windows ops: extra denies ride as per-exec denyRead only; without a command dir the exports are inlined", async () => {
  const fake = fakeWindowsRuntime();
  const ops = createWindowsSandboxedBashOps(fake.manager, { bash: "C:\\Git\\bin\\bash.exe", extraEnv: {}, extraDenyRead: ["C:\\Users\\me\\secret"] });
  const r = await exec(ops, "echo \"$FOO\"", { FOO: "bar" });
  assert.equal(r.out, "bar\n");
  const w = fake.wraps[0];
  assert.deepEqual(w.cfg, { filesystem: { denyRead: ["C:\\Users\\me\\secret"], allowWrite: [], denyWrite: [] } });
  assert.equal(w.script, "export FOO='bar'; echo \"$FOO\"");
});

test("windows ops: a timeout kills the child and rejects", async () => {
  const fake = fakeWindowsRuntime();
  const ops = createWindowsSandboxedBashOps(fake.manager, { bash: "C:\\Git\\bin\\bash.exe", extraEnv: {} });
  await assert.rejects(exec(ops, "sleep 1.5; echo late", { PATH: process.env.PATH }, 0.3), /timeout:0.3/);
  assert.ok(fake.calls.includes("cleanup"));
});

const baseInit = (
  c: SandboxController,
  fake: ReturnType<typeof fakeWindowsRuntime>,
  notes: string[],
  profile: { enabled: boolean; writable: boolean; allowWrite: string[]; denyRead?: string[]; denyWrite?: string[]; allowLocalBinding?: boolean } = { enabled: true, writable: true, allowWrite: ["."] },
  cwd = process.cwd(),
) =>
  c.init({
    cwd,
    noSandbox: false,
    hasUI: true,
    notify: (m) => notes.push(m),
    profile,
    keepWritable: ["C:\\t\\pi\\s"],
    platform: "win32",
    loadRuntime: async () => fake.rt,
    windows: {
      env: { USERPROFILE: "C:\\Users\\me", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      findBash: () => "C:\\Program Files\\Git\\bin\\bash.exe",
      stageHelper: (exe, grantee) => `C:\\Users\\me\\AppData\\Local\\pi-permission-modes\\srt-win-${grantee.length}\\${path.win32.basename(exe)}`,
      readIdentity: () => ({ name: "Ann", email: "ann@x.io" }),
      commandDir: () => undefined,
      gitConfig: () => "C:\\Users\\me\\AppData\\Local\\Temp\\pi-x\\gitconfig",
    },
  });

test("controller (win32): the global git config copy rides along as GIT_CONFIG_GLOBAL, except when the mode masks ~/.gitconfig", async () => {
  const passing = (script: string) => (script.includes("PI-SRT-PROBE") ? ["bash", "-c", "echo PI-SRT-PROBE DONE"] : ["bash", "-c", script]);
  const fake = fakeWindowsRuntime({ argv: passing });
  const c = new SandboxController();
  const notes: string[] = [];
  await baseInit(c, fake, notes, { enabled: true, writable: true, allowWrite: ["."], denyRead: ["~/.ssh"] });
  assert.equal(c.ready, true, notes.join("\n"));
  await exec(c.bashOps({ readOnly: false })!, "true", { PATH: process.env.PATH });
  assert.match(fake.wraps.at(-1)!.script, /GIT_CONFIG_GLOBAL='C:\/Users\/me\/AppData\/Local\/Temp\/pi-x\/gitconfig'/);
  assert.match(fake.wraps.at(-1)!.script, /GIT_AUTHOR_NAME='Ann'/, "the identity still travels too");
  // A strict home masks ~/.gitconfig: the copy is withheld after the switch.
  await c.applyProfile({ enabled: true, writable: true, allowWrite: ["."], denyRead: ["~"] });
  await c.settled();
  await exec(c.bashOps({ readOnly: false })!, "true", { PATH: process.env.PATH });
  assert.doesNotMatch(fake.wraps.at(-1)!.script, /GIT_CONFIG_GLOBAL/);
});

test("controller (win32): not provisioned degrades with the install hint and never initializes", async () => {
  const fake = fakeWindowsRuntime({ provisioned: false });
  const c = new SandboxController();
  const notes: string[] = [];
  await baseInit(c, fake, notes);
  assert.equal(c.ready, false);
  assert.equal(c.warn, WINDOWS_NOT_INSTALLED_WARN);
  assert.match(notes.join("\n"), /Run \/sandbox install .*docs\/troubleshooting\.md#windows-sandbox-install/);
  assert.deepEqual(fake.inits, []);
  assert.equal(c.windowsBackend, false);
});

test("controller (win32): provisioned, probe passes; read-only is applied at initialize and bash ops refuse a mismatch", async () => {
  const passing = (script: string) => (script.includes("PI-SRT-PROBE") ? ["bash", "-c", "echo PI-SRT-PROBE DONE"] : ["bash", "-c", script]);
  const fake = fakeWindowsRuntime({ argv: passing });
  const c = new SandboxController();
  const notes: string[] = [];
  await baseInit(c, fake, notes, { enabled: true, writable: true, allowWrite: ["."], denyRead: ["~/.ssh", "./.env", "C:\\Users\\me\\.aws"], denyWrite: ["~/.gitconfig"] });
  assert.equal(c.ready, true, notes.join("\n"));
  assert.equal(c.windowsBackend, true);
  const init = fake.inits[0] as { windows: { srtWin: { path: string } }; filesystem: { allowWrite: string[]; denyRead: string[]; denyWrite: string[] } };
  const sidLength = "*S-1-5-21-1-2-3-1001".length;
  assert.equal(init.windows.srtWin.path, `C:\\Users\\me\\AppData\\Local\\pi-permission-modes\\srt-win-${sidLength}\\srt-win.exe`, "the staged helper, granted to the sandbox user's SID");
  assert.ok(init.filesystem.allowWrite.includes("."));
  assert.deepEqual(init.filesystem.denyRead, ["./.env"], "denies outside every grant are dropped (they would walk the profile); the kept one is passed as written");
  assert.deepEqual(init.filesystem.denyWrite, []);
  assert.ok(typeof c.lastInitMs === "number");
  // The probe ran inside the sandbox and only the probe so far.
  assert.equal(fake.wraps.length, 1);
  assert.match(fake.wraps[0].script, /PI-SRT-PROBE/);
  // Build: writable ops run; a read-only request must wait for the re-init.
  const ops = c.bashOps({ readOnly: false })!;
  const r = await exec(ops, "echo \"$GIT_AUTHOR_NAME $GIT_COMMITTER_EMAIL $GIT_CONFIG_PARAMETERS $CARGO_HTTP_CHECK_REVOKE\"", { PATH: process.env.PATH });
  assert.equal(r.out, "Ann ann@x.io 'http.schannelCheckRevoke=false' 'http.proxyAuthMethod=basic' false\n");
  await assert.rejects(c.bashOps({ readOnly: true })!.exec("true", process.cwd(), { onData: () => {} }), /re-initialized for this mode/);
  // A session block outside the grants is dropped per command too; one inside rides along.
  const blocked = c.bashOps({ readOnly: false, extraDenyRead: ["~/secret", path.join(process.cwd(), "src", "x.ts")] })!;
  await exec(blocked, "true", { PATH: process.env.PATH });
  const perExec = fake.wraps.at(-1)!.cfg as { filesystem: { denyRead: string[] } };
  assert.deepEqual(perExec.filesystem.denyRead, [path.join(process.cwd(), "src", "x.ts")]);
  // Plan: the runtime is re-initialized with only the scratch dir writable, no second probe.
  await c.applyProfile({ enabled: true, writable: false, allowWrite: ["."] });
  assert.equal(c.ready, true);
  const ro = fake.inits[1] as { filesystem: { allowWrite: string[] } };
  assert.deepEqual(ro.filesystem.allowWrite, ["C:\\t\\pi\\s"]);
  assert.equal(fake.wraps.length, 3, "no second probe after the first passed (probe, two commands)");
  await assert.rejects(c.bashOps({ readOnly: false })!.exec("true", process.cwd(), { onData: () => {} }), /re-initialized/);
  assert.ok(c.bashOps({ readOnly: true }));
  assert.deepEqual(fake.calls.filter((x) => x === "initialize" || x === "reset"), ["initialize", "reset", "initialize"]);
});

test("controller (win32): the installed loopback mode reaches the runtime, not the mode's key; loopbackConflict names a difference", async () => {
  const passing = (script: string) => (script.includes("PI-SRT-PROBE") ? ["bash", "-c", "echo PI-SRT-PROBE DONE"] : ["bash", "-c", script]);
  // Installed open, the mode asks for off: the runtime gets true (the install's mode), the user is told.
  const open = fakeWindowsRuntime({ argv: passing });
  const c = new SandboxController();
  const notes: string[] = [];
  const off = { enabled: true, writable: true, allowWrite: ["."], allowLocalBinding: false };
  await baseInit(c, open, notes, off);
  assert.equal(c.ready, true, notes.join("\n"));
  assert.equal((open.inits[0] as { network: { allowLocalBinding?: boolean } }).network.allowLocalBinding, true);
  assert.ok(open.calls.includes("deps:true"), "the dependency check is run against the installed mode, so it never reports a mismatch with the mode's wish");
  assert.equal(c.windowsStatus()?.loopbackInstalled, true);
  assert.match(c.loopbackConflict(off, "Default")!, /^permission-mode: Default sets sandbox.allowLocalBinding off, but the Windows sandbox is installed with loopback open: the install decides until \/sandbox install runs again\. Use the same value in every mode \(see .*troubleshooting\.md#loopback-mode-on-windows\)/);
  assert.equal(c.loopbackConflict({ enabled: true, writable: true, allowWrite: ["."] }, "Build"), undefined);
  assert.equal(c.loopbackConflict({ enabled: false, writable: true, allowWrite: [] }, "YOLO"), undefined);
  // Installed closed, the stock mode (on): the key is left out of the runtime config, the conflict names the closed install.
  const closed = fakeWindowsRuntime({ argv: passing, wfp: { state: "installed", allowLoopback: false } });
  const c2 = new SandboxController();
  await baseInit(c2, closed, notes);
  assert.equal(c2.ready, true, notes.join("\n"));
  assert.equal("allowLocalBinding" in (closed.inits[0] as { network: object }).network, false);
  assert.match(c2.loopbackConflict({ enabled: true, writable: true, allowWrite: ["."] }, "Build")!, /Build sets sandbox.allowLocalBinding on, but the Windows sandbox is installed with loopback closed/);
  assert.equal(c2.loopbackConflict(off, "Default"), undefined);
  // The record cannot be read: the dependency check's mismatch against the mode's wish tells the installed mode.
  const unread = fakeWindowsRuntime({ argv: passing, wfp: { state: "cannot-read", allowLoopback: false } });
  const c3 = new SandboxController();
  await baseInit(c3, unread, notes);
  assert.equal(c3.ready, true, notes.join("\n"));
  assert.equal(c3.windowsStatus()?.loopbackInstalled, false);
  assert.deepEqual(unread.calls.filter((x) => x.startsWith("deps:")), ["deps:true", "deps:false"], "one comparison with the wish, then the real check against the installed mode");
});

test("controller (win32): an install from another runtime release degrades with the reinstall advice and never initializes", async () => {
  const fake = fakeWindowsRuntime({ reinstallRequired: "The Windows sandbox on this machine was set up by a different release (setup version 2; this release needs 3).\nRe-run the install." });
  const c = new SandboxController();
  const notes: string[] = [];
  await baseInit(c, fake, notes);
  assert.equal(c.ready, false);
  assert.equal(c.warn, WINDOWS_REINSTALL_WARN);
  assert.match(notes.join("\n"), /set up by a different release \(setup version 2; this release needs 3\)\. Run \/sandbox install \(one UAC prompt; it upgrades the install in place\)\..*troubleshooting\.md#windows-sandbox-install/);
  assert.deepEqual(fake.inits, []);
});

test("controller (win32): windowsSetup passes the install choices on and reports the grant and loopback outcome", async () => {
  const passing = (script: string) => (script.includes("PI-SRT-PROBE") ? ["bash", "-c", "echo PI-SRT-PROBE DONE"] : ["bash", "-c", script]);
  const fake = fakeWindowsRuntime({ argv: passing });
  const c = new SandboxController();
  const notes: string[] = [];
  await baseInit(c, fake, notes);
  const progress: string[] = [];
  const line = await c.windowsSetup("install", { allowLoopback: true, profileGrant: true, onProgress: (l) => progress.push(l) });
  assert.equal(line, "Windows sandbox installed and active. Loopback open; your profile readable to sandboxed commands (minus credential stores).");
  const o = fake.installs[0] as Record<string, unknown>;
  assert.equal(o.allowLoopback, true);
  assert.equal(o.skipProfileGrant, false);
  assert.equal(o.force, undefined);
  assert.equal(typeof o.onProfileGrantProgress, "function");
  assert.ok(fake.calls.indexOf("reset") < fake.calls.lastIndexOf("initialize"), "this session's runtime is released before the install and re-initialized after");
  const skipped = await c.windowsSetup("install", { allowLoopback: false, profileGrant: false, force: true });
  assert.match(skipped, /Loopback closed; your profile not readable \(skipped\)\.$/);
  const o2 = fake.installs[1] as Record<string, unknown>;
  assert.equal(o2.allowLoopback, false);
  assert.equal(o2.skipProfileGrant, true);
  assert.equal(o2.force, true);
});

/** A project whose parent folder is writable, as a folder created at a drive root is on Windows. */
function writableParentProject(): { base: string; cwd: string } {
  const base = mkdtempSync(path.join(tmpdir(), "pi-win-ctl-"));
  const cwd = path.join(base, "proj");
  mkdirSync(cwd);
  return { base, cwd };
}

test("controller (win32): a failed self-check tears the runtime down and degrades with the advice", async () => {
  // The probe really runs in a local bash against a project whose parent is writable.
  const { base, cwd } = writableParentProject();
  const fake = fakeWindowsRuntime();
  const c = new SandboxController();
  const notes: string[] = [];
  try {
    await baseInit(c, fake, notes, undefined, cwd);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  assert.equal(c.ready, false);
  assert.match(c.warn!, /^Windows sandbox off: .* writable by the sandbox user$/);
  assert.match(notes.join("\n"), /Tighten the folder's ACL or move the project; see docs\/troubleshooting\.md#windows-sandbox-self-check/);
  assert.equal(c.windowsBackend, false);
  assert.equal(c.sandboxManager, null);
  assert.deepEqual(fake.calls.filter((x) => x === "initialize" || x === "reset"), ["initialize", "reset"]);
  assert.equal(c.bashOps(), null);
});

test("controller (win32): a writable parent the sandbox account already holds is reported as another session's folder", async () => {
  const { base, cwd } = writableParentProject();
  const fake = fakeWindowsRuntime();
  const c = new SandboxController();
  const notes: string[] = [];
  const asked: string[] = [];
  const probeBase = path.win32.normalize(base); // probe targets are win32-spelled, also on this host
  try {
    await c.init({
      cwd,
      noSandbox: false,
      hasUI: true,
      notify: (m) => notes.push(m),
      profile: { enabled: true, writable: true, allowWrite: ["."] },
      platform: "win32",
      loadRuntime: async () => fake.rt,
      windows: {
        env: { USERPROFILE: "C:\\Users\\me", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
        findBash: () => "C:\\Program Files\\Git\\bin\\bash.exe",
        stageHelper: (exe) => `C:\\Users\\me\\AppData\\Local\\pi-permission-modes\\srt-win-x\\${path.win32.basename(exe)}`,
        readIdentity: () => ({}),
        commandDir: () => undefined,
        readAcl: (dir) => {
          asked.push(dir);
          return dir === probeBase ? `${dir} PC\\srt-sandbox:(OI)(CI)(M)\n` : "";
        },
      },
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  assert.equal(c.ready, false);
  assert.deepEqual(asked, [probeBase], "only the writable targets are inspected");
  assert.equal(c.warn, `Windows sandbox off: inside another sandboxed folder (${probeBase})`);
  assert.match(notes.join("\n"), /another pi session runs in that folder or in one above it/);
});

test("controller (win32): a working directory srt-win refuses (mapped drive) degrades with the runtime's message", async () => {
  // The probe's launch fails like srt-win's exit 16 does: a JSON error on stderr, no output.
  const refusing = () => ["bash", "-c", "echo '{\"code\":\"mapped_drive_cwd\",\"message\":\"working directory X:\\\\proj is on a mapped drive\"}' >&2; exit 16"];
  const parseError = (stderr: string) => {
    const m = /"message":"([^"]+)"/.exec(stderr);
    return m ? { message: m[1].replace(/\\\\/g, "\\") } : undefined;
  };
  const fake = fakeWindowsRuntime({ argv: refusing, parseError });
  const c = new SandboxController();
  const notes: string[] = [];
  await baseInit(c, fake, notes);
  assert.equal(c.ready, false);
  assert.equal(c.warn, "Windows sandbox off: working directory X:\\proj is on a mapped drive");
  assert.match(notes.join("\n"), /could not start a command in this project: working directory X:\\proj is on a mapped drive\. Drive mappings and UNC paths belong to your logon session/);
  assert.match(notes.join("\n"), /docs\/troubleshooting\.md#mapped-drive-or-unc-project-on-windows/);
  assert.equal(c.bashOps(), null);
});

test("controller (win32): a folder the profile grants write access to is not probed", async () => {
  const { base, cwd } = writableParentProject();
  const fake = fakeWindowsRuntime();
  const c = new SandboxController();
  const notes: string[] = [];
  try {
    await baseInit(c, fake, notes, { enabled: true, writable: true, allowWrite: [".", base] }, cwd);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  // The root (here "/") is still probed and is not writable; the granted parent is skipped.
  assert.equal(c.ready, true, notes.join("\n"));
  assert.doesNotMatch(fake.wraps[0].script, new RegExp(`: > '${base}/`));
  assert.match(fake.wraps[0].script, /: > '\/\.pi-srt-probe-/);
});

test("controller: cycling past a mode skips its switch; `switching` is set while one is in flight", async () => {
  const passing = (script: string) => (script.includes("PI-SRT-PROBE") ? ["bash", "-c", "echo PI-SRT-PROBE DONE"] : ["bash", "-c", script]);
  const fake = fakeWindowsRuntime({ argv: passing });
  const c = new SandboxController();
  await baseInit(c, fake, [], { enabled: true, writable: true, allowWrite: ["."] });
  const before = fake.calls.filter((x) => x === "initialize").length;
  // Build -> Plan -> Build in quick succession: the Plan switch is superseded before it runs.
  const plan = c.applyProfile({ enabled: true, writable: false, allowWrite: ["."] });
  const build = c.applyProfile({ enabled: true, writable: true, allowWrite: [".", "./extra"] });
  assert.equal(c.switching, true);
  await Promise.all([plan, build]);
  await c.settled();
  assert.equal(c.switching, false);
  assert.equal(fake.calls.filter((x) => x === "initialize").length - before, 1, "one re-init for the switch that counts");
  assert.deepEqual((fake.inits.at(-1) as { filesystem: { allowWrite: string[] } }).filesystem.allowWrite, [".", "./extra"]);
  assert.ok(c.bashOps({ readOnly: false }));
});

test("controller (win32): a refused acl grant is retried once after the reset; the runtime's package is not granted", async () => {
  const passing = (script: string) => (script.includes("PI-SRT-PROBE") ? ["bash", "-c", "echo PI-SRT-PROBE DONE"] : ["bash", "-c", script]);
  const stale = "srt-win acl grant exited 1: srt-win: grant 'C:\\x\\node_modules\\@anthropic-ai\\sandbox-runtime': file_id changed since prior grant - path was substituted (refusing)";
  const fake = fakeWindowsRuntime({ argv: passing, failInits: [stale] });
  const c = new SandboxController();
  const notes: string[] = [];
  await baseInit(c, fake, notes, { enabled: true, writable: true, allowWrite: ["."], denyRead: ["~/.ssh"] });
  assert.equal(c.ready, true, notes.join("\n"));
  assert.deepEqual(fake.calls.filter((x) => x === "initialize" || x === "reset"), ["initialize", "reset", "initialize"]);
  assert.doesNotMatch(notes.join("\n"), /sandbox init failed/);
  const cfg = fake.inits.at(-1) as { filesystem: { allowRead?: string[] } };
  assert.ok(!(cfg.filesystem.allowRead ?? []).some((p) => p.includes("sandbox-runtime")), "no grant on the runtime's own package");
  // A second failure in a row is reported, not retried again.
  const fake2 = fakeWindowsRuntime({ argv: passing, failInits: [stale, stale] });
  const c2 = new SandboxController();
  const notes2: string[] = [];
  await baseInit(c2, fake2, notes2);
  assert.equal(c2.ready, false);
  assert.match(c2.warn!, /sandbox init failed: srt-win acl grant exited 1/);
  assert.equal(fake2.calls.filter((x) => x === "initialize").length, 2);
});

test("controller: idle() resolves once no sandboxed command runs (a network prompt is dismissed on it)", async () => {
  const passing = (script: string) => (script.includes("PI-SRT-PROBE") ? ["bash", "-c", "echo PI-SRT-PROBE DONE"] : ["bash", "-c", script]);
  const fake = fakeWindowsRuntime({ argv: passing });
  const c = new SandboxController();
  await baseInit(c, fake, []);
  await c.idle(); // nothing running: resolves at once
  let out = "";
  const run = c.bashOps({ readOnly: false })!.exec("sleep 0.5; echo done", process.cwd(), { onData: (b) => (out += String(b)), signal: undefined as never, timeout: 10, env: { PATH: process.env.PATH } });
  await new Promise((r) => setTimeout(r, 100)); // the command is running (a prompt can only come from a running command)
  let idle = false;
  const waited = c.idle().then(() => (idle = true));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(idle, false, "still running");
  await run;
  await waited;
  assert.equal(idle, true);
  assert.match(out, /done/);
});

test("controller (win32): a switch waits for a quiet moment after the last cycle step; the first init does not", async () => {
  const passing = (script: string) => (script.includes("PI-SRT-PROBE") ? ["bash", "-c", "echo PI-SRT-PROBE DONE"] : ["bash", "-c", script]);
  const fake = fakeWindowsRuntime({ argv: passing });
  const c = new SandboxController();
  const started = Date.now();
  await c.init({
    cwd: process.cwd(),
    noSandbox: false,
    hasUI: true,
    notify: () => {},
    profile: { enabled: true, writable: true, allowWrite: ["."] },
    platform: "win32",
    loadRuntime: async () => fake.rt,
    switchDelayMs: 120,
    windows: {
      env: { USERPROFILE: "C:\\Users\\me", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      findBash: () => "C:\\Program Files\\Git\\bin\\bash.exe",
      stageHelper: (exe) => `C:\\Users\\me\\AppData\\Local\\pi-permission-modes\\srt-win-x\\${path.win32.basename(exe)}`,
      readIdentity: () => ({}),
      commandDir: () => undefined,
    },
  });
  assert.ok(Date.now() - started < 100, "the first init is not delayed");
  const before = fake.calls.filter((x) => x === "initialize").length;
  // Five cycle steps, 40 ms apart: each restarts the quiet timer, so nothing
  // is applied until 120 ms after the last one, and then only the last one.
  const profiles = [false, true, false, true, false].map((writable) => ({ enabled: true, writable, allowWrite: ["."] }));
  const runs: Promise<void>[] = [];
  for (const p of profiles) {
    runs.push(c.applyProfile(p));
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.equal(fake.calls.filter((x) => x === "initialize").length - before, 0, "still quiet-waiting after the burst");
  assert.equal(c.switching, true);
  await Promise.all(runs);
  await c.settled();
  assert.equal(fake.calls.filter((x) => x === "initialize").length - before, 1, "one re-init for the last selection");
  assert.ok(c.bashOps({ readOnly: true }), "Plan, the last selection, is what landed");
});
