/**
 * Command transport tests for sandbox.ts: the launcher must carry a command
 * through the runtime's shell quoting byte-for-byte. The runtime itself needs
 * bubblewrap/sandbox-exec, so this exercises the things we control - the
 * launcher string, the file it points at, and the exec wrapper around a fake
 * runtime - through a real bash, including the nested quoting passes the
 * runtime applies (its own quoter, resolved from the installed package).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SandboxController, bashCustomConfig, commandLauncher, createSandboxedBashOps, networkFiltered, runtimeExtrasFor, runtimeInstallDir, withDeniedReads, withRuntimeExtras, writeCommandFile } from "./sandbox.ts";

const quote: ((xs: readonly string[]) => string) | undefined = await import("@anthropic-ai/sandbox-runtime/dist/utils/shell-quote.js")
  .then((m) => (m as { quote: (xs: readonly string[]) => string }).quote)
  .catch(() => undefined);
const skipQuote = quote ? false : "sandbox-runtime not installed";

const runBash = (script: string): string => execFileSync("bash", ["-c", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A command with everything that has bitten: `!`, both quote kinds, a heredoc, `$`, backslashes. */
const TRICKY = [
  "python3 -c 'print(\"a!b\", repr({\"k\": 1}))' 2>/dev/null || printf '%s\\n' 'a!b {'\"'\"'k'\"'\"': 1}'",
  "cat <<'EOF'",
  "wow! it's \"quoted\" $HOME \\backslash `tick`",
  "EOF",
  "printf '%s\\n' \"double !bang\"",
  "exit 7",
].join("\n");
const EXPECTED = "a!b {'k': 1}\nwow! it's \"quoted\" $HOME \\backslash `tick`\ndouble !bang\n";

/** Emulate the runtime's Linux network-bridge quoting: eval line -> inner script -> outer line. */
function throughRuntimeQuoting(q: (xs: string[]) => string, userCommand: string): string {
  const inner = ["true &", `eval ${q([userCommand])}`].join("\n");
  const sandboxCommand = `bash -c ${q([inner])}`;
  return q(["bash", "-c", sandboxCommand]);
}

