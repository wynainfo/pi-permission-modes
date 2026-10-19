import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { describeShell, filterLines, formatDuration, type LaunchedShell, readLog, type ShellLauncher, ShellManager, type ShellRecord, tailLines } from "./shells.ts";

const skip = process.platform === "win32" ? "bash process tests run on POSIX" : false;

/** A plain launcher: bash in its own process group, output to the log fd (what the unsandboxed path does). */
const plain: ShellLauncher = async ({ command, cwd, logFd }) => {
  const child = spawn("bash", ["-c", command], { cwd, detached: true, stdio: ["ignore", logFd, logFd] });
  child.unref();
  return { child, sandboxed: false } satisfies LaunchedShell;
};

function harness(opts: { maxConcurrent?: number } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), "perm-shells-"));
  const notices: Array<{ shell: ShellRecord; last: string }> = [];
  const manager = new ShellManager({
    baseDir: path.join(base, "shells"),
    cwd: base,
    maxConcurrent: opts.maxConcurrent ?? 4,
    platform: "linux",
    notify: (shell, last) => notices.push({ shell, last }),
  });
  return { base, manager, notices, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const alive = (pid: number | undefined): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
};

test("units: durations, status lines, tails, filters", () => {
  assert.equal(formatDuration(4000), "4s");
  assert.equal(formatDuration(192_000), "3m12s");
  assert.equal(formatDuration(2 * 3600_000 + 3 * 60_000), "2h03m");
  const base: ShellRecord = { id: "a1b2c3", command: "x", startedAt: 0, status: "running", dir: "/d", logFile: "/d/o", sandboxed: true };
  assert.equal(describeShell(base, 12_000), "running for 12s");
  assert.equal(describeShell({ ...base, status: "exited", exitCode: 0, endedAt: 192_000 }), "exited 0 after 3m12s");
  assert.equal(describeShell({ ...base, status: "killed", reason: "kill_shell, SIGTERM", endedAt: 40_000 }), "killed (kill_shell, SIGTERM) after 40s");
  assert.equal(describeShell({ ...base, status: "failed", reason: "no bash" }), "failed to start (no bash)");
  assert.equal(tailLines("a\nb\nc\n", 2), "b\nc");
  assert.equal(tailLines("a\nb\nc", 5), "a\nb\nc");
  assert.deepEqual(filterLines("a1\nb2\na3", "^a"), { text: "a1\na3" });
  assert.ok("error" in filterLines("x", "("));
});

