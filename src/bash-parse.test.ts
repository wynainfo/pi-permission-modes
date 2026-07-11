import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeBash,
  extractCommands,
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

test("analyzeBash: real grammar detects nested privilege + escape (skips if WASM absent)", async () => {
  const a = await analyzeBash("echo $(sudo rm -rf /etc) && cat ../x", "/home/u/projX");
  if (a.usedFallback) return; // tree-sitter WASM unavailable in this env — heuristic path
  assert.ok(a.commands.some((c) => c.name === "sudo" && c.isNested), "nested sudo extracted");
  assert.ok(a.outsideReason, "an escape/privilege reason is reported");
});
