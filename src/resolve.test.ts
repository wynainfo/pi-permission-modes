import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { decide, decideBashCommand, expandHome, matchPattern, mostRestrictive, resolveSurface } from "./resolve.ts";
import type { ModeDef } from "./schema.ts";

test("matchPattern: * spans path separators, ? is one char", () => {
  assert.ok(matchPattern("*.md", "foo.md"));
  assert.ok(matchPattern("*.md", "src/deep/foo.md")); // * crosses /
  assert.ok(!matchPattern("*.md", "foo.ts"));
  assert.ok(matchPattern("*", "anything/at/all"));
  assert.ok(matchPattern("file?.txt", "file1.txt"));
  assert.ok(!matchPattern("file?.txt", "file12.txt"));
});

test("matchPattern: regex metacharacters in the pattern are literal", () => {
  assert.ok(matchPattern("a.b+c", "a.b+c"));
  assert.ok(!matchPattern("a.b+c", "aXbbbc")); // '.' and '+' must be literal
});

test("matchPattern: ~ and $HOME expand on both sides", () => {
  const home = os.homedir();
  assert.ok(matchPattern("~/.ssh/*", `${home}/.ssh/id_rsa`));
  assert.ok(matchPattern("$HOME/.aws", `${home}/.aws`));
  assert.equal(expandHome("~"), home);
  assert.equal(expandHome("$HOME/x"), `${home}/x`);
  assert.equal(expandHome("/abs/path"), "/abs/path");
});

test("resolveSurface: string shorthand, and last-match-wins in a pattern-map", () => {
  assert.equal(resolveSurface("deny", "anything"), "deny");
  assert.equal(resolveSurface(undefined, "anything"), undefined);
  // "*" first sets the default; the later specific pattern overrides it.
  const map = { "*": "allow", "*.env": "deny" } as const;
  assert.equal(resolveSurface(map, "foo.txt"), "allow");
  assert.equal(resolveSurface(map, "foo.env"), "deny");
  // Order matters: a trailing "*" would clobber the specific rule.
  const bad = { "*.env": "deny", "*": "allow" } as const;
  assert.equal(resolveSurface(bad, "foo.env"), "allow");
});

test("mostRestrictive: deny > ask > allow, undefined ignored", () => {
  assert.equal(mostRestrictive("allow", "ask", "deny"), "deny");
  assert.equal(mostRestrictive("allow", "ask"), "ask");
  assert.equal(mostRestrictive("allow", undefined), "allow");
  assert.equal(mostRestrictive(undefined, undefined), undefined);
});

const mode = (permission: ModeDef["permission"]): ModeDef => ({
  label: "T",
  color: "muted",
  sandbox: { enabled: true, writable: true },
  permission,
});

test("decide: path gate overrides a per-tool allow (most-restrictive)", () => {
  const m = mode({ path: { "*": "allow", "*.env": "deny" }, write: "allow" });
  assert.equal(decide(m, "write", "src/app.ts"), "allow");
  assert.equal(decide(m, "write", "config/.env"), "deny"); // path:deny wins over write:allow
});

test("decide: external_directory folds in only when target is outside", () => {
  const m = mode({ path: { "*": "allow" }, read: "allow", external_directory: "ask" });
  assert.equal(decide(m, "read", "src/app.ts", { isOutside: false }), "allow");
  assert.equal(decide(m, "read", "/etc/passwd", { isOutside: true }), "ask"); // external_directory:ask folds in
});

test("decide: non-file surfaces skip the path gate", () => {
  const m = mode({ path: { "*": "deny" }, web_search: "allow", tool: "allow", skill: "ask" });
  assert.equal(decide(m, "web_search", "query"), "allow"); // path gate does NOT apply
  assert.equal(decide(m, "tool", "some_tool"), "allow");
  assert.equal(decide(m, "skill", "deep-research"), "ask");
});

test("decide: fallback applies when nothing matches", () => {
  const m = mode({ read: "allow" });
  assert.equal(decide(m, "write", "x.ts"), "ask"); // default least-privilege fallback
  assert.equal(decide(m, "write", "x.ts", { fallback: "allow" }), "allow");
});

test("decideBashCommand: path gate binds bash args, not just the joined string", () => {
  const m = mode({ path: { "*": "allow", "*.env": "deny" }, bash: { "*": "allow" } });
  assert.equal(decideBashCommand(m, "cat", [".env"]), "deny");
  // The heuristic fallback only matched the whole command line, so a trailing
  // arg used to hide the target; per-token matching closes that.
  assert.equal(decideBashCommand(m, "cat", [".env", "other.txt"]), "deny");
  assert.equal(decideBashCommand(m, "cat", ["config/prod.env"]), "deny");
  assert.equal(decideBashCommand(m, "ls", ["src"]), "allow");
});

test("decideBashCommand: bash surface matches the joined name+args string", () => {
  const m = mode({ bash: { "*": "allow", "git push*": "ask", "sudo*": "deny" } });
  assert.equal(decideBashCommand(m, "git", ["push", "origin", "main"]), "ask");
  assert.equal(decideBashCommand(m, "git", ["status"]), "allow");
  assert.equal(decideBashCommand(m, "sudo", ["rm", "-rf", "/"]), "deny");
});

test("decideBashCommand: project overlay path rules tighten bash (most-restrictive)", () => {
  const m = mode({ path: { "*": "allow" }, bash: { "*": "allow" } });
  m.projectOverlay = { path: { "*secrets*": "deny" } };
  assert.equal(decideBashCommand(m, "cat", ["config/secrets/key.pem"]), "deny");
  assert.equal(decideBashCommand(m, "cat", ["README.md"]), "allow");
});

test("decideBashCommand: undefined when no layer matches (caller picks default)", () => {
  const m = mode({});
  assert.equal(decideBashCommand(m, "ls", []), undefined);
});
