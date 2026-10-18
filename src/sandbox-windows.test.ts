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
import { SandboxController, type SandboxRuntime, WINDOWS_NOT_INSTALLED_WARN, createWindowsSandboxedBashOps } from "./sandbox.ts";

interface Wrap {
  script: string;
  shell: unknown;
  cfg: unknown;
  cwd: string | undefined;
  options: unknown;
}

function fakeWindowsRuntime(opts: { provisioned?: boolean; argv?: (script: string) => string[] } = {}) {
  const calls: string[] = [];
  const wraps: Wrap[] = [];
  const inits: unknown[] = [];
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
    },
    isSupportedPlatform: () => true,
  };
  const provisioned = opts.provisioned ?? true;
  const rt = {
    SandboxManager: manager,
    VENDORED_SRT_WIN_EXE: "C:\\ext\\node_modules\\srt\\vendor\\srt-win\\x64\\srt-win.exe",
    resolveSrtWin: (cfg: { path: string }) => ({ exe: cfg.path, prependArgs: [] }),
    getWindowsSandboxUserStatusAsync: async () => ({ provisioned, credPresent: provisioned, sid: provisioned ? "S-1-5-21-1-2-3-1001" : undefined }),
    checkWindowsDependenciesAsync: async () => ({ errors: [], warnings: [] }),
    parseWindowsSandboxError: () => undefined,
  };
  return { calls, wraps, inits, manager: manager as unknown as Parameters<typeof createWindowsSandboxedBashOps>[0], rt: rt as unknown as SandboxRuntime };
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
  profile: { enabled: boolean; writable: boolean; allowWrite: string[]; denyRead?: string[]; denyWrite?: string[] } = { enabled: true, writable: true, allowWrite: ["."] },
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
    },
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
