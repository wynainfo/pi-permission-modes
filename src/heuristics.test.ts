import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { bashConfirmReason, PRIVILEGE_RE } from "./heuristics.ts";

const ROOT = "/home/proj";

test("privilege escalation is flagged", () => {
  for (const cmd of ["sudo rm -rf /", "su -", "doas whoami", "pkexec id", "chroot /mnt"]) {
    assert.equal(bashConfirmReason(cmd, ROOT), "privilege escalation", cmd);
  }
  assert.ok(PRIVILEGE_RE.test("runuser -u root foo"));
});

test("out-of-project path tokens are flagged", () => {
  assert.match(bashConfirmReason("cat /etc/passwd", ROOT) ?? "", /path outside project/);
  assert.match(bashConfirmReason("ls ../sibling", ROOT) ?? "", /path outside project/);
  assert.match(bashConfirmReason(`cat ${os.homedir()}/.bashrc`, ROOT) ?? "", /path outside project/);
});

test("in-project commands are allowed", () => {
  assert.equal(bashConfirmReason("ls -la", ROOT), undefined);
  assert.equal(bashConfirmReason("cat src/index.ts", ROOT), undefined);
  assert.equal(bashConfirmReason("npm test", ROOT), undefined);
});

test("device pseudo-files are allowed (safe outside)", () => {
  assert.equal(bashConfirmReason("echo hi > /dev/null", ROOT), undefined);
  assert.equal(bashConfirmReason("cat /dev/urandom | head", ROOT), undefined);
});

// Locks the documented heuristic gaps: these SHOULD be caught by a real parser
// but are not (the OS sandbox is the real enforcement). If a future change makes
// the heuristic smarter, update these expectations deliberately.
test("known gaps: heuristic does not parse the shell", () => {
  // Path built via variable — not detected.
  assert.equal(bashConfirmReason("X=/etc/passwd; cat $X", ROOT), undefined);
  // Privilege escalation hidden in command substitution token boundary.
  assert.equal(bashConfirmReason("echo $(printf 's'; printf 'udo') ls", ROOT), undefined);
});
