import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeBash,
  type BashCommand,
  expandShellCommands,
  extractCommands,
  isPrivilegeEscalation,
  outsideReasonFromCommands,
  type SyntaxNodeLike,
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
