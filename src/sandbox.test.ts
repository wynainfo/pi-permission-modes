/**
 * Command transport tests for sandbox.ts: the launcher must carry a command
 * through the runtime's shell quoting byte-for-byte. The runtime itself needs
 * bubblewrap/sandbox-exec, so this exercises the two things we control - the
 * launcher string and the file it points at - through a real bash, including
 * the nested shell-quote passes the runtime applies (shell-quote is the
 * runtime's own dependency, resolved from its node_modules).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { commandLauncher, createSandboxedBashOps, EMPTY_ALLOWLIST_SENTINEL, networkFiltered, withDeniedReads, writeCommandFile } from "./sandbox.ts";

const quote: ((xs: string[]) => string) | undefined = (() => {
  try {
    return (createRequire(import.meta.url)("shell-quote") as { quote: (xs: string[]) => string }).quote;
  } catch {
    return undefined;
  }
})();
const skipQuote = quote ? false : "shell-quote (sandbox-runtime dependency) not installed";

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

test("through the runtime's nested shell-quote passes: raw command is mangled, launcher is not", { skip: skipQuote }, () => {
  const q = quote!;
  const dir = mkdtempSync(path.join(tmpdir(), "perm-quote-"));
  try {
    // Control: the historic path. `!` arrives as `\!` (SyntaxWarning/garbage), proving the bug.
    const simple = "python3 -c 'print(\"a!b\")' 2>/dev/null || printf '%s\\n' 'a!b'";
    const rawOut = (() => {
      try {
        return runBash(throughRuntimeQuoting(q, simple));
      } catch (e) {
        return (e as { stdout: string }).stdout;
      }
    })();
    assert.notEqual(rawOut, "a!b\n", "control: the raw command must be corrupted by the quoting (else the bug is gone upstream)");
    assert.match(rawOut, /\\!/);

    // The launcher survives the same passes byte-for-byte.
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

test("networkFiltered / sentinel: an absent allowlist is unrestricted, an empty one is filtered", () => {
  assert.equal(networkFiltered({ enabled: true, writable: true }), false);
  assert.equal(networkFiltered({ enabled: true, writable: true, network: {} }), false);
  assert.equal(networkFiltered({ enabled: true, writable: true, network: { allowedDomains: [] } }), true);
  assert.equal(networkFiltered({ enabled: false, writable: true, network: { allowedDomains: ["a"] } }), false);
  assert.match(EMPTY_ALLOWLIST_SENTINEL, /\.invalid$/); // RFC 2606: never resolvable
});

test("exec: an aborted signal never spawns; an abort during the wrap kills before the command completes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "perm-abort-"));
  const marker = path.join(dir, "marker");
  // Fake runtime: the wrap takes 200 ms and returns the command unchanged.
  const fakeManager = {
    wrapWithSandbox: (cmd: string) => new Promise<string>((r) => setTimeout(() => r(cmd), 200)),
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withDeniedReads: appends session blocks to denyRead of a sandboxed profile only", () => {
  const p = { enabled: true, writable: true, denyRead: ["~/.ssh"] };
  assert.deepEqual(withDeniedReads(p, ["/home/u/secret.txt", "~/.ssh"]).denyRead, ["~/.ssh", "/home/u/secret.txt"]);
  assert.equal(withDeniedReads(p, []), p);
  const yolo = { enabled: false, writable: true };
  assert.equal(withDeniedReads(yolo, ["/x"]), yolo);
});
