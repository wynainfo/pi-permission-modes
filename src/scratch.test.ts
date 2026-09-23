import assert from "node:assert/strict";
import { existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SCRATCH_BASE_ENV,
  SCRATCH_MAX_AGE_MS,
  ensureScratchDir,
  scratchBase,
  scratchBaseOverridden,
  scratchDirName,
  sweepScratchDirs,
  withScratchDir,
} from "./scratch.ts";

test("scratchBase: /tmp/pi on Linux and macOS, os.tmpdir()/pi elsewhere, env override wins", () => {
  assert.equal(scratchBase("linux", {}), "/tmp/pi");
  assert.equal(scratchBase("darwin", {}), "/tmp/pi");
  assert.equal(scratchBase("win32", {}), path.join(os.tmpdir(), "pi"));
  assert.equal(scratchBase("linux", { [SCRATCH_BASE_ENV]: "/var/scratch/" }), path.resolve("/var/scratch/"));
  assert.equal(scratchBase("win32", { [SCRATCH_BASE_ENV]: "  " }), path.join(os.tmpdir(), "pi")); // blank = unset
});

test("scratchDirName: session id reduced to a safe folder name, fallback when absent", () => {
  assert.equal(scratchDirName("2026-09-22T10-11-12_abc-123"), "2026-09-22T10-11-12_abc-123");
  assert.equal(scratchDirName("../evil/../id"), "evil_.._id"); // separators squashed, leading dots dropped
  assert.equal(scratchDirName("...", () => "fb"), "fb"); // nothing safe left → fallback
  assert.match(scratchDirName("..."), /^\d+-[a-z0-9]+$/); // default fallback: pid-time
  assert.equal(scratchDirName(undefined, () => "fb"), "fb");
  assert.equal(scratchDirName("", () => "fb"), "fb");
});

test("ensureScratchDir: creates base + private session folder, touches it, never throws", () => {
  const root = mkdtempSync(path.join(tmpdir(), "perm-scratch-"));
  try {
    const dir = path.join(root, "pi", "sess-1");
    assert.equal(ensureScratchDir(dir, { sharedBase: true }), true);
    assert.ok(existsSync(dir));
    if (process.platform !== "win32") {
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.equal(statSync(path.join(root, "pi")).mode & 0o7777, 0o1777); // sticky, like /tmp
    }
    // Idempotent, and refreshes the mtime (a resumed session isn't swept).
    utimesSync(dir, new Date(0), new Date(0));
    assert.equal(ensureScratchDir(dir), true);
    assert.ok(Date.now() - statSync(dir).mtimeMs < 60_000);
    // A pre-existing user-overridden base is left alone (no chmod).
    const custom = path.join(root, "custom");
    mkdirSync(custom, { mode: 0o755 });
    assert.equal(ensureScratchDir(path.join(custom, "s"), { sharedBase: false }), true);
    if (process.platform !== "win32") assert.equal(statSync(custom).mode & 0o7777, 0o755);
    // Unwritable location → false, no throw.
    writeFileSync(path.join(root, "file"), "");
    assert.equal(ensureScratchDir(path.join(root, "file", "x")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sweepScratchDirs: removes stale sibling folders only", () => {
  const base = mkdtempSync(path.join(tmpdir(), "perm-sweep-"));
  try {
    const now = Date.now();
    const old = new Date(now - SCRATCH_MAX_AGE_MS - 1000);
    const mk = (name: string, when?: Date) => {
      const p = path.join(base, name);
      mkdirSync(p);
      writeFileSync(path.join(p, "f"), "x");
      if (when) utimesSync(p, when, when);
      return p;
    };
    const current = mk("current", old); // stale by mtime, but it's ours → kept
    mk("stale", old);
    mk("fresh");
    writeFileSync(path.join(base, "stale-file"), ""); // a file is not a session folder
    utimesSync(path.join(base, "stale-file"), old, old);
    mkdirSync(path.join(base, "target"));
    symlinkSync(path.join(base, "target"), path.join(base, "stale-link"));
    lutimesSync(path.join(base, "stale-link"), old, old); // stale link: skipped via lstat, target untouched

    assert.deepEqual(sweepScratchDirs(base, current, { now }), ["stale"]);
    assert.ok(existsSync(current));
    assert.ok(existsSync(path.join(base, "fresh")));
    assert.ok(existsSync(path.join(base, "stale-file")));
    assert.ok(lstatSync(path.join(base, "stale-link")).isSymbolicLink());
    assert.ok(existsSync(path.join(base, "target")));
    assert.ok(!existsSync(path.join(base, "stale")));
    // Missing base: nothing to do, no throw.
    assert.deepEqual(sweepScratchDirs(path.join(base, "nope"), current), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("withScratchDir: appends the folder to a sandboxed profile's allowWrite only", () => {
  const p = { enabled: true, writable: true, allowWrite: [".", "/tmp/pi"] };
  assert.deepEqual(withScratchDir(p, "/tmp/pi/s1").allowWrite, [".", "/tmp/pi", "/tmp/pi/s1"]);
  assert.equal(withScratchDir(p, undefined), p);
  assert.deepEqual(withScratchDir({ enabled: true, writable: true }, "/tmp/pi/s1").allowWrite, ["/tmp/pi/s1"]);
  const yolo = { enabled: false, writable: true };
  assert.equal(withScratchDir(yolo, "/tmp/pi/s1"), yolo); // unsandboxed: allowWrite is meaningless
  const already = { enabled: true, writable: true, allowWrite: ["/tmp/pi/s1"] };
  assert.equal(withScratchDir(already, "/tmp/pi/s1"), already);
});

test("ensureScratchDir: refuses a planted symlink in place of the session dir or the base", () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(path.join(tmpdir(), "perm-scratch-link-"));
  try {
    const base = path.join(root, "pi");
    const victim = path.join(root, "victim");
    mkdirSync(base, { mode: 0o1777 });
    mkdirSync(victim, { mode: 0o755 });
    // Session dir replaced by a link to the victim: must be refused, victim untouched.
    symlinkSync(victim, path.join(base, "sess-a"));
    assert.equal(ensureScratchDir(path.join(base, "sess-a"), { sharedBase: true }), false);
    assert.equal(statSync(victim).mode & 0o777, 0o755);
    // Base itself replaced by a link: refused too.
    const base2 = path.join(root, "pi2");
    symlinkSync(victim, base2);
    assert.equal(ensureScratchDir(path.join(base2, "sess-b"), { sharedBase: true }), false);
    // A real directory still works.
    assert.equal(ensureScratchDir(path.join(base, "sess-c"), { sharedBase: true }), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scratchBaseOverridden: blank counts as unset (consistent with scratchBase)", () => {
  assert.equal(scratchBaseOverridden({}), false);
  assert.equal(scratchBaseOverridden({ [SCRATCH_BASE_ENV]: "  " }), false);
  assert.equal(scratchBaseOverridden({ [SCRATCH_BASE_ENV]: "/x" }), true);
});
