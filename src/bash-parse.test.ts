import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  analyzeBash,
  type BashCommand,
  escapeTargetFromReason,
  escapingPaths,
  expandShellCommands,
  extractCommands,
  isPrivilegeEscalation,
  outsideReasonFromCommands,
  policyAliases,
  type SyntaxNodeLike,
  unwrapCommand,
} from "./bash-parse.ts";

// --- fake CST builders (mirror the tree-sitter-bash grammar shape) ----------
const node = (type: string, text: string, children: SyntaxNodeLike[] = []): SyntaxNodeLike => ({ type, text, children });
const word = (t: string) => node("word", t);
const cmdName = (t: string) => node("command_name", t, [word(t)]);
const cmd = (name: string, ...args: string[]) =>
  node("command", [name, ...args].join(" "), [cmdName(name), ...args.map(word)]);
const program = (...kids: SyntaxNodeLike[]) => node("program", "", kids);

test("extractCommands: simple command name + args, not nested", () => {
  const cmds = extractCommands(program(cmd("git", "push", "origin")));
  assert.deepEqual(cmds, [{ name: "git", args: ["push", "origin"], isNested: false }]);
});

test("extractCommands: command nested in $(...) is marked nested", () => {
  // echo $(sudo rm -rf /etc)
  const echo = node("command", "echo $(...)", [
    cmdName("echo"),
    node("command_substitution", "$(...)", [cmd("sudo", "rm", "-rf", "/etc")]),
  ]);
  const cmds = extractCommands(program(echo));
  assert.equal(cmds.length, 2);
  assert.deepEqual(cmds[0], { name: "echo", args: [], isNested: false });
  assert.deepEqual(cmds[1], { name: "sudo", args: ["rm", "-rf", "/etc"], isNested: true });
});

test("extractCommands: commands in a subshell are nested", () => {
  const sub = node("subshell", "(...)", [cmd("cd", "/tmp"), cmd("ls")]);
  const cmds = extractCommands(program(sub));
  assert.deepEqual(
    cmds.map((c) => [c.name, c.isNested]),
    [
      ["cd", true],
      ["ls", true],
    ],
  );
});

test("extractCommands: quotes are stripped from args", () => {
  const c = node("command", "echo 'hi'", [cmdName("echo"), node("string", "'hi'")]);
  assert.deepEqual(extractCommands(program(c))[0].args, ["hi"]);
});

test("outsideReasonFromCommands: privilege escalation by command name", () => {
  assert.equal(outsideReasonFromCommands([{ name: "sudo", args: ["apt"], isNested: false }], "/p"), "privilege escalation");
  // even nested (the extractor already flattened it)
  assert.equal(outsideReasonFromCommands([{ name: "doas", args: [], isNested: true }], "/p"), "privilege escalation");
});

test("outsideReasonFromCommands: out-of-project path argument", () => {
  const root = "/home/u/proj";
  assert.match(
    outsideReasonFromCommands([{ name: "cat", args: ["../secret.txt"], isNested: false }], root) ?? "",
    /path outside project: \.\.\/secret\.txt/,
  );
  assert.equal(outsideReasonFromCommands([{ name: "cat", args: ["src/app.ts"], isNested: false }], root), undefined);
});

test("outsideReasonFromCommands: sandbox-writable roots are in-bounds, not escapes", () => {
  const root = "/home/u/proj";
  const c = (...a: string[]): BashCommand => ({ name: a[0], args: a.slice(1), isNested: false });
  assert.match(outsideReasonFromCommands([c("mktemp", "-d", "/tmp/pi.XXXX")], root) ?? "", /path outside project/);
  assert.equal(outsideReasonFromCommands([c("mktemp", "-d", "/tmp/pi.XXXX")], root, ["/tmp"]), undefined);
  assert.equal(outsideReasonFromCommands([c("cat", "/tmp/claude/out.txt")], root, ["/tmp/claude"]), undefined);
  // Only the listed roots: a different absolute path still prompts.
  assert.match(outsideReasonFromCommands([c("cat", "/etc/passwd")], root, ["/tmp"]) ?? "", /path outside project/);
  // Privilege escalation is unaffected by bounds.
  assert.equal(outsideReasonFromCommands([c("sudo", "ls", "/tmp")], root, ["/tmp"]), "privilege escalation");
});

