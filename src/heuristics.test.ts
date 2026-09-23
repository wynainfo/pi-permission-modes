import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { bashConfirmReason, normalizeBashToken, pathPartOfToken, PRIVILEGE_RE } from "./heuristics.ts";

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
  // The assignment's value is a glued `name=path` token and IS judged now; the
  // later `$X` use is not (variables can't be resolved without a shell).
  assert.match(bashConfirmReason("X=/etc/passwd; cat $X", ROOT) ?? "", /path outside project: X=\/etc\/passwd/);
  assert.equal(bashConfirmReason("cat $X", ROOT), undefined);
  // Privilege escalation hidden in command substitution token boundary.
  assert.equal(bashConfirmReason("echo $(printf 's'; printf 'udo') ls", ROOT), undefined);
});


test("sandbox-writable roots are in-bounds for the heuristic too (parity with the AST path)", () => {
  assert.match(bashConfirmReason("mktemp -d /tmp/pi.XXXX", ROOT) ?? "", /path outside project/);
  assert.equal(bashConfirmReason("mktemp -d /tmp/pi.XXXX", ROOT, ["/tmp"]), undefined);
  assert.match(bashConfirmReason("cat /etc/passwd", ROOT, ["/tmp"]) ?? "", /path outside project/);
});

test("normalizeBashToken / pathPartOfToken", () => {
  const home = os.homedir();
  assert.equal(normalizeBashToken("$'/etc/x'"), "/etc/x");
  assert.equal(normalizeBashToken("$'/etc/x"), "/etc/x");
  assert.equal(normalizeBashToken("\\/etc/x"), "/etc/x");
  assert.equal(normalizeBashToken('"$HOME"/.bashrc'), `${home}/.bashrc`);
  assert.equal(normalizeBashToken("${HOME}/x"), `${home}/x`);
  assert.equal(normalizeBashToken("$HOMEX"), "$HOMEX"); // not the HOME variable
  assert.equal(normalizeBashToken("$OTHER/x"), "$OTHER/x"); // unknown variables stay
  assert.equal(pathPartOfToken("--git-dir=/etc/x"), "/etc/x");
  assert.equal(pathPartOfToken("if=/etc/x"), "/etc/x");
  assert.equal(pathPartOfToken("-C/etc"), "/etc");
  assert.equal(pathPartOfToken("-I/usr/include"), "/usr/include");
  assert.equal(pathPartOfToken("src/app.ts"), "src/app.ts");
  assert.equal(pathPartOfToken("-n"), "-n");
});

test("heuristic: escaped, ANSI-C, $HOME, ~user, glued values, bare cd are escapes", () => {
  for (const cmd of ["cat \\/etc/hostname", "cat $'/etc/hostname'", "cat $HOME/.bashrc", 'cat "$HOME"/.bashrc', "cat ~root/.bashrc", "dd if=/etc/hostname", "tar -C/etc -cf - x", "cd; cat .bashrc", "cd - && ls", "true; pushd"]) {
    assert.match(bashConfirmReason(cmd, ROOT) ?? "", /path outside project/, cmd);
  }
  assert.equal(bashConfirmReason("cd src && ls", ROOT), undefined);
  assert.equal(bashConfirmReason("echo cd", ROOT), undefined);
});