test("readLog: incremental offsets, the cap keeps the end and counts skipped lines", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "perm-log-"));
  try {
    const file = path.join(dir, "o.log");
    writeFileSync(file, "a\nb\n");
    const first = readLog(file, 0);
    assert.deepEqual([first.text, first.offset, first.newBytes, first.skippedLines], ["a\nb\n", 4, 4, 0]);
    writeFileSync(file, "c\n", { flag: "a" });
    const second = readLog(file, first.offset);
    assert.deepEqual([second.text, second.offset], ["c\n", 6]);
    assert.equal(readLog(file, 6).newBytes, 0);
    writeFileSync(file, Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n") + "\n");
    const capped = readLog(file, 0, 40);
    assert.ok(capped.text.endsWith("line49\n"));
    assert.ok(!capped.text.includes("line0\n"));
    assert.ok(capped.skippedLines > 0);
    assert.ok(/^line\d+\n/.test(capped.text), "cut at a line boundary");
    assert.equal(readLog(path.join(dir, "missing"), 0).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("start: an instant exit is reported inline with its code and output; a running shell returns within the grace", { skip }, async () => {
  const h = harness();
  try {
    const t0 = Date.now();
    const quick = await h.manager.start("echo hi; exit 3", plain);
    assert.equal(quick.status, "exited");
    assert.equal(quick.exitCode, 3);
    assert.equal(readFileSync(quick.logFile, "utf8"), "hi\n");
    await until(() => h.notices.length === 1);
    assert.equal(h.notices[0].shell.id, quick.id);
    assert.equal(h.notices[0].last, "hi");
    const long = await h.manager.start("sleep 30", plain);
    assert.ok(Date.now() - t0 < 3000, "start does not wait for a long shell");
    assert.equal(long.status, "running");
    assert.ok(alive(long.pid));
    assert.ok(existsSync(path.join(long.dir, "meta.json")));
    assert.deepEqual(
      h.manager.list().map((r) => r.id),
      [long.id, quick.id],
      "running first",
    );
    const res = await h.manager.stop(long.id, { signal: "INT" });
    assert.match(res, /killed \(kill_shell, SIGINT\)/);
    assert.equal(h.manager.get(long.id)?.status, "killed");
    await until(() => !alive(long.pid));
    assert.equal(h.notices.length, 1, "a stop the caller ordered sends no notice");
  } finally {
    h.cleanup();
  }
});

test("read: output since the last read, waitForChange, from_byte and filter", { skip }, async () => {
  const h = harness();
  try {
    const r = await h.manager.start("printf 'a\\nb\\n'; sleep 1; printf 'c\\n'; sleep 5", plain);
    await until(() => readFileSync(r.logFile, "utf8").length >= 4);
    const first = h.manager.read(r.id, { firstLines: 200 })!;
    assert.equal(first.text, "a\nb\n");
    const again = h.manager.read(r.id)!;
    assert.equal(again.newBytes, 0, "nothing new yet");
    await h.manager.waitForChange(r.id, again.offset, 5);
    const third = h.manager.read(r.id)!;
    assert.equal(third.text, "c\n");
    const filtered = h.manager.read(r.id, { fromByte: 0, filter: "^[ac]$" })!;
    assert.equal(filtered.text, "a\nc");
    assert.equal(h.manager.read(r.id, { fromByte: 0, filter: "(" })!.text.slice(0, 15), "[invalid filter");
    await h.manager.stop(r.id, { signal: "KILL" });
  } finally {
    h.cleanup();
  }
});

test("limits: maxConcurrent refuses with the running ids; a timeout kills with a notice", { skip }, async () => {
  const h = harness({ maxConcurrent: 1 });
  try {
    const a = await h.manager.start("sleep 30", plain, { timeoutSeconds: 1 });
    assert.match(h.manager.refusal() ?? "", new RegExp(`1 background shell\\(s\\) already run \\(${a.id}\\)`));
    await until(() => h.manager.get(a.id)?.status !== "running", 4000);
    assert.equal(h.manager.get(a.id)?.status, "killed");
    assert.equal(h.manager.get(a.id)?.reason, "timeout 1s");
    assert.equal(h.notices.length, 1, "a timeout is the shell ending by itself: the model is told");
    assert.equal(h.manager.refusal(), undefined);
  } finally {
    h.cleanup();
  }
});

test("stop: a program that ignores the signal is killed after the grace; stopAll ends every shell silently", { skip }, async () => {
  const h = harness();
  try {
    const stubborn = await h.manager.start("trap '' TERM; sleep 30 & wait", plain);
    const res = await h.manager.stop(stubborn.id, { signal: "TERM", graceSeconds: 3 });
    assert.match(res, /still running \(SIGKILL follows after 3s\)/);
    await until(() => h.manager.get(stubborn.id)?.status !== "running", 6000);
    assert.match(h.manager.get(stubborn.id)?.reason ?? "", /then SIGKILL after 3s/);
    const x = await h.manager.start("sleep 30", plain);
    const y = await h.manager.start("sleep 30", plain);
    const stopped = await h.manager.stopAll("session ended", 2);
    assert.deepEqual(stopped.map((r) => r.id).sort(), [x.id, y.id].sort());
    for (const r of [x, y]) {
      assert.equal(h.manager.get(r.id)?.status, "killed");
      assert.equal(h.manager.get(r.id)?.reason, "session ended");
      await until(() => !alive(r.pid));
    }
    assert.equal(h.notices.length, 0);
    assert.equal(h.manager.clean(), 3);
    assert.equal(h.manager.list().length, 0);
  } finally {
    h.cleanup();
  }
});

test("resume: records of an earlier process are listed, a stale running one as killed (session ended), never re-attached", () => {
  const base = mkdtempSync(path.join(tmpdir(), "perm-shells-"));
  try {
    const dir = path.join(base, "shells", "0ld001");
    mkdirSync(dir, { recursive: true });
    const stale: ShellRecord = { id: "0ld001", command: "npm run dev", pid: 999999, startedAt: 1, status: "running", dir, logFile: path.join(dir, "output.log"), sandboxed: true };
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify(stale));
    mkdirSync(path.join(base, "shells", "junk"));
    const m = new ShellManager({ baseDir: path.join(base, "shells"), cwd: base, maxConcurrent: 4, platform: "linux" });
    const r = m.get("0ld001")!;
    assert.equal(r.status, "killed");
    assert.equal(r.reason, "session ended");
    assert.equal(m.running().length, 0);
    assert.equal(m.list().length, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