test("outsideReasonFromCommands: a venv interpreter symlinked outside the project does not prompt", () => {
  const base = mkdtempSync(path.join(tmpdir(), "perm-venv-ast-"));
  try {
    const root = path.join(base, "proj");
    mkdirSync(path.join(root, ".venv", "bin"), { recursive: true });
    const exe = path.join(base, "python3.12");
    writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync(exe, path.join(root, ".venv", "bin", "python"));
    symlinkSync(path.join(base, "not-a-program"), path.join(root, "dangling"));
    const c = (...a: string[]): BashCommand => ({ name: a[0], args: a.slice(1), isNested: false });
    assert.equal(outsideReasonFromCommands([c(".venv/bin/python", "-m", "pytest")], root), undefined);
    assert.equal(outsideReasonFromCommands([c("cd", root), c(".venv/bin/python", "-u", "-")], root), undefined);
    // A bare name that is a symlink out of the project is an escape too (dangling or not).
    assert.match(outsideReasonFromCommands([c("cat", "dangling")], root) ?? "", /path outside project: dangling/);
    assert.match(outsideReasonFromCommands([c("cat", "./dangling")], root) ?? "", /path outside project: \.\/dangling/);
    assert.match(outsideReasonFromCommands([c(exe, "-V")], root) ?? "", /path outside project/); // named directly: still outside
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("outsideReasonFromCommands: /dev/null is allowed", () => {
  assert.equal(outsideReasonFromCommands([{ name: "echo", args: [], isNested: false }], "/p"), undefined);
  assert.equal(
    outsideReasonFromCommands([{ name: "cat", args: ["/dev/null"], isNested: false }], "/home/u/proj"),
    undefined,
  );
});

const bc = (name: string, ...args: string[]): BashCommand => ({ name, args, isNested: false });

test("isPrivilegeEscalation: direct and through wrapper commands", () => {
  assert.ok(isPrivilegeEscalation(bc("sudo", "apt", "install")));
  assert.ok(isPrivilegeEscalation(bc("/usr/bin/sudo", "x")));
  assert.ok(isPrivilegeEscalation(bc("env", "sudo", "rm")));
  assert.ok(isPrivilegeEscalation(bc("env", "PATH=/x", "sudo", "rm"))); // skips assignments
  assert.ok(isPrivilegeEscalation(bc("nice", "-n", "10", "sudo", "x"))); // skips flags + numbers
  assert.ok(isPrivilegeEscalation(bc("timeout", "5", "doas", "x")));
  assert.ok(isPrivilegeEscalation(bc("xargs", "-0", "sudo", "rm")));
  assert.ok(isPrivilegeEscalation(bc("nohup", "env", "sudo", "x"))); // wrappers chain
});

test("isPrivilegeEscalation: no false positives on mere mentions", () => {
  assert.ok(!isPrivilegeEscalation(bc("grep", "sudo", "file.txt"))); // grep is not a wrapper
  assert.ok(!isPrivilegeEscalation(bc("man", "sudo")));
  assert.ok(!isPrivilegeEscalation(bc("echo", "use sudo for that")));
  assert.ok(!isPrivilegeEscalation(bc("env", "ls", "-la"))); // wrapped command is benign
  assert.ok(!isPrivilegeEscalation(bc("env"))); // wrapper with nothing wrapped
});

test("expandShellCommands: bash -c scripts are re-parsed, recursively and depth-limited", () => {
  const parses: string[] = [];
  const parse = (s: string): BashCommand[] => {
    parses.push(s);
    if (s === "sudo rm -rf /") return [bc("sudo", "rm", "-rf", "/")];
    if (s === "bash -c 'sudo x'") return [bc("bash", "-c", "sudo x")];
    if (s === "sudo x") return [bc("sudo", "x")];
    return [];
  };

  // Simple: the inner command joins the list, marked nested.
  const simple = expandShellCommands(parse, [bc("bash", "-c", "sudo rm -rf /")]);
  assert.deepEqual(
    simple.map((c) => [c.name, c.isNested]),
    [
      ["bash", false],
      ["sudo", true],
    ],
  );

  // Combined flags (`sh -lc`) and absolute shell paths count too.
  assert.equal(expandShellCommands(parse, [bc("sh", "-lc", "sudo rm -rf /")]).length, 2);
  assert.equal(expandShellCommands(parse, [bc("/bin/bash", "-c", "sudo rm -rf /")]).length, 2);

  // No -c → a script file we can't inspect; nothing is expanded.
  assert.equal(expandShellCommands(parse, [bc("bash", "script.sh")]).length, 1);
  // Non-shell commands are never expanded.
  assert.equal(expandShellCommands(parse, [bc("git", "-c", "user.name=x", "log")]).length, 1);

  // Nested shells expand recursively: bash -c "bash -c 'sudo x'".
  const nested = expandShellCommands(parse, [bc("bash", "-c", "bash -c 'sudo x'")]);
  assert.deepEqual(
    nested.map((c) => c.name),
    ["bash", "bash", "sudo"],
  );

  // Depth limit: self-referential scripts stop expanding instead of looping.
  const loop = (s: string): BashCommand[] => (s === "loop" ? [bc("bash", "-c", "loop")] : []);
  const bounded = expandShellCommands(loop, [bc("bash", "-c", "loop")]);
  assert.ok(bounded.length <= 4);
});

test("outsideReasonFromCommands: wrapped privilege escalation is reported", () => {
  assert.equal(outsideReasonFromCommands([bc("env", "sudo", "rm")], "/p"), "privilege escalation");
  assert.equal(outsideReasonFromCommands([bc("grep", "sudo", "x.txt")], "/p"), undefined);
});

test("analyzeBash: real grammar detects nested privilege + escape (skips if WASM absent)", async () => {
  const a = await analyzeBash("echo $(sudo rm -rf /etc) && cat ../x", "/home/u/projX");
  if (a.usedFallback) return; // tree-sitter WASM unavailable in this env — heuristic path
  assert.ok(a.commands.some((c) => c.name === "sudo" && c.isNested), "nested sudo extracted");
  assert.ok(a.outsideReason, "an escape/privilege reason is reported");
});

test("analyzeBash: real grammar sees through wrappers and shell -c (skips if WASM absent)", async () => {
  const wrapped = await analyzeBash("env PATH=/x sudo rm -rf /", "/home/u/projX");
  if (wrapped.usedFallback) return; // tree-sitter WASM unavailable in this env
  assert.equal(wrapped.outsideReason, "privilege escalation");

  const shellC = await analyzeBash("bash -c 'sudo rm -rf /etc'", "/home/u/projX");
  assert.equal(shellC.outsideReason, "privilege escalation");
  assert.ok(shellC.commands.some((c) => c.name === "sudo" && c.isNested), "inner sudo extracted from -c script");

  // The inner script's path args are policy-visible too.
  const shellPath = await analyzeBash("sh -c 'cat /etc/passwd'", "/home/u/projX");
  assert.match(shellPath.outsideReason ?? "", /path outside project/);

  // A benign mention is not privilege escalation in the AST path.
  const benign = await analyzeBash("grep sudo README.md", "/home/u/projX");
  assert.equal(benign.outsideReason, undefined);
});

// --- redirects, heredocs, tests (fake trees mirroring tree-sitter-bash) -------

test("extractCommands: redirect targets join the command's args; $(< file) and [[ ]] become pseudo-commands", () => {
  const redirect = (op: string, target: string) => node("file_redirect", `${op} ${target}`, [node(op, op), word(target)]);
  const tree = program(
    node("redirected_statement", "", [cmd("echo", "x"), redirect(">", "/etc/evil")]),
    node("redirected_statement", "", [cmd("cat"), redirect("<", "/etc/hostname"), node("file_redirect", "2>/dev/null", [node("file_descriptor", "2"), node(">", ">"), word("/dev/null")])]),
    node("command", "", [cmdName("echo"), node("string", '"$(< /etc/passwd)"', [node("command_substitution", "$(< /etc/passwd)", [node("$(", "$("), redirect("<", "/etc/passwd"), node(")", ")")])])]),
    node("test_command", "", [node("[[", "[["), node("unary_expression", "", [node("test_operator", "-f"), word("/etc/shadow")]), node("]]", "]]")]),
  );
  const cmds = extractCommands(tree);
  assert.deepEqual(cmds.map((c) => [c.name, c.args]), [
    ["echo", ["x", "/etc/evil"]],
    ["cat", ["/etc/hostname", "/dev/null"]],
    ["echo", ["$(< /etc/passwd)"]],
    ["", ["/etc/passwd"]],
    ["[[", ["/etc/shadow"]],
  ]);
  assert.equal(cmds[3].isNested, true);
  const root = "/home/u/proj";
  assert.match(outsideReasonFromCommands([cmds[0]], root) ?? "", /\/etc\/evil/);
  assert.match(outsideReasonFromCommands([cmds[3]], root) ?? "", /\/etc\/passwd/);
  assert.match(outsideReasonFromCommands([cmds[4]], root) ?? "", /\/etc\/shadow/);
  assert.equal(outsideReasonFromCommands([{ name: "cat", args: ["x", "/dev/null"], isNested: false }], root), undefined);
});

test("extractCommands: a heredoc body attaches to its command and is expanded when the command is a shell", () => {
  const heredoc = (body: string) => node("heredoc_redirect", "", [node("<<", "<<"), node("heredoc_start", "'EOF'"), node("heredoc_body", body), node("heredoc_end", "EOF")]);
  const tree = program(node("redirected_statement", "", [cmd("bash"), heredoc("sudo id\n")]), node("redirected_statement", "", [cmd("cat"), heredoc("sudo id\n")]));
  const cmds = extractCommands(tree);
  assert.equal(cmds[0].heredoc, "sudo id\n");
  const fakeParse = (script: string): BashCommand[] => (script.includes("sudo") ? [{ name: "sudo", args: ["id"], isNested: false }] : []);
  const expanded = expandShellCommands(fakeParse, cmds);
  // bash <<EOF: expanded (sudo seen); cat <<EOF: data, not expanded.
  assert.deepEqual(expanded.map((c) => c.name), ["bash", "sudo", "cat"]);
  assert.equal(outsideReasonFromCommands(expanded, "/p"), "privilege escalation");
});

test("expandShellCommands: eval strings, `bash -o pipefail -c`, `bash -s` with heredoc", () => {
  const fakeParse = (script: string): BashCommand[] => [{ name: script.split(" ")[0], args: script.split(" ").slice(1), isNested: false }];
  const bc = (name: string, ...args: string[]): BashCommand => ({ name, args, isNested: false });
  assert.deepEqual(expandShellCommands(fakeParse, [bc("eval", "cat /etc/hostname")]).map((c) => c.name), ["eval", "cat"]);
  assert.deepEqual(expandShellCommands(fakeParse, [bc("bash", "-o", "pipefail", "-c", "sudo id")]).map((c) => c.name), ["bash", "sudo"]);
  assert.deepEqual(expandShellCommands(fakeParse, [{ ...bc("sh", "-s"), heredoc: "sudo id" }]).map((c) => c.name), ["sh", "sudo"]);
  assert.deepEqual(expandShellCommands(fakeParse, [bc("bash", "--norc", "script.sh")]).map((c) => c.name), ["bash"]); // a file: not inspectable
});

test("unwrapCommand / policyAliases: wrappers, find -exec, path heads, quote-mangled spellings", () => {
  const bc = (name: string, ...args: string[]): BashCommand => ({ name, args, isNested: false });
  assert.deepEqual(unwrapCommand(bc("find", ".", "-exec", "sudo", "id", ";")), { name: "sudo", args: ["id", ";"] });
  assert.deepEqual(unwrapCommand(bc("coproc", "sudo", "id")), { name: "sudo", args: ["id"] });
  assert.equal(isPrivilegeEscalation(bc("find", ".", "-exec", "sudo", "id", ";")), true);
  assert.equal(isPrivilegeEscalation(bc("fd", "-x", "doas", "id")), true);
  assert.ok(policyAliases(bc("/usr/bin/sudo", "id")).includes("sudo id"));
  assert.ok(policyAliases(bc("time", "sudo", "id")).includes("sudo id"));
  assert.ok(policyAliases(bc("\\git", "push")).includes("git push"));
  assert.ok(policyAliases(bc("git", 'pu""sh', "origin")).includes("git push origin"));
  assert.deepEqual(policyAliases(bc("git", "status")), []);
});

test("outsideReasonFromCommands: normalized tokens, glued flag values, bare cd, ~user", () => {
  const root = "/home/u/proj";
  const bc = (name: string, ...args: string[]): BashCommand => ({ name, args, isNested: false });
  assert.match(outsideReasonFromCommands([bc("cat", "\\/etc/hostname")], root) ?? "", /path outside project/);
  assert.match(outsideReasonFromCommands([bc("cat", "$'/etc/hostname")], root) ?? "", /path outside project/); // closing quote already stripped by the parser
  assert.match(outsideReasonFromCommands([bc("cat", "$HOME/.bashrc")], root) ?? "", /path outside project/);
  assert.match(outsideReasonFromCommands([bc("cat", '"$HOME"/.bashrc')], root) ?? "", /path outside project/);
  assert.match(outsideReasonFromCommands([bc("cat", "~root/.bashrc")], root) ?? "", /path outside project: ~root/);
  assert.match(outsideReasonFromCommands([bc("dd", "if=/etc/hostname")], root) ?? "", /path outside project/);
  assert.match(outsideReasonFromCommands([bc("git", "--git-dir=/etc/foo/.git", "log")], root) ?? "", /path outside project/);
  assert.match(outsideReasonFromCommands([bc("tar", "-C/etc", "-cf", "-", "x")], root) ?? "", /path outside project/);
  assert.match(outsideReasonFromCommands([bc("cd")], root) ?? "", /path outside project: cd/);
  assert.match(outsideReasonFromCommands([bc("cd", "-")], root) ?? "", /path outside project: cd -/);
  assert.match(outsideReasonFromCommands([bc("pushd", "-P")], root) ?? "", /path outside project/);
  assert.equal(outsideReasonFromCommands([bc("cd", "src")], root), undefined);
  assert.equal(outsideReasonFromCommands([bc("dd", "if=input.bin", "of=/dev/null")], root), undefined);
  assert.equal(outsideReasonFromCommands([bc("grep", "-e", "a/b", "file")], root), undefined);
});

test("analyzeBash: real grammar sees redirects, heredoc scripts, eval, and find -exec (skips if WASM absent)", async () => {
  const root = "/home/u/projX";
  const cases: [string, RegExp | undefined][] = [
    ["echo x > /etc/evil", /\/etc\/evil/],
    ["cat < /etc/hostname", /\/etc\/hostname/],
    ['echo "$(< /etc/hostname)"', /\/etc\/hostname/],
    ["bash <<'EOF'\nsudo id\nEOF", /privilege escalation/],
    ["cat <<'EOF'\nsudo id\nEOF", undefined], // data, not a script
    ["[[ -f /etc/shadow ]] && echo yes", /\/etc\/shadow/],
    ["eval 'cat /etc/hostname'", /\/etc\/hostname/],
    ["find . -exec sudo id \\;", /privilege escalation/],
    ["bash -o pipefail -c 'sudo id'", /privilege escalation/],
    ["cat $'/etc/hostname'", /path outside project/],
    ["cd; cat .bashrc", /path outside project: cd/],
    ["echo hi > out.txt", undefined],
  ];
  for (const [command, expected] of cases) {
    const a = await analyzeBash(command, root);
    if (a.usedFallback) return; // WASM unavailable
    if (expected) assert.match(a.outsideReason ?? "", expected, command);
    else assert.equal(a.outsideReason, undefined, command);
  }
  // Normalized path tokens ride along for the path gate.
  const esc = await analyzeBash("cat .en\\v", root);
  assert.deepEqual(esc.commands[0].pathTokens, [".env"]);
  const plain = await analyzeBash("cat .env", root);
  assert.equal(plain.commands[0].pathTokens, undefined);
});

test("escapingPaths / escapeTargetFromReason: every out-of-project path a chain reaches, resolved", () => {
  const root = "/home/u/proj";
  const bc = (name: string, ...args: string[]): BashCommand => ({ name, args, isNested: false });
  assert.deepEqual(escapingPaths([bc("cat", "/etc/hostname", "src/x"), bc("cp", "../secret", "/dev/null")], root), ["/etc/hostname", "/home/u/secret"]);
  assert.deepEqual(escapingPaths([bc("sudo", "id")], root), []); // privilege: no path
  assert.deepEqual(escapingPaths([bc("cat", "~root/x")], root), []); // unresolvable
  assert.deepEqual(escapingPaths([bc("cd")], root), []);
  assert.equal(escapeTargetFromReason("path outside project: /etc/hostname", root), "/etc/hostname");
  assert.equal(escapeTargetFromReason("path outside project: ../x", root), "/home/u/x");
  assert.equal(escapeTargetFromReason("path outside project: cd", root), undefined);
  assert.equal(escapeTargetFromReason("privilege escalation", root), undefined);
});

test("bare-word symlinks: an argument naming an in-project symlink to outside is an escape; plain names and executables are not", () => {
  const base = mkdtempSync(path.join(tmpdir(), "perm-bare-"));
  try {
    const root = path.join(base, "proj");
    mkdirSync(root);
    const secret = path.join(base, "secret.txt");
    writeFileSync(secret, "x");
    mkdirSync(path.join(base, "outdir"));
    const exe = path.join(base, "tool");
    writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync(secret, path.join(root, "data"));
    symlinkSync(path.join(base, "outdir"), path.join(root, "outlink"));
    symlinkSync(exe, path.join(root, "toollink"));
    writeFileSync(path.join(root, "a.txt"), "a");
    symlinkSync(path.join(root, "a.txt"), path.join(root, "inlink"));
    const c = (...a: string[]): BashCommand => ({ name: a[0], args: a.slice(1), isNested: false });
    assert.match(outsideReasonFromCommands([c("cat", "data")], root) ?? "", /path outside project: data/);
    assert.match(outsideReasonFromCommands([c("ls", "outlink")], root) ?? "", /path outside project: outlink/);
    assert.match(outsideReasonFromCommands([c("cp", "'data'", "x")], root) ?? "", /path outside project/); // quoted spelling
    assert.equal(outsideReasonFromCommands([c("cat", "a.txt")], root), undefined); // plain in-project file
    assert.equal(outsideReasonFromCommands([c("cat", "inlink")], root), undefined); // link staying inside
    assert.equal(outsideReasonFromCommands([c("toollink", "-V")], root), undefined); // command position: PATH lookup
    assert.equal(outsideReasonFromCommands([c("run", "toollink")], root), undefined); // link to an outside executable: the venv rule
    assert.equal(outsideReasonFromCommands([c("grep", "-data", "a.txt")], root), undefined); // flags are not names
    assert.equal(outsideReasonFromCommands([c("cat", "missing")], root), undefined);
    // The block candidates name the link; blockablePath canonicalizes it to the real target.
    assert.deepEqual(escapingPaths([c("cat", "data", "a.txt")], root), [path.join(root, "data")]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