test("commandLauncher: no single quote, no bang; rejects paths that would re-enter the quoting problem", () => {
  const l = commandLauncher("/tmp/pi-permission-mode/cmd-0123abcd.sh");
  assert.equal(l, 'bash -c "$(<"/tmp/pi-permission-mode/cmd-0123abcd.sh")"');
  assert.ok(!/['!]/.test(l ?? "!"));
  for (const bad of ["/tmp/it's/cmd.sh", "/tmp/bang!/cmd.sh", '/tmp/q"uote/cmd.sh', "/tmp/$x/cmd.sh", "/tmp/a\nb/cmd.sh"]) {
    assert.equal(commandLauncher(bad), undefined, bad);
  }
  assert.ok(commandLauncher("/tmp/with space/cmd.sh")); // spaces are fine: the path is double-quoted
});

test("writeCommandFile: private file with the exact bytes; unwritable dir yields undefined", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "perm-cmdfile-"));
  try {
    const file = writeCommandFile(TRICKY, path.join(dir, "cmds"));
    assert.ok(file && existsSync(file));
    assert.equal(readFileSync(file, "utf8"), TRICKY);
    if (process.platform !== "win32") {
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(path.join(dir, "cmds")).mode & 0o777, 0o700);
    }
    assert.equal(writeCommandFile("x", path.join(file, "nope")), undefined); // a file is not a dir
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("launcher runs the file content as a bash -c script: bytes, exit status, heredoc all intact", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "perm-launch-"));
  try {
    const file = writeCommandFile(TRICKY, dir)!;
    const launcher = commandLauncher(file)!;
    let out = "";
    let status = 0;
    try {
      out = runBash(launcher);
    } catch (e) {
      const err = e as { stdout: string; status: number };
      out = err.stdout;
      status = err.status;
    }
    assert.equal(out, EXPECTED);
    assert.equal(status, 7, "exit status propagates");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("through the runtime's nested quoting passes: raw command and launcher both arrive byte-for-byte", { skip: skipQuote }, () => {
  const q = quote!;
  const dir = mkdtempSync(path.join(tmpdir(), "perm-quote-"));
  try {
    // 0.0.26 corrupted `!` to `\!` here; the runtime's own quoter (0.0.77)
    // single-quotes and leaves the raw command intact. The launcher is kept
    // for TMPDIR and long commands, and must keep surviving the same passes.
    const simple = "python3 -c 'print(\"a!b\")' 2>/dev/null || printf '%s\\n' 'a!b'";
    assert.equal(runBash(throughRuntimeQuoting(q, simple)), "a!b\n");

    const file = writeCommandFile(TRICKY, dir)!;
    const launcher = commandLauncher(file)!;
    let out = "";
    let status = 0;
    try {
      out = runBash(throughRuntimeQuoting(q, launcher));
    } catch (e) {
      const err = e as { stdout: string; status: number };
      out = err.stdout;
      status = err.status;
    }
    assert.equal(out, EXPECTED);
    assert.equal(status, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commandLauncher: TMPDIR prefix when given, dropped when unsafe", () => {
  assert.equal(commandLauncher("/tmp/x/cmd.sh", "/tmp/pi/sess"), 'TMPDIR="/tmp/pi/sess" bash -c "$(<"/tmp/x/cmd.sh")"');
  assert.equal(commandLauncher("/tmp/x/cmd.sh", "/tmp/it's"), 'bash -c "$(<"/tmp/x/cmd.sh")"');
  assert.equal(commandLauncher("/tmp/x/cmd.sh", undefined), 'bash -c "$(<"/tmp/x/cmd.sh")"');
  assert.ok(!/['!]/.test(commandLauncher("/tmp/x/cmd.sh", "/tmp/with space") ?? "!"));
});

test("writeCommandFile default dir lives under /tmp (not under an inherited TMPDIR) and is private", () => {
  if (process.platform === "win32") return;
  const file = writeCommandFile("true")!;
  try {
    // /tmp first; a locked-down /tmp (some CI/sandboxes) falls back to os.tmpdir().
    const dir = path.dirname(file);
    assert.ok(dir.startsWith("/tmp/pi-permission-mode-") || dir.startsWith(path.join(tmpdir(), "pi-permission-mode-")), dir);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  } finally {
    rmSync(file, { force: true });
  }
});

test("networkFiltered: an absent allowlist is unrestricted, an empty one is filtered", () => {
  assert.equal(networkFiltered({ enabled: true, writable: true }), false);
  assert.equal(networkFiltered({ enabled: true, writable: true, network: {} }), false);
  assert.equal(networkFiltered({ enabled: true, writable: true, network: { allowedDomains: [] } }), true);
  assert.equal(networkFiltered({ enabled: false, writable: true, network: { allowedDomains: ["a"] } }), false);
});

test("exec: an aborted signal never spawns; an abort during the wrap kills before the command completes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "perm-abort-"));
  const marker = path.join(dir, "marker");
  // Fake runtime: the wrap takes 200 ms and returns the command unchanged.
  let cleanups = 0;
  const fakeManager = {
    wrapWithSandbox: (cmd: string) => new Promise<string>((r) => setTimeout(() => r(cmd), 200)),
    cleanupAfterCommand: () => cleanups++,
  } as unknown as Parameters<typeof createSandboxedBashOps>[0];
  const ops = createSandboxedBashOps(fakeManager);
  const run = (signal: AbortSignal) =>
    ops.exec(`sleep 0.5; touch "${marker}"`, dir, { onData: () => {}, signal, timeout: 10 });
  try {
    // Already aborted: rejects immediately, nothing spawned.
    const pre = new AbortController();
    pre.abort();
    const t0 = Date.now();
    await assert.rejects(run(pre.signal), /aborted/);
    assert.ok(Date.now() - t0 < 150, "no wrap, no spawn");
    // Abort lands while the wrap is in flight: the command must not run to completion.
    const mid = new AbortController();
    setTimeout(() => mid.abort(), 50);
    const t1 = Date.now();
    await assert.rejects(run(mid.signal), /aborted/);
    assert.ok(Date.now() - t1 < 450, `killed promptly (took ${Date.now() - t1} ms)`);
    await new Promise((r) => setTimeout(r, 700));
    assert.ok(!existsSync(marker), "the command did not complete after the abort");
    assert.equal(cleanups, 1, "only the wrap that produced a run is cleaned up after");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bashCustomConfig: blocks and read-only ride along per command, on top of the profile's own lists", () => {
  const profile = { enabled: true, writable: true, allowWrite: [".", "/tmp/pi"], denyRead: ["~/.ssh"], network: { allowedDomains: ["a"] } };
  assert.equal(bashCustomConfig(profile, {}), undefined, "nothing to override: the init-time profile applies");
  assert.equal(bashCustomConfig(profile, { extraDenyRead: [] }), undefined);
  const blocked = bashCustomConfig(profile, { extraDenyRead: ["/home/u/secret.txt"] })!;
  assert.deepEqual(blocked.filesystem, { denyRead: ["~/.ssh", "/home/u/secret.txt"], allowWrite: [".", "/tmp/pi"], denyWrite: [] });
  assert.deepEqual(blocked.network, { allowedDomains: ["a"], deniedDomains: [] });
  const ro = bashCustomConfig(profile, { readOnly: true, keepWritable: ["/tmp/pi/s1"], extraDenyRead: ["/home/u/secret.txt"] })!;
  assert.deepEqual(ro.filesystem, { denyRead: ["~/.ssh", "/home/u/secret.txt"], allowWrite: ["/tmp/pi/s1"], denyWrite: [] });
  assert.deepEqual(bashCustomConfig(profile, { readOnly: true })!.filesystem.allowWrite, []);
});

test("withDeniedReads: appends session blocks to denyRead of a sandboxed profile only", () => {
  const p = { enabled: true, writable: true, denyRead: ["~/.ssh"] };
  assert.deepEqual(withDeniedReads(p, ["/home/u/secret.txt", "~/.ssh"]).denyRead, ["~/.ssh", "/home/u/secret.txt"]);
  assert.equal(withDeniedReads(p, []), p);
  const yolo = { enabled: false, writable: true };
  assert.equal(withDeniedReads(yolo, ["/x"]), yolo);
});

/** A fake runtime that records the wrapper's calls in order and returns the command unchanged. */
function fakeRuntime(opts: { violations?: string; wrapError?: unknown } = {}) {
  const calls: string[] = [];
  const wraps: Array<{ command: string; options: unknown; hasSignal: boolean }> = [];
  const manager = {
    async wrapWithSandbox(cmd: string, _shell: unknown, _cfg: unknown, signal: unknown, options: unknown) {
      calls.push("wrap");
      wraps.push({ command: cmd, options, hasSignal: signal !== undefined });
      if (opts.wrapError) throw opts.wrapError;
      return cmd;
    },
    annotateStderrWithSandboxFailures(id: string, stderr: string) {
      calls.push(`annotate:${id}`);
      return opts.violations ? `${stderr}\n<sandbox_violations>\n${opts.violations}\n</sandbox_violations>` : stderr;
    },
    cleanupAfterCommand() {
      calls.push("cleanup");
    },
  };
  return { calls, wraps, manager: manager as unknown as Parameters<typeof createSandboxedBashOps>[0] };
}

test("exec: wraps the launcher under a per-run id with the ORIGINAL command as commandText; cleans up once, after the run", async () => {
  const rt = fakeRuntime();
  const ops = createSandboxedBashOps(rt.manager);
  let out = "";
  const command = "printf '%s\\n' \"it's a! test\"";
  const res = await ops.exec(command, process.cwd(), { onData: (b) => (out += String(b)), signal: undefined as never, timeout: 10 });
  assert.equal(res.exitCode, 0);
  assert.equal(out, "it's a! test\n");
  assert.equal(rt.wraps.length, 1);
  const w = rt.wraps[0];
  assert.match(w.command, /^bash -c "\$\(<"/, "the runtime gets the launcher, not the command");
  const o = w.options as { commandId: string; commandText: string };
  assert.match(o.commandId, /^pi-[0-9a-f]{16}$/);
  assert.equal(o.commandText, command);
  assert.deepEqual(rt.calls, ["wrap", `annotate:${o.commandId}`, "cleanup"], "violations are read for the same id, cleanup is last");
  rt.calls.length = 0;
  await ops.exec("true", process.cwd(), { onData: () => {}, signal: undefined as never, timeout: 10 });
  const second = (rt.wraps[1].options as { commandId: string }).commandId;
  assert.notEqual(second, o.commandId, "a fresh id per run");
  assert.equal(rt.calls.filter((c) => c === "cleanup").length, 1);
});

test("exec: the runtime's violation block is appended to the output the model sees", async () => {
  const rt = fakeRuntime({ violations: "write /etc/nope" });
  const ops = createSandboxedBashOps(rt.manager);
  let out = "";
  await ops.exec("echo hi", process.cwd(), { onData: (b) => (out += String(b)), signal: undefined as never, timeout: 10 });
  assert.equal(out, "hi\n\n<sandbox_violations>\nwrite /etc/nope\n</sandbox_violations>\n");
});

test("exec: a wrap that throws is surfaced with the runtime's error code and is NOT cleaned up after", async () => {
  const err = Object.assign(new Error("profile holds more mounts than bubblewrap parses"), { name: "LinuxSandboxProfileError", code: "too_many_arguments" });
  const rt = fakeRuntime({ wrapError: err });
  const ops = createSandboxedBashOps(rt.manager);
  await assert.rejects(
    ops.exec("true", process.cwd(), { onData: () => {}, signal: undefined as never, timeout: 10 }),
    /sandbox profile error \(too_many_arguments\): profile holds more mounts/,
  );
  assert.deepEqual(rt.calls, ["wrap"], "no cleanup for a wrap that released its own state");
  const plain = fakeRuntime({ wrapError: new Error("boom") });
  await assert.rejects(createSandboxedBashOps(plain.manager).exec("true", process.cwd(), { onData: () => {}, signal: undefined as never, timeout: 10 }), /boom/);
});

test("exec: a bubblewrap namespace failure gets the AppArmor hint, other failures do not", async () => {
  const rt = fakeRuntime();
  const ops = createSandboxedBashOps(rt.manager);
  let out = "";
  const failing = "echo 'bwrap: setting up uid map: Operation not permitted' >&2; exit 1";
  const res = await ops.exec(failing, process.cwd(), { onData: (b) => (out += String(b)), signal: undefined as never, timeout: 10 });
  assert.equal(res.exitCode, 1);
  assert.match(out, /apparmor_restrict_unprivileged_userns/);
  out = "";
  await ops.exec("echo 'bwrap: something else' >&2; exit 1", process.cwd(), { onData: (b) => (out += String(b)), signal: undefined as never, timeout: 10 });
  assert.doesNotMatch(out, /apparmor/);
  out = "";
  await ops.exec("echo 'Operation not permitted' >&2; exit 0", process.cwd(), { onData: (b) => (out += String(b)), signal: undefined as never, timeout: 10 });
  assert.doesNotMatch(out, /apparmor/, "a successful run never gets the hint");
});

test("runtime extras: runtime dir re-opened; a real worktree's git dirs writable with hooks/config/pointers denied; not in read-only runs", () => {
  const dir = runtimeInstallDir();
  if (dir) assert.ok(existsSync(path.join(dir, "package.json")), dir);
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "perm-extras-")));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });
  try {
    assert.deepEqual(runtimeExtrasFor(base, "/opt/rt"), { allowRead: ["/opt/rt"], allowWrite: [], denyWrite: [] });
    const main = path.join(base, "main");
    mkdirSync(main);
    git(main, "init", "-q");
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    git(main, "worktree", "add", "-q", "../wt", "-b", "wt");
    const wt = path.join(base, "wt");
    const gitdir = path.join(main, ".git", "worktrees", "wt");
    const common = path.join(main, ".git");
    const ex = runtimeExtrasFor(wt, "");
    assert.deepEqual(ex.allowRead, []);
    assert.deepEqual(ex.allowWrite, [gitdir, common]);
    assert.ok(ex.denyWrite.includes(path.join(wt, ".git")), "the gitfile itself cannot be rewritten");
    for (const f of [path.join(gitdir, "gitdir"), path.join(gitdir, "commondir"), path.join(common, "hooks"), path.join(common, "config")]) {
      assert.ok(ex.denyWrite.includes(f), f);
    }
    assert.ok(ex.denyWrite.every((f) => existsSync(f)), "only existing paths (no mount points planted in git dirs)");

    // A forged gitfile in a non-git project: nothing writable, the gitfile write-denied.
    const evil = path.join(base, "evil");
    mkdirSync(evil);
    writeFileSync(path.join(evil, ".git"), `gitdir: ${os.homedir()}\n`);
    assert.deepEqual(runtimeExtrasFor(evil, ""), { allowRead: [], allowWrite: [], denyWrite: [path.join(evil, ".git")] });

    // Folded into configs; a read-only run does NOT keep the git dirs writable.
    const profile = { enabled: true, writable: true, allowWrite: ["."], denyRead: ["~"], allowRead: ["."] };
    const cfg = withRuntimeExtras({ enabled: true, network: { deniedDomains: [] }, filesystem: { denyRead: ["~"], allowRead: ["."], allowWrite: ["."], denyWrite: [] } }, { ...ex, allowRead: ["/opt/rt"] });
    assert.deepEqual(cfg.filesystem.allowRead, [".", "/opt/rt"]);
    assert.deepEqual(cfg.filesystem.allowWrite, [".", gitdir, common]);
    const ro = bashCustomConfig(profile, { readOnly: true, keepWritable: ["/tmp/pi/s1"] }, { ...ex, allowRead: ["/opt/rt"] })!;
    assert.deepEqual(ro.filesystem.allowWrite, ["/tmp/pi/s1"]);
    assert.ok(ro.filesystem.denyWrite.includes(path.join(common, "hooks")));
    const none = withRuntimeExtras({ enabled: true, network: { deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: ["."], denyWrite: [] } }, { allowRead: [], allowWrite: [], denyWrite: [] });
    assert.ok(!("allowRead" in none.filesystem), "no extras, no allowRead key");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("withDeniedReads: a block closes the allowRead carve-outs at or under it", () => {
  const home = os.homedir();
  const p = { enabled: true, writable: true, denyRead: ["~"], allowRead: [".", "~/.gitconfig", "~/.config", "~/.config/gh"] };
  const out = withDeniedReads(p, [path.join(home, ".gitconfig"), path.join(home, ".config")]);
  assert.deepEqual(out.allowRead, ["."]);
  assert.deepEqual(withDeniedReads(p, [path.join(home, ".config", "gh", "hosts.yml")]).allowRead, p.allowRead, "a block deeper than a carve-out keeps it (the deny wins there)");
});

test("exec: TMPDIR comes from the explicit option, never from pi's env; pi's env reaches the command", async () => {
  const rt = fakeRuntime();
  const ops = createSandboxedBashOps(rt.manager, undefined, undefined, { tmpdir: "/tmp/pi/sess-x" });
  let out = "";
  await ops.exec('echo "$TMPDIR|$PI_MARK"', process.cwd(), { onData: (b) => (out += String(b)), signal: undefined as never, timeout: 10, env: { ...process.env, TMPDIR: "/var/folders/pi-own", PI_MARK: "m1" } });
  assert.equal(out, "/tmp/pi/sess-x|m1\n");
});

test("controller: a profile switch waits for running sandboxed commands before resetting the runtime", async () => {
  const calls: string[] = [];
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const manager = {
    async wrapWithSandbox(cmd: string) {
      return cmd;
    },
    annotateStderrWithSandboxFailures: (_id: string, s: string) => s,
    cleanupAfterCommand: () => calls.push("cleanup"),
    async reset() {
      calls.push("reset");
    },
    async initialize() {
      calls.push("initialize");
    },
  };
  const c = new SandboxController();
  const notes: string[] = [];
  // Wire the controller as init() would have, without the real runtime.
  Object.assign(c, { manager, profile: { enabled: true, writable: true, allowWrite: ["."] }, runtimeInitialized: true, ready: true, appliedKey: "old", hasUI: true, notifyFn: (m: string) => notes.push(m) });
  const ops = c.bashOps()!;
  const run = ops.exec("sleep 0.3", process.cwd(), { onData: () => {}, signal: undefined as never, timeout: 10 });
  await new Promise((r) => setTimeout(r, 50));
  const switched = c.applyProfile({ enabled: true, writable: true, allowWrite: [".", "/other"] }).then(() => calls.push("switched"));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(calls, [], "no reset while the command runs");
  assert.match(notes.join("\n"), /waiting for 1 running sandboxed command/);
  await run;
  await switched;
  assert.deepEqual(calls, ["cleanup", "reset", "initialize", "switched"]);
  release();
  await hold;
});
